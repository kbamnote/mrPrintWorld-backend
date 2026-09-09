import { Router } from 'express'
import { CustomerTier } from '../../models/CustomerTier.js'
import { asyncHandler } from '../../utils/ApiError.js'
import { resolveTierCode } from '../../services/pricing/resolvePrice.js'

export const publicTiersRouter = Router()

/**
 * Tells the frontend which tier the CURRENT caller resolves to, so the UI can
 * label pricing ("Retail price", "Your trade price") without ever computing it.
 *
 * Deliberately returns only the caller's own tier — not the list of tiers and
 * certainly not their rates. Advertising that a CORPORATE tier exists is fine;
 * exposing what it costs is not.
 */
publicTiersRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const code = await resolveTierCode(req.user)
    const tier = await CustomerTier.findOne({ code, isActive: true }).lean()

    res.json({
      ok: true,
      data: {
        code,
        name: tier?.name ?? 'Retail',
        isPublic: tier?.isPublic !== false,
        authenticated: Boolean(req.user),
      },
    })
  }),
)
