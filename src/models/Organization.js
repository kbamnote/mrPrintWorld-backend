import mongoose from 'mongoose'

export const ORG_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED']

/**
 * Product access modes.
 *
 * ALL is the default and costs nothing — most organizations see the whole
 * catalogue. Only restricted accounts carry a list, which is why this is a
 * mode on the organization rather than a join row per allowed product: the
 * naive design would need thousands of rows to express "Ambuja sees these
 * four categories".
 */
export const ACCESS_MODES = ['ALL', 'ALLOWLIST', 'CATEGORY_ALLOWLIST']

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },

    // Statutory identifiers — the fields a corporate account actually needs
    // on an invoice.
    gstin: { type: String, trim: true, uppercase: true, maxlength: 20 },
    pan: { type: String, trim: true, uppercase: true, maxlength: 12 },
    cin: { type: String, trim: true, uppercase: true, maxlength: 30 },

    contact: {
      personName: { type: String, trim: true },
      designation: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
    },

    billingAddress: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
      country: { type: String, trim: true, default: 'India' },
    },

    /**
     * The tier every member of this organization is priced at.
     *
     * A user's own resolvedTier still applies if it is set; this is the
     * organisation-wide default, so adding a new staff member does not require
     * approving them individually.
     */
    tierCode: { type: String, uppercase: true, trim: true, default: 'CORPORATE', index: true },

    productAccessMode: { type: String, enum: ACCESS_MODES, default: 'ALL', index: true },
    allowedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    allowedCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],

    status: { type: String, enum: ORG_STATUSES, default: 'ACTIVE', index: true },

    /** Internal notes — never serialised to a customer-facing response. */
    internalNotes: { type: String, trim: true, maxlength: 4000 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
)

organizationSchema.virtual('members', {
  ref: 'User',
  localField: '_id',
  foreignField: 'organization',
})

/** An allowlist mode with an empty list would hide the entire catalogue. */
organizationSchema.pre('validate', function guardEmptyAllowlist(next) {
  if (this.productAccessMode === 'ALLOWLIST' && !this.allowedProducts?.length) {
    return next(new Error('ALLOWLIST mode needs at least one allowed product'))
  }
  if (this.productAccessMode === 'CATEGORY_ALLOWLIST' && !this.allowedCategories?.length) {
    return next(new Error('CATEGORY_ALLOWLIST mode needs at least one allowed category'))
  }
  next()
})

export const Organization = mongoose.model('Organization', organizationSchema)
