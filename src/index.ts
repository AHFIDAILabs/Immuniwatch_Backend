import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import { Server as SocketServer } from "socket.io";

import { config } from "./config";
import { logger } from "./utils/logger";
import { globalLimiter } from "./middlewares/rateLimiter";
import { errorHandler, notFound } from "./middlewares/errorHandler";
import routes from "./routes"; // includes /settings via routes/index.ts
import { startKafkaProducer, stopKafkaProducer } from "./utils/kafkaProducer";
import { startKafkaConsumer, stopKafkaConsumer } from "./utils/kafkaConsumer";
import { checkPsiDrift, warmUpMetricsCache } from "./services/modelHealthService";
import { getCircuitState, getHealth, isMockMode } from "./services/mlClient";
import { startRecentIngestion } from "./services/recentIngestionService";

// NOTE: settingsRoutes is NOT imported here — it is already registered inside
// routes/index.ts as `router.use('/settings', settingsRoutes)`. Importing and
// mounting it a second time here would double-register the route and create
// duplicate middleware chains.

const app = express();
const httpServer = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────

export const io = new SocketServer(httpServer, {
  cors: {
    origin: config.frontendUrl,
    credentials: true,
    methods: ["GET", "POST"],
  },
  pingTimeout: 20000,
  pingInterval: 10000,
  transports: ["websocket", "polling"],
});

// Attach io to global so services can broadcast without circular imports
(global as Record<string, unknown>).io = io;

// Authenticate WS connections via the access_token cookie sent in the handshake
io.use((socket, next) => {
  try {
    const { verifyToken } = require("./utils/jwt");
    const raw = socket.request.headers.cookie ?? "";
    const cookies = Object.fromEntries(
      raw.split(";").map((c) => c.trim().split("=").map(decodeURIComponent)),
    );
    const token = cookies["access_token"];
    if (!token) return next(new Error("NO_TOKEN"));
    const payload = verifyToken(token);
    if (payload.type !== "access") return next(new Error("WRONG_TOKEN_TYPE"));
    socket.data = { userId: payload.sub, role: payload.role };
    next();
  } catch {
    next(new Error("INVALID_TOKEN"));
  }
});

io.on("connection", (socket) => {
  logger.debug("WS client connected", {
    id: socket.id,
    role: socket.data.role,
  });
  socket.on("disconnect", () =>
    logger.debug("WS client disconnected", { id: socket.id }),
  );
});

// ── Express middleware ────────────────────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: config.nodeEnv === "production",
    crossOriginEmbedderPolicy: config.nodeEnv === "production",
  }),
);

app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true,
  }),
);

app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(
  morgan("combined", { stream: { write: (msg) => logger.http(msg.trim()) } }),
);
app.use(globalLimiter);

// ── Health / readiness ────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    ml: getCircuitState(),
    mockMode: isMockMode(),
    kafka: config.kafka.enabled ? "enabled" : "disabled",
  });
});

// ── API routes ────────────────────────────────────────────────────────────────

app.use("/api/v1", routes);

// ── 404 + global error handler ────────────────────────────────────────────────

app.use(notFound);
app.use(errorHandler);

// ── Startup sequence ──────────────────────────────────────────────────────────

const MONGO_OPTS: mongoose.ConnectOptions = {
  maxPoolSize:              10,
  serverSelectionTimeoutMS: 30_000,
  connectTimeoutMS:         30_000,
  socketTimeoutMS:          75_000,
  heartbeatFrequencyMS:     10_000,
};

async function connectMongo(retries = 5, delayMs = 3_000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(config.mongodb.uri, MONGO_OPTS);
      logger.info("MongoDB connected", {
        uri: config.mongodb.uri.replace(/\/\/.*@/, "//***@"),
      });
      mongoose.connection.on("error", (err) =>
        logger.error("MongoDB runtime error", { message: err.message }),
      );
      return;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const isIpBlock = msg.includes('connection') && msg.includes('closed');

      logger.warn(`MongoDB connection attempt ${attempt}/${retries} failed`, { message: msg });

      if (isIpBlock && attempt === 1) {
        logger.error(
          'Atlas is closing the connection immediately — this usually means your ' +
          'current IP is not in the MongoDB Atlas IP Access List. ' +
          'Go to Atlas → Network Access → Add IP Address → add your current IP ' +
          '(or 0.0.0.0/0 for dev). Then restart the server.',
        );
      }

      if (attempt < retries) {
        const wait = delayMs * attempt;
        logger.info(`Retrying MongoDB connection in ${wait / 1000}s…`);
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
}

async function start(): Promise<void> {
  // 1. MongoDB — retries with backoff; Atlas free-tier may drop on first attempt
  await connectMongo();


  // 2. Kafka producer
  await startKafkaProducer();

  // 3. Kafka consumer
  await startKafkaConsumer();

  // 4. HTTP + WebSocket
  await new Promise<void>((resolve) => httpServer.listen(config.port, resolve));

  // 5. ML service warm-up — Hugging Face free-tier spaces sleep after inactivity.
  //    Fire a non-blocking health ping immediately so the space starts warming up.
  //    ML_TIMEOUT_MS=90000 in .env covers cold starts that take 60–120 s.
  setImmediate(() => {
    getHealth()
      .then((h) =>
        logger.info(
          `ML service warm-up OK — version=${h.model_version} status=${h.status} mock=${isMockMode()}`,
        ),
      )
      .catch((err) =>
        logger.warn(
          "ML service warm-up probe failed (space may be waking up)",
          {
            message: (err as Error).message,
          },
        ),
      );
  });

  // 6. Metrics cache warm-up — runs 15 s after startup to give the HF Space time to
  //    respond to the health ping above. This overwrites any seeded ModelMetrics in
  //    MongoDB with live data, so the Model Health dashboard shows real numbers on
  //    first load instead of the seed values (macroF1: 0.847, v1.4.2, etc.).
  //    Non-fatal: if the ML service is still cold the seed data is served until the
  //    next 5-minute TTL expiry triggers another fetch.
  if (!isMockMode()) {
    setTimeout(() => {
      warmUpMetricsCache().catch(() => {
        /* already logged inside warmUpMetricsCache */
      });
    }, 15_000);
  }

  // 7. Live feed ingestion — polls GET /recent every 60 s, stores new posts into MongoDB
  if (!isMockMode()) {
    startRecentIngestion();
  }

  // 9. PSI drift check — every 5 minutes; also acts as a keep-alive for the HF Space
  const psiInterval = setInterval(
    () => {
      checkPsiDrift().catch((err) =>
        logger.warn("PSI drift check failed", {
          message: (err as Error).message,
        }),
      );
    },
    5 * 60 * 1000,
  );
  psiInterval.unref(); // don't keep the process alive in tests

  logger.info(
    `ImmuniWatch backend ready — ML: ${getCircuitState()} mock=${isMockMode()} — Kafka: ${config.kafka.enabled ? "enabled" : "disabled"}`,
    { port: config.port, env: config.nodeEnv },
  );
}

start().catch((err) => {
  logger.error("Startup failed", {
    message: (err as Error).message,
    stack: (err as Error).stack,
  });
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down gracefully`);
  try {
    await stopKafkaConsumer();
    await stopKafkaProducer();
    await mongoose.disconnect();
    httpServer.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  } catch (err) {
    logger.error("Error during shutdown", { message: (err as Error).message });
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
