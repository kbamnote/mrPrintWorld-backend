import mongoose from 'mongoose'

/**
 * A reseller's own markup on one product, overriding their default.
 *
 * Stored as a PERCENTAGE ON TOP OF THE RESELLER'S COST rather than a fixed
 * price: most of the catalogue is priced by size, material and quantity, so a
 * single number could not cover every configuration a customer might order.
 * A percentage also follows the reseller's cost automatically when rates
 * change, so a markup can never fall below cost by going stale.
 */
const resellerPriceSchema = new mongoose.Schema(
  {
    reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Free pricing: the only floor is cost (0%). The ceiling is a typo guard,
    // not a commercial limit.
    markupPercent: { type: Number, required: true, min: 0, max: 1000 },
  },
  { timestamps: true },
)

resellerPriceSchema.index({ reseller: 1, product: 1 }, { unique: true })

export const ResellerPrice = mongoose.model('ResellerPrice', resellerPriceSchema)
