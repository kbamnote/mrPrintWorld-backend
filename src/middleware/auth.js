import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { User } from '../models/User.js'
import { ApiError } from '../utils/ApiError.js'

/**
 * Two token types with two different secrets, so a leaked access token can
 * never be presented as a refresh token. `aud` separates the admin surface
 * from the (future) customer surface.
 */
export function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, tier: user.resolvedTier },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_TTL, audience: 'mrpw:access' },
  )
}

export function signRefreshToken(user) {
  return jwt.sign(
    { sub: String(user._id), v: user.tokenVersion },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_TTL, audience: 'mrpw:refresh' },
  )
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { audience: 'mrpw:refresh' })
}

/**
 * Refresh cookies for the two surfaces.
 *
 * Separate names AND separate paths, so a customer session and an admin
 * session can coexist in one browser without overwriting each other, and the
 * customer cookie is never even transmitted to /api/admin/*.
 */
export const REFRESH_COOKIES = {
  admin: { name: 'mrpw_refresh', path: '/api/admin/auth' },
  customer: { name: 'mrpw_c_refresh', path: '/api/auth' },
}

export function setRefreshCookie(res, surface, token) {
  const { name, path } = REFRESH_COOKIES[surface]
  res.cookie(name, token, {
    httpOnly: true, // unreachable from JavaScript, so XSS cannot steal it
    secure: env.isProd,
    // The site and the API are on different subdomains, so the cookie is
    // cross-site and needs SameSite=None — which browsers only accept with
    // Secure. That pairing is why NODE_ENV must be production in deployment.
    sameSite: env.isProd ? 'none' : 'lax',
    path,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

export function clearRefreshCookie(res, surface) {
  const { name, path } = REFRESH_COOKIES[surface]
  res.clearCookie(name, { path })
}

/**
 * Attaches req.user when a valid bearer token is present.
 * Never rejects — anonymous access is legitimate on public routes, and those
 * callers simply resolve to the default customer tier.
 */
export async function attachUser(req, _res, next) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return next()

  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { audience: 'mrpw:access' })
    const user = await User.findById(payload.sub).lean()
    if (user && user.isActive) req.user = user
  } catch {
    // An expired or malformed token is treated as anonymous rather than as an
    // error: a stale tab must degrade to public pricing, not to a 500.
  }
  next()
}

/** Gate for everything under /api/admin. Applied once at the router, not per handler. */
export function requireAdmin(req, _res, next) {
  if (!req.user) return next(ApiError.unauthorized('Sign in to continue'))
  if (!['ADMIN', 'STAFF'].includes(req.user.role)) {
    return next(ApiError.forbidden('Administrator access required'))
  }
  next()
}

/** Stricter gate for destructive or privilege-changing actions. */
export function requireFullAdmin(req, _res, next) {
  if (req.user?.role !== 'ADMIN') {
    return next(ApiError.forbidden('This action requires a full administrator'))
  }
  next()
}
