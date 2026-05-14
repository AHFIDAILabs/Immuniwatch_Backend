import type { Request, Response, NextFunction } from 'express';
import { type ZodSchema } from 'zod';
import { AppError } from '../utils/AppError';

export function validate(schema: ZodSchema, target: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      const message = result.error.errors
        .map((e) => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
        .join('; ');
      next(new AppError(400, 'VALIDATION_ERROR', message));
      return;
    }
    // Replace with coerced / stripped data from Zod
    (req as unknown as Record<string, unknown>)[target] = result.data;
    next();
  };
}
