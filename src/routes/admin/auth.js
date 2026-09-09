import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { User } from '../../models/User.js'
import { env } from '../../config/env.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  requireAdmin,
} from '../../middleware/auth.js'

export const adminAuthRouter = Router()

// Brute-force protection. Deliberately tighter than the global limiter.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, error: { message: 'Too many sign-in attempts. Try again in 15 minutes.' } },
})

const REFRESH_COOKIE = 'mrpw_refresh'

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, // unreachable from JavaScript, so XSS cannot steal it
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax', // 'none' — admin is on a different origin to the API
    path: '/api/admin/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

adminAuthRouter.post(
  '/login',
  loginLimiter,
  validate({
    body: z
      .object({
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(1).max(200),
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.validatedBody

    const user = await User.findOne({ email }).select('+passwordHash')

    // One message and one timing path for "no such user" and "wrong password",
    // so the endpoint cannot be used to enumerate valid admin addresses.
    const ok = user && user.isActive && (await user.verifyPassword(password))
    if (!ok || !['ADMIN', 'STAFF'].includes(user.role)) {
      throw ApiError.unauthorized('Invalid email or password')
    }

    user.lastLoginAt = new Date()
    await user.save()

    setRefreshCookie(res, signRefreshToken(user))
    res.json({
      ok: true,
      data: {
        accessToken: signAccessToken(user),
        user: { id: String(user._id), name: user.name, email: user.email, role: user.role },
      },
    })
  }),
)

adminAuthRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE]
    if (!token) throw ApiError.unauthorized('No refresh token')

    let payload
    try {
      payload = verifyRefreshToken(token)
    } catch {
      throw ApiError.unauthorized('Session expired — please sign in again')
    }

    const user = await User.findById(payload.sub)
    if (!user || !user.isActive) throw ApiError.unauthorized('Account unavailable')

    // tokenVersion is bumped on password change or forced logout, which
    // invalidates every refresh token issued before that moment.
    if (user.tokenVersion !== payload.v) {
      throw ApiError.unauthorized('Session revoked — please sign in again')
    }

    setRefreshCookie(res, signRefreshToken(user)) // rotate on every use
    res.json({
      ok: true,
      data: {
        accessToken: signAccessToken(user),
        user: { id: String(user._id), name: user.name, email: user.email, role: user.role },
      },
    })
  }),
)

adminAuthRouter.post('/logout', (req, res) => {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/admin/auth' })
  res.json({ ok: true, data: { message: 'Signed out' } })
})

adminAuthRouter.get(
  '/me',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({
      ok: true,
      data: {
        id: String(req.user._id),
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
      },
    })
  }),
)
