import jwt, { SignOptions } from 'jsonwebtoken';
import { config } from '../config';
import { AppError } from './AppError';

export interface JwtPayload {
  sub:            string;
  role:           string;
  organizationId: string | null;  // null for super_admin (platform-level)
  type:           'access' | 'refresh';
}

export function signAccessToken(
  userId:         string,
  role:           string,
  organizationId: string | null,
): string {
  return jwt.sign(
    { sub: userId, role, organizationId, type: 'access' } as JwtPayload,
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiresIn } as SignOptions,
  );
}

export function signRefreshToken(
  userId:         string,
  role:           string,
  organizationId: string | null,
): string {
  return jwt.sign(
    { sub: userId, role, organizationId, type: 'refresh' } as JwtPayload,
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiresIn } as SignOptions,
  );
}

export function verifyToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, config.jwt.secret) as JwtPayload;
  } catch {
    throw new AppError(401, 'Invalid or expired token', 'UNAUTHORIZED');
  }
}
