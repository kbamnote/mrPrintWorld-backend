import { ApiError } from '../utils/ApiError.js'

/**
 * zod validation at the route boundary.
 *
 * This is also the NoSQL-injection defence. A query like `?slug[$ne]=` arrives
 * as an object; a `z.string()` rejects it outright, so nothing object-shaped
 * ever reaches a Mongo query. That is why there is no express-mongo-sanitize
 * here — strict schemas do the same job at the point where the data enters,
 * and they do it without monkey-patching req.query (which breaks on Express 5).
 *
 * Schemas MUST be strict. Unknown keys are rejected rather than stripped, so a
 * client trying to smuggle `tier` or `price` into a body gets a 422 instead of
 * having it silently ignored — the failure is visible in logs.
 */
export function validate({ body, query, params }) {
  return (req, _res, next) => {
    try {
      if (params) req.validatedParams = params.parse(req.params)
      if (query) req.validatedQuery = query.parse(req.query)
      if (body) req.validatedBody = body.parse(req.body)
      next()
    } catch (err) {
      if (err?.issues) {
        const details = err.issues.map((i) => ({
          field: i.path.join('.') || '(root)',
          message: i.message,
        }))
        return next(ApiError.unprocessable('Validation failed', details))
      }
      next(err)
    }
  }
}
