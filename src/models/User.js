import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'

export const ROLES = ['ADMIN', 'STAFF', 'CUSTOMER']
export const ACCOUNT_TYPES = ['B2C', 'B2B', 'CORPORATE']
export const USER_STATUSES = [
  'ACTIVE',
  'B2B_PENDING',
  'B2B_APPROVED',
  'B2B_REJECTED',
  'CORPORATE_PENDING',
  'CORPORATE_APPROVED',
  'CORPORATE_REJECTED',
  'SUSPENDED',
]

/**
 * User — admins in Phase 2, customers from Phase 3.
 *
 * The customer-facing fields are defined now because their SHAPE matters to
 * the pricing design, even though nothing writes them yet. Adding them later
 * would be additive but would also mean revisiting the pricing resolver.
 */
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address'],
    },
    // `select: false` — the hash never rides along on an ordinary query, so it
    // cannot leak through a route that forgot to project it away.
    passwordHash: { type: String, required: true, select: false },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 24 },

    role: { type: String, enum: ROLES, default: 'CUSTOMER', index: true },
    accountType: { type: String, enum: ACCOUNT_TYPES, default: 'B2C' },
    status: { type: String, enum: USER_STATUSES, default: 'ACTIVE', index: true },

    /**
     * THE ONLY FIELD THE PRICING RESOLVER READS.
     *
     * Set by the server on approval — never from a request body, and never
     * derived from `accountType`. This is what makes "selecting B2B at signup
     * must not grant B2B pricing" structurally true rather than a rule someone
     * has to remember: a pending user's resolvedTier is still B2C, so there is
     * no code path that yields them trade rates.
     */
    resolvedTier: { type: String, default: 'B2C', uppercase: true, trim: true, index: true },

    // Phase 4 — corporate staff belong to one organization.
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    orgRole: { type: String, enum: ['OWNER', 'PURCHASER', 'VIEWER', 'ACCOUNTS', null], default: null },

    businessProfile: {
      businessName: { type: String, trim: true },
      gstin: { type: String, trim: true, uppercase: true },
      businessType: { type: String, trim: true },
      address: { type: String, trim: true },
    },

    /**
     * Reseller programme. `status` gates everything: referral pricing and
     * commission apply ONLY while ACTIVE. PENDING is written by the customer's
     * own application; every other transition is an admin action.
     */
    reseller: {
      status: { type: String, enum: ['PENDING', 'ACTIVE', 'PAUSED'], default: null, index: true },
      code: { type: String, trim: true, uppercase: true },
      storeName: { type: String, trim: true, maxlength: 80 },
      /** null = customers pay our retail price; a number = % on top of the reseller's own cost. */
      defaultMarkupPercent: { type: Number, min: 0, max: 1000, default: null },
      appliedAt: { type: Date, default: null },
      approvedAt: { type: Date, default: null },
      approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    },

    /**
     * The reseller whose link this customer signed up through. Written once,
     * at registration, and never by the customer afterwards — attribution is
     * for life, which is what lets a reseller share freely.
     */
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    referredAt: { type: Date, default: null },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, default: null },

    lastLoginAt: { type: Date, default: null },
    /** Bumped on password change / forced logout — invalidates live refresh tokens. */
    tokenVersion: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

// A referral code identifies exactly one reseller. Partial, so the many users
// without a code do not collide on null.
userSchema.index(
  { 'reseller.code': 1 },
  { unique: true, partialFilterExpression: { 'reseller.code': { $type: 'string' } } },
)

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12)
}

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash)
}

/** Never serialise the hash, even if a route accidentally selected it. */
userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash
    delete ret.tokenVersion
    return ret
  },
})

export const User = mongoose.model('User', userSchema)
