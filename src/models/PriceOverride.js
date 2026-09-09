import mongoose from 'mongoose'

export const OVERRIDE_SCOPES = ['ORGANIZATION', 'USER']
export const OVERRIDE_TYPES = ['ABSOLUTE', 'PERCENT_OFF', 'MARKUP_ON_TIER']

/**
 * Negotiated pricing — the "Ambuja pays ₹158 while the standard corporate
 * rate is ₹170" case.
 *
 * Deliberately a separate collection rather than fields on the product. A
 * negotiated rate is a fact about a RELATIONSHIP, not about the product, and
 * putting it on the product would mean editing every product each time a
 * contract is signed.
 *
 * `product` and `category` are both optional, which is what makes this
 * tractable to maintain:
 *   product set              → this product only
 *   category set             → every product in that branch ("12% off all
 *                              safety signage") — ONE row, and it covers
 *                              products added to that category later
 *   both null                → every product for that customer
 */
const priceOverrideSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: OVERRIDE_SCOPES, required: true, index: true },

    /** Organization._id or User._id, depending on `scope`. */
    scopeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },

    overrideType: { type: String, enum: OVERRIDE_TYPES, required: true },

    /**
     * ABSOLUTE       → the unit figure itself (₹158 per sq.ft)
     * PERCENT_OFF    → percentage off the base tier price (12 = 12% off)
     * MARKUP_ON_TIER → multiplier on the base tier price (0.95 = 5% off)
     */
    value: { type: Number, required: true, min: 0 },

    /** Which tier's price PERCENT_OFF and MARKUP_ON_TIER are computed from. */
    baseTier: { type: String, uppercase: true, trim: true, default: 'B2C' },

    // A negotiated rate usually has a contract period. Both optional; an
    // override with neither is simply always in force.
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },

    isActive: { type: Boolean, default: true, index: true },
    note: { type: String, trim: true, maxlength: 500 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

// The lookup the resolver performs on every priced request.
priceOverrideSchema.index({ scope: 1, scopeId: 1, isActive: 1 })

/** A row cannot name both a product and a category — the target would be ambiguous. */
priceOverrideSchema.pre('validate', function oneTargetOnly(next) {
  if (this.product && this.category) {
    return next(new Error('An override targets a product OR a category, not both'))
  }
  if (this.overrideType === 'PERCENT_OFF' && this.value > 100) {
    return next(new Error('PERCENT_OFF cannot exceed 100'))
  }
  if (this.validFrom && this.validTo && this.validTo <= this.validFrom) {
    return next(new Error('validTo must be after validFrom'))
  }
  next()
})

/** True when the override is active and inside its contract window. */
priceOverrideSchema.methods.isInForce = function isInForce(now = new Date()) {
  if (!this.isActive) return false
  if (this.validFrom && now < this.validFrom) return false
  if (this.validTo && now > this.validTo) return false
  return true
}

export const PriceOverride = mongoose.model('PriceOverride', priceOverrideSchema)
