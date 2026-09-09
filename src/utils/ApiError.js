/**
 * Typed application error. Anything thrown that is NOT an ApiError is treated
 * as unexpected by the error handler and its detail is withheld in production.
 */
export class ApiError extends Error {
  constructor(status, message, details = undefined) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
    this.expected = true
  }

  static badRequest(msg = 'Bad request', details) {
    return new ApiError(400, msg, details)
  }
  static unauthorized(msg = 'Authentication required') {
    return new ApiError(401, msg)
  }
  static forbidden(msg = 'Not permitted') {
    return new ApiError(403, msg)
  }
  static notFound(msg = 'Not found') {
    return new ApiError(404, msg)
  }
  static conflict(msg = 'Conflict', details) {
    return new ApiError(409, msg, details)
  }
  static unprocessable(msg = 'Unprocessable', details) {
    return new ApiError(422, msg, details)
  }
  static serviceUnavailable(msg = 'Service unavailable') {
    return new ApiError(503, msg)
  }
}

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 5 forwards rejections natively, but this keeps intent explicit and
 * survives a downgrade.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)
