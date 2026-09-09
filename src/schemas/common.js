import { z } from 'zod'
import mongoose from 'mongoose'

/** A Mongo ObjectId, validated before it can reach a query. */
export const objectId = z
  .string()
  .refine((v) => mongoose.Types.ObjectId.isValid(v), { message: 'Invalid id' })

/**
 * A tier-keyed money map: { B2C: 220, B2B: 185, CORPORATE: 170 }.
 *
 * Keys are validated as tier-code shaped but NOT checked against an enum here —
 * tiers are data (see models/CustomerTier.js), so a new tier must work without
 * a code change. Route handlers verify the codes exist before saving.
 */
export const tierAmountMap = z.record(
  z.string().regex(/^[A-Z][A-Z0-9_]{1,23}$/, 'Tier code must be UPPER_SNAKE'),
  z.number().min(0).max(100_000_000),
)
