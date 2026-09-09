import { env } from '../config/env.js'
import { ApiError } from '../utils/ApiError.js'

export function notFound(req, _res, next) {
  next(ApiError.notFound(`No route for ${req.method} ${req.originalUrl}`))
}

/* eslint-disable-next-line no-unused-vars -- Express identifies the error
   handler by its four-parameter signature; `next` must stay. */
export function errorHandler(err, req, res, next) {
  // Mongo duplicate key → a conflict the caller can act on, not a 500.
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field'
    err = ApiError.conflict(`That ${field} is already in use`, { field })
  }

  // Mongoose validation / cast failures are the caller's fault, not ours.
  if (err?.name === 'ValidationError') {
    const details = Object.values(err.errors ?? {}).map((e) => ({
      field: e.path,
      message: e.message,
    }))
    err = ApiError.unprocessable('Validation failed', details)
  }
  if (err?.name === 'CastError') {
    err = ApiError.badRequest(`Invalid ${err.path}`)
  }

  const status = err.status ?? 500
  const expected = err.expected === true

  // Unexpected errors are always logged in full; expected ones are noise.
  if (!expected || status >= 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, err)
  }

  res.status(status).json({
    ok: false,
    error: {
      message: expected || !env.isProd ? err.message : 'Something went wrong',
      ...(err.details ? { details: err.details } : {}),
      // Stack traces never cross the wire in production.
      ...(env.isProd ? {} : { stack: err.stack?.split('\n').slice(0, 4) }),
    },
  })
}
