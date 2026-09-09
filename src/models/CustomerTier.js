import mongoose from 'mongoose'

/**
 * CustomerTier — B2C / B2B / CORPORATE as DATA, not as an enum.
 *
 * This is the small decision that keeps the whole pricing system extensible.
 * Hard-coding three tiers means `b2cPrice / b2bPrice / corporatePrice` fields
 * everywhere; adding a "Dealer" tier later would then mean a schema migration
 * plus touching every pricing structure in the database. Because prices are
 * keyed by `code` instead, a new tier is one row in this collection.
 *
 * `code` is immutable once created — it is the key used inside every product's
 * pricing map, so renaming it would orphan every price that references it.
 */
const customerTierSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z][A-Z0-9_]{1,23}$/, 'Code must be UPPER_SNAKE, 2-24 chars'],
      immutable: true,
    },

    /** The label admins and (for public tiers) customers see. */
    name: { type: String, required: true, trim: true, maxlength: 60 },

    description: { type: String, trim: true, maxlength: 300 },

    /** Display order in admin, and tie-break order when resolving fallbacks. */
    order: { type: Number, default: 0 },

    /**
     * Exactly one tier is the default. Anonymous visitors — and any customer
     * whose application is still pending — resolve to it. Enforced by the
     * pre-save hook below rather than by convention.
     */
    isDefault: { type: Boolean, default: false },

    /**
     * Whether prices in this tier may appear in an unauthenticated response.
     * True for B2C only. The public product serializer reads this flag; it is
     * what stops trade rates leaking into a page Google can crawl.
     */
    isPublic: { type: Boolean, default: false },

    /** Whether customers can self-apply for it (B2B/Corporate) vs. automatic. */
    requiresApproval: { type: Boolean, default: true },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

customerTierSchema.index({ order: 1 })

/** Only one default tier may exist. Demote any previous holder. */
customerTierSchema.pre('save', async function enforceSingleDefault(next) {
  if (this.isDefault && this.isModified('isDefault')) {
    await this.constructor.updateMany(
      { _id: { $ne: this._id }, isDefault: true },
      { $set: { isDefault: false } },
    )
  }
  next()
})

/** The tier anonymous callers get. Falls back to the lowest `order`. */
customerTierSchema.statics.resolveDefault = async function resolveDefault() {
  return (
    (await this.findOne({ isDefault: true, isActive: true }).lean()) ??
    (await this.findOne({ isActive: true }).sort({ order: 1 }).lean())
  )
}

export const CustomerTier = mongoose.model('CustomerTier', customerTierSchema)
