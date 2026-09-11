import { Router } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { findActiveResellerByCode, storeNameOf } from '../../services/reseller.js'

export const publicResellersRouter = Router()

/**
 * Resolve a share-link code to the store name a visitor will be shopping
 * with. Only ACTIVE resellers resolve; a paused or unknown code is a 404, so
 * the storefront simply ignores it.
 */
publicResellersRouter.get(
  '/:code',
  validate({ params: z.object({ code: z.string().trim().min(3).max(16).regex(/^[A-Za-z0-9]+$/) }).strict() }),
  asyncHandler(async (req, res) => {
    const reseller = await findActiveResellerByCode(req.validatedParams.code)
    if (!reseller) throw ApiError.notFound('Reseller not found')
    res.json({ ok: true, data: { code: reseller.reseller.code, storeName: storeNameOf(reseller) } })
  }),
)
