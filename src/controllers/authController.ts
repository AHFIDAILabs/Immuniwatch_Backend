import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { signAccessToken, signRefreshToken, verifyToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';
import { config } from '../config';
import { AuthenticatedRequest, AuditAction } from '../types';

// ── Cookie helpers ────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_MS  = 15 * 60 * 1000;        // 15 minutes
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure:   config.cookie.secure,
  sameSite: config.cookie.sameSite as 'strict' | 'lax' | 'none',
};

function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie('access_token', accessToken, {
    ...BASE_COOKIE_OPTIONS,
    maxAge: ACCESS_TOKEN_TTL_MS,
    path:   '/',
  });
  res.cookie('refresh_token', refreshToken, {
    ...BASE_COOKIE_OPTIONS,
    maxAge: REFRESH_TOKEN_TTL_MS,
    path:   '/api', // Vite proxy rewrites /api → /api/v1, so match on /api prefix
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie('access_token',  { ...BASE_COOKIE_OPTIONS, path: '/' });
  res.clearCookie('refresh_token', { ...BASE_COOKIE_OPTIONS, path: '/api' });
}

// ── Controllers ───────────────────────────────────────────────────────────────

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = req.body as { email: string; password: string };

    const user = await User.findOne({ email: email.toLowerCase(), isActive: true }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      throw new AppError(401, 'Invalid credentials');
    }

    const accessToken  = signAccessToken(user.id, user.role);
    const refreshToken = signRefreshToken(user.id, user.role);

    user.refreshToken = refreshToken;
    user.lastActive   = new Date();
    await user.save();

    await AuditLog.create({
      actor:        user._id,
      actorName:    user.name,
      action:       AuditAction.USER_LOGIN,
      resourceType: 'User',
      resourceId:   user.id,
      ipAddress:    req.ip,
    });

    setAuthCookies(res, accessToken, refreshToken);

    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refreshToken = req.cookies?.refresh_token as string | undefined;
    if (!refreshToken) throw new AppError(401, 'No refresh token');

    const payload = verifyToken(refreshToken);
    if (payload.type !== 'refresh') throw new AppError(401, 'Invalid token type');

    const user = await User.findById(payload.sub).select('+refreshToken');
    if (!user || user.refreshToken !== refreshToken) {
      throw new AppError(401, 'Refresh token revoked');
    }

    const newAccess  = signAccessToken(user.id, user.role);
    const newRefresh = signRefreshToken(user.id, user.role);

    user.refreshToken = newRefresh;
    user.lastActive   = new Date();
    await user.save();

    setAuthCookies(res, newAccess, newRefresh);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user } = req as AuthenticatedRequest;
    await User.findByIdAndUpdate(user.id, { $unset: { refreshToken: '' } });

    await AuditLog.create({
      actor:        user.id,
      action:       AuditAction.USER_LOGOUT,
      resourceType: 'User',
      resourceId:   user.id,
    });

    clearAuthCookies(res);
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

export async function me(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { user } = req as AuthenticatedRequest;
    const dbUser = await User.findById(user.id);
    if (!dbUser) throw new AppError(404, 'User not found');
    res.json({ id: dbUser.id, name: dbUser.name, email: dbUser.email, role: dbUser.role });
  } catch (err) {
    next(err);
  }
}
