import { Router } from 'express'
import { z } from 'zod'
import rateLimit from 'express-rate-limit'
import { Product } from '../../models/Product.js'
import { OptionGroup } from '../../models/OptionGroup.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { calculatePrice } from '../../services/pricing/resolvePrice.js'
import { resolvePricingContext, buildVisibilityFilter } from '../../services/pricing/resolveOverride.js'
import {
  resolveResellerFor,
  loadMarkups,
  markupFor,
  priceForReferred,
  storeNameOf,
} from '../../services/reseller.js'

export const publicPricingRouter = Router()

/**
 * NOTE the shape of this schema: there is NO `tier`, `customerType`,
 * `priceGroup` or `price` field, and `.strict()` rejects unknown keys outright.
 *
 * That is the whole anti-tampering design. A customer cannot request B2B rates
 * by editing the payload because there is no field in which to ask, and adding
 * one produces a 422 rather than being silently ignored. The tier comes from
 * the session, resolved server-side, every time.
 */
const calcBody = z
  .object({
    slug: z.string().trim().min(1).max(160),
    quantity: z.coerce.number().int().min(1).max(1_000_000).default(1),
    width: z.coerce.number().positive().max(10_000).optional(),
    height: z.coerce.number().positive().max(10_000).optional(),
    selections: z
      .array(
        z
          .object({
            group: z.string().trim().min(1).max(40), // OptionGroup.code
            value: z.union([z.string().trim().max(60), z.number(), z.boolean()]),
          })
          .strict(),
      )
      .max(40)
      .default([]),
  })
  .strict()

// The pricing endpoint is the most attractive one to hammer — it does real
// work and reveals commercial data. Limit it independently of everything else.
const pricingLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: { message: 'Too many price requests — please slow down' } },
})

publicPricingRouter.post(
  '/calculate',
  pricingLimiter,
  validate({ body: calcBody }),
  asyncHandler(async (req, res) => {
    // Prices are for signed-in customers only, so the calculator is gated too.
    // Without this the figure would still be one anonymous API call away.
    if (!req.user) throw ApiError.unauthorized('Sign in to see pricing')

    const { slug, quantity, width, height, selections } = req.validatedBody

    // The product must be one this caller may see at all, including any
    // per-organization allowlist.
    const product = await Product.findOne({
      slug,
      ...(await buildVisibilityFilter(req.user)),
    }).lean()
    if (!product) throw ApiError.notFound('Product not found')

    // Tier AND any negotiated rate are derived here, from the session —
    // never from the request body.
    const { tierCode, override } = await resolvePricingContext(req.user, product)

    // Translate {group, value} codes into the priced option values. Selections
    // referencing an option the product does not offer are ignored rather than
    // trusted — the client cannot invent a discount by inventing an option.
    let resolvedSelections = []
    if (selections.length && product.options?.length) {
      const ids = product.options.map((o) => o.optionGroup)
      const groups = await OptionGroup.find({ _id: { $in: ids }, isActive: true }).lean()
      const byCode = new Map(groups.map((g) => [g.code, g]))
      const overridesByGroupId = new Map(
        product.options.map((po) => [String(po.optionGroup), po.deltaOverrides]),
      )

      resolvedSelections = selections
        .map((sel) => {
          const group = byCode.get(sel.group)
          if (!group) return null
          const value = (group.values ?? []).find((v) => v.code === String(sel.value))
          if (!value) return null

          // Named distinctly: `override` in this file now means a NEGOTIATED
          // RATE, and shadowing it here would be a trap for the next reader.
          const deltaOverride = overridesByGroupId.get(String(group._id))
          return {
            label: `${group.label}: ${value.label}`,
            deltaType: value.deltaType,
            priceDelta: deltaOverride ?? value.priceDelta,
          }
        })
        .filter(Boolean)
    }

    const input = { quantity, width, height, selections: resolvedSelections }

    /**
     * The quantities a slab-priced product is actually sold in — 100, 200,
     * 500… Sent priced, so the storefront can offer "100 — ₹250 (₹2.50 each)"
     * in a dropdown instead of asking the customer to guess a number that may
     * not fall in any band. Empty for everything else.
     */
    const slabQuantities = [...(product.pricing?.slabs ?? [])]
      .map((slab) => slab.minQty)
      .filter((qty) => Number.isFinite(qty))
      .sort((a, b) => a - b)
      .slice(0, 24)

    // A reseller's customer sees the reseller's price — and only the price.
    const reseller = await resolveResellerFor(req.user)
    if (reseller) {
      const markups = await loadMarkups(reseller._id, [product._id])
      const markupPercent = markupFor(reseller, product._id, markups)
      // Resolved once and reused for every quantity below.
      const context = await resolvePricingContext(reseller, product)
      const sale = await priceForReferred({ reseller, product, input, markupPercent, context })

      if (sale) {
        const quantityOptions = []
        for (const qty of slabQuantities) {
          const band = await priceForReferred({
            reseller,
            product,
            markupPercent,
            context,
            input: { ...input, quantity: qty },
          })
          if (band) {
            quantityOptions.push({
              quantity: qty,
              total: band.priced.total,
              unitPrice: band.priced.unitPrice,
            })
          }
        }
        return res.json({
          ok: true,
          data: { ...sale.priced, soldBy: storeNameOf(reseller), quantityOptions },
        })
      }
    }

    const result = calculatePrice({ product, tierCode: tierCode ?? 'B2C', override, input })
    const quantityOptions = slabQuantities
      .map((qty) =>
        calculatePrice({ product, tierCode: tierCode ?? 'B2C', override, input: { ...input, quantity: qty } }),
      )
      .filter((band) => band.quotable)
      .map((band) => ({ quantity: band.quantity, total: band.total, unitPrice: band.unitPrice }))

    res.json({ ok: true, data: { ...result, quantityOptions } })
  }),
)
