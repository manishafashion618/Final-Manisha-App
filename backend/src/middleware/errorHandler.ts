import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { isProduction } from '../config/env';
import { logger } from '../config/logger';
import { reportError } from '../config/monitoring';
import { renderNotFound } from '../pages/notFound';
import { ApiError } from '../utils/ApiError';

const NOT_FOUND_PAGE = renderNotFound();

/**
 * A browser asking for a page that does not exist (a GET or HEAD outside
 * /api) gets a small HTML page with somewhere to go. Everything else — every
 * /api path, and any other method — keeps the JSON envelope the app reads.
 */
export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  const isApi = req.path === '/api' || req.path.startsWith('/api/');
  if (!isApi && (req.method === 'GET' || req.method === 'HEAD')) {
    res.set('Cache-Control', 'no-store');
    res.status(404).type('html').send(NOT_FOUND_PAGE);
    return;
  }
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

/**
 * Terminal error stage. Everything leaves as:
 *   { "success": false, "error": { "code", "message", "details"? } }
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let apiError: ApiError;

  if (error instanceof ApiError) {
    apiError = error;
  } else if (isMulterError(error)) {
    // Upload limits (size, count, field) are the client's to fix.
    apiError =
      error.code === 'LIMIT_FILE_SIZE'
        ? new ApiError(413, 'Each image must be 8 MB or smaller.', 'FILE_TOO_LARGE')
        : new ApiError(400, error.message || 'The upload was not accepted.', 'UPLOAD_REJECTED');
  } else if (isBodyParserError(error)) {
    // The client sent something unreadable: its mistake, not a server fault.
    apiError =
      error.type === 'entity.too.large'
        ? new ApiError(413, 'The request body is too large.', 'PAYLOAD_TOO_LARGE')
        : new ApiError(400, 'The request body is not valid JSON.', 'MALFORMED_BODY');
  } else if (error instanceof mongoose.Error.ValidationError) {
    apiError = new ApiError(
      422,
      'Validation failed',
      'VALIDATION_ERROR',
      Object.values(error.errors).map((fieldError) => ({
        field: fieldError.path,
        message: fieldError.message,
      })),
    );
  } else if (error instanceof mongoose.Error.CastError) {
    apiError = ApiError.badRequest(`Invalid value for '${error.path}'`);
  } else if (isDuplicateKeyError(error)) {
    const field = Object.keys(error.keyPattern ?? {})[0] ?? 'field';
    apiError = ApiError.conflict(`A record with this ${field} already exists`);
  } else {
    apiError = ApiError.internal();
  }

  if (apiError.statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} → ${apiError.statusCode}`, error);
    reportError(error, { route: `${req.method} ${req.route?.path ?? req.path}`, userId: req.user?.id });
  } else {
    logger.warn(`${req.method} ${req.originalUrl} → ${apiError.statusCode} ${apiError.code}`);
  }

  res.status(apiError.statusCode).json({
    success: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
      // Stack traces are development-only; never leak internals to a client.
      ...(!isProduction && !(error instanceof ApiError) && error instanceof Error
        ? { debug: error.message }
        : {}),
    },
  });
}

function isMulterError(error: unknown): error is { code: string; message: string } {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'MulterError';
}

/** body-parser marks its errors with a `type` and a 4xx `status`. */
function isBodyParserError(error: unknown): error is { type: string; status: number } {
  if (typeof error !== 'object' || error === null) return false;
  const { type, status } = error as { type?: unknown; status?: unknown };
  return typeof type === 'string' && type.startsWith('entity.') && typeof status === 'number' && status < 500;
}

function isDuplicateKeyError(
  error: unknown,
): error is { code: number; keyPattern?: Record<string, unknown> } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 11000
  );
}
