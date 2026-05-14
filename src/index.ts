import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { Server as SocketServer } from 'socket.io';

import { config } from './config';
import { logger } from './utils/logger';
import { globalLimiter } from './middlewares/rateLimiter';
import { errorHandler, notFound } from './middlewares/errorHandler';
import routes from './routes';
import { startKafkaProducer, stopKafkaProducer } from './utils/kafkaProducer';
import { startKafkaConsumer, stopKafkaConsumer } from './utils/kafkaConsumer';
import { checkPsiDrift } from './services/modelHealthService';
import { getCircuitState } from './services/mlClient';
import { WsEvent, UserRole } from './types';

const app        = express();
const httpServer = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────────────────────

export const io = new SocketServer(httpServer, {
  cors:           { origin: config.frontendUrl, credentials: true, methods: ['GET', 'POST'] },
  pingTimeout:    20000,
  pingInterval:   10000,
  transports:     ['websocket', 'polling'],
});

// Attach io to global so Kafka consumer can broadcast without circular import
(global as Record<string, unknown>).io = io;

// Authenticate WS connections via the access_token cookie sent in the handshake
io.use((socket, next) => {
  try {
    const { verifyToken } = require('./utils/jwt');
    const raw     = socket.request.headers.cookie ?? '';
    const cookies = Object.fromEntries(raw.split(';').map((c) => c.trim().split('=').map(decodeURIComponent)));
    const token   = cookies['access_token'];
    if (!token) return next(new Error('NO_TOKEN'));
    const payload = verifyToken(token);
    if (payload.type !== 'access') return next(new Error('WRONG_TOKEN_TYPE'));
    socket.data = { userId: payload.sub, role: payload.role };
    next();
  } catch {
    next(new Error('INVALID_TOKEN'));
  }
});

io.on('connection', (socket) => {
  logger.debug('WS client connected', { id: socket.id, role: socket.data.role });
  socket.on('disconnect', () => logger.debug('WS client disconnected', { id: socket.id }));
});

// ── Express middleware ────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy:     config.nodeEnv === 'production',
  crossOriginEmbedderPolicy: config.nodeEnv === 'production',
}));

app.use(cors({
  origin:      config.frontendUrl,
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));
app.use(globalLimiter);

// ── Health / readiness ────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    uptime:    process.uptime(),
    timestamp: new Date().toISOString(),
    ml:        getCircuitState(),
    kafka:     config.kafka.enabled ? 'enabled' : 'disabled',
  });
});

// ── API routes ────────────────────────────────────────────────────────────────

app.use('/api/v1', routes);

// ── 404 + global error handler ────────────────────────────────────────────────

app.use(notFound);
app.use(errorHandler);

// ── Startup sequence ──────────────────────────────────────────────────────────

async function start(): Promise<void> {
  // 1. MongoDB
  await mongoose.connect(config.mongodb.uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  });
  logger.info('MongoDB connected', { uri: config.mongodb.uri.replace(/\/\/.*@/, '//***@') });
  mongoose.connection.on('error', (err) =>
    logger.error('MongoDB runtime error', { message: err.message }),
  );

  // 2. Kafka producer
  await startKafkaProducer();

  // 3. Kafka consumer
  await startKafkaConsumer();

  // 4. HTTP + WebSocket
  await new Promise<void>((resolve) => httpServer.listen(config.port, resolve));

  // 5. PSI drift check — every 5 minutes (GPU-bound, do not shorten)
  const psiInterval = setInterval(() => {
    checkPsiDrift().catch((err) =>
      logger.warn('PSI drift check failed', { message: (err as Error).message }),
    );
  }, 5 * 60 * 1000);
  psiInterval.unref(); // don't keep process alive in tests

  logger.info(
    `ImmuniWatch Node.js backend ready — ML service: ${getCircuitState()} — Kafka: ${config.kafka.enabled ? 'enabled' : 'disabled'}`,
    { port: config.port, env: config.nodeEnv, mlMock: config.mlService.mockMode },
  );
}

start().catch((err) => {
  logger.error('Startup failed', { message: (err as Error).message, stack: (err as Error).stack });
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
      logger.info('HTTP server closed');
      process.exit(0);
    });
    // Force-exit after 15 s if something hangs
    setTimeout(() => process.exit(1), 15_000).unref();
  } catch (err) {
    logger.error('Error during shutdown', { message: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
