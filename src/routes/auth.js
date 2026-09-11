import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { User } from '../models/User.js'
import { CustomerTier } from '../models/CustomerTier.js'
import { validate } from '../middleware/validate.js'
import { asyncHandler, ApiError } from '../utils/ApiError.js'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
  REFRESH_COOKIES,
} from '../middleware/auth.js'
import { resolveResellerFor, findActiveResellerByCode, storeNameOf } from '../services/reseller.js'

export const customerAuthRouter = Router()

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, error: { message: 'Too many attempts. Try again in 15 minutes.' } },
})

const businessProfile = z
  .object({
    businessName: z.string().trim().min(1).max(200),
    gstin: z.string().trim().max(20).optional(),
    businessType: z.string().trim().max(120).optional(),
    address: z.string().trim().max(500).optional(),
  })
  .strict()

/**
 * NOTE what is absent from this schema: `resolvedTier`, `role` and `status`.
 *
 * A registrant may state which KIND of account they want, but they cannot
 * grant themselves one. `accountType` is a request; `resolvedTier` is the
 * server's answer to it, and stays B2C until an admin approves. `.strict()`
 * means an attempt to smuggle either field in is a 422, not a silent ignore.
 */
const registerBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8, 'Use at least 8 characters').max(200),
    phone: z.string().trim().max(24).optional(),
    accountType: z.enum(['B2C', 'B2B', 'CORPORATE']).default('B2C'),
    businessProfile: businessProfile.optional(),
    // From a reseller's share link. An unknown or paused code is ignored
    // rather than failing the signup.
    referralCode: z.string().trim().max(16).regex(/^[A-Za-z0-9]+$/).optional(),
  })
  .strict()

function publicUser(user, tier, seller = null) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone ?? null,
    accountType: user.accountType,
    status: user.status,
    // The tier the customer is actually being priced at right now.
    tier: { code: user.resolvedTier, name: tier?.name ?? 'Retail' },
    businessProfile: user.businessProfile ?? null,
    organization: user.organization ? String(user.organization) : null,
    // Whose customer this is — shown as "Sold via …" next to prices.
    // The code lets the storefront keep this customer inside that store.
    soldBy: seller ? { storeName: storeNameOf(seller), code: seller.reseller?.code ?? null } : null,
    // This account's own reseller standing, if it has applied.
    reseller: user.reseller?.status
      ? {
          status: user.reseller.status,
          code: user.reseller.code ?? null,
          storeName: user.reseller.storeName ?? null,
        }
      : null,
  }
}

async function tierFor(user) {
  return CustomerTier.findOne({ code: user.resolvedTier }).lean()
}

async function describeUser(user) {
  const [tier, seller] = await Promise.all([tierFor(user), resolveResellerFor(user)])
  return publicUser(user, tier, seller)
}

customerAuthRouter.post(
  '/register',
  authLimiter,
  validate({ body: registerBody }),
  asyncHandler(async (req, res) => {
    const { name, email, password, phone, accountType, businessProfile: profile, referralCode } =
      req.validatedBody

    if (await User.exists({ email })) {
      throw ApiError.conflict('An account with that email already exists')
    }
    if (accountType !== 'B2C' && !profile?.businessName) {
      throw ApiError.badRequest('Business name is required for a trade or corporate account')
    }

    const status =
      accountType === 'B2B' ? 'B2B_PENDING' : accountType === 'CORPORATE' ? 'CORPORATE_PENDING' : 'ACTIVE'

    // Attribution happens here and only here: an EXISTING account is never
    // moved to a reseller by clicking a link, so resellers cannot poach
    // customers who came to us directly.
    const referrer = referralCode ? await findActiveResellerByCode(referralCode) : null

    const user = new User({
      name,
      email,
      phone,
      role: 'CUSTOMER',
      accountType,
      status,
      // Everyone starts on retail pricing. This is the line that makes
      // "selecting B2B must not grant B2B rates" structurally true rather
      // than a rule someone has to remember to enforce.
      resolvedTier: 'B2C',
      businessProfile: profile ?? undefined,
      referredBy: referrer?._id ?? null,
      referredAt: referrer ? new Date() : null,
    })
    await user.setPassword(password)
    await user.save()

    setRefreshCookie(res, 'customer', signRefreshToken(user))
    res.status(201).json({
      ok: true,
      data: {
        accessToken: signAccessToken(user),
        user: await describeUser(user),
        // Told plainly, so nobody is surprised by retail pricing after
        // registering as a business.
        message:
          accountType === 'B2C'
            ? 'Account created.'
            : 'Account created. You are on retail pricing until your application is approved.',
      },
    })
  }),
)

customerAuthRouter.post(
  '/login',
  authLimiter,
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

    // One message for both "no such user" and "wrong password", so the
    // endpoint cannot be used to discover which addresses are registered.
    const ok = user && user.isActive && (await user.verifyPassword(password))
    if (!ok) throw ApiError.unauthorized('Invalid email or password')
    if (user.status === 'SUSPENDED') throw ApiError.forbidden('This account has been suspended')

    user.lastLoginAt = new Date()
    await user.save()

    setRefreshCookie(res, 'customer', signRefreshToken(user))
    res.json({
      ok: true,
      data: { accessToken: signAccessToken(user), user: await describeUser(user) },
    })
  }),
)

customerAuthRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIES.customer.name]
    if (!token) throw ApiError.unauthorized('No session')

    let payload
    try {
      payload = verifyRefreshToken(token)
    } catch {
      throw ApiError.unauthorized('Session expired — please sign in again')
    }

    const user = await User.findById(payload.sub)
    if (!user || !user.isActive) throw ApiError.unauthorized('Account unavailable')
    if (user.tokenVersion !== payload.v) throw ApiError.unauthorized('Session revoked')

    setRefreshCookie(res, 'customer', signRefreshToken(user)) // rotate on use
    res.json({
      ok: true,
      data: { accessToken: signAccessToken(user), user: await describeUser(user) },
    })
  }),
)

customerAuthRouter.post('/logout', (req, res) => {
  clearRefreshCookie(res, 'customer')
  res.json({ ok: true, data: { message: 'Signed out' } })
})

customerAuthRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized('Not signed in')
    res.json({ ok: true, data: await describeUser(req.user) })
  }),
)

/**
 * Apply to upgrade an existing retail account to trade or corporate.
 *
 * Deliberately does NOT change resolvedTier — it only records the request and
 * moves the account into a pending state for an admin to review.
 */
customerAuthRouter.post(
  '/apply',
  authLimiter,
  validate({
    body: z
      .object({
        accountType: z.enum(['B2B', 'CORPORATE']),
        businessProfile,
      })
      .strict(),
  }),
  asyncHandler(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized('Sign in to apply')

    const user = await User.findById(req.user._id)
    const { accountType, businessProfile: profile } = req.validatedBody

    if (['B2B_PENDING', 'CORPORATE_PENDING'].includes(user.status)) {
      throw ApiError.conflict('You already have an application under review')
    }
    if (user.resolvedTier === accountType) {
      throw ApiError.conflict(`Your account is already approved for ${accountType} pricing`)
    }

    user.accountType = accountType
    user.status = accountType === 'B2B' ? 'B2B_PENDING' : 'CORPORATE_PENDING'
    user.businessProfile = profile
    user.rejectionReason = null
    // resolvedTier is untouched. That is the whole point.
    await user.save()

    res.json({
      ok: true,
      data: {
        user: await describeUser(user),
        message: 'Application submitted. We will confirm by email once it is reviewed.',
      },
    })
  }),
)
