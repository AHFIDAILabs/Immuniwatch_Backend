import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { AppError } from '../utils/AppError';
import { AuthenticatedRequest, UserRole } from '../types';

function extractToken(req: Request): string | null {
  // 1. HttpOnly cookie (browser clients)
  if (req.cookies?.access_token) return req.cookies.access_token as string;
  // 2. Authorization header (API clients / CLI tools)
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) return next(new AppError(401, 'No token provided', 'UNAUTHORIZED'));

  try {
    const payload = verifyToken(token);
    if (payload.type !== 'access') return next(new AppError(401, 'Invalid token type', 'UNAUTHORIZED'));
    (req as AuthenticatedRequest).user = { id: payload.sub, role: payload.role as UserRole };
    next();
  } catch (err) {
    next(err);
  }
}

export function authorize(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    if (!roles.includes(authReq.user.role)) {
      return next(new AppError(403, 'Insufficient permissions', 'FORBIDDEN'));
    }
    next();
  };
}
