import mongoose from 'mongoose'

export const INPUT_TYPES = [
  'DROPDOWN',
  'RADIO',
  'CHECKBOX',
  'NUMBER',
  'DIMENSION', // width/height in a unit — drives area pricing
  'TEXT',
  'FILE',
  'BOOLEAN',
]

/** How an option value changes the price it is attached to. */
export const DELTA_TYPES = [
  'FLAT', // + ₹X on the line
  'PER_SQFT', // + ₹X for every sq.ft
  'PERCENT', // + X% of the running subtotal
  'MULTIPLIER', // × X
]

const optionValueSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    order: { type: Number, default: 0 },

    /**
     * Price impact PER TIER, keyed by CustomerTier.code — never named fields.
     * A Map means adding a tier never reshapes stored option data.
     *   priceDelta: { B2C: 40, B2B: 32, CORPORATE: 28 }
     */
    priceDelta: {
      type: Map,
      of: Number,
      default: undefined,
    },
    deltaType: { type: String, enum: DELTA_TYPES, default: 'FLAT' },

    isActive: { type: Boolean, default: true },
  },
  { _id: false },
)

/**
 * OptionGroup — a reusable option definition.
 *
 * Roughly seventy signage products need Width and Height. Defining those
 * seventy times guarantees they drift apart, so definitions live here once and
 * products reference them (with per-product overrides where genuinely needed).
 *
 * The admin panel renders a form field purely from `inputType` and `values`,
 * which is what makes the frontend requirement enforceable: React never needs
 * to know that a product called "acp-sign-board" exists.
 */
const optionGroupSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z][A-Z0-9_]{1,39}$/, 'Code must be UPPER_SNAKE, 2-40 chars'],
    },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    helpText: { type: String, trim: true, maxlength: 300 },

    inputType: { type: String, enum: INPUT_TYPES, required: true },

    /** Display unit — "ft", "mm", "sq.ft". Null for non-measurement options. */
    unit: { type: String, trim: true, default: null },

    /** Only meaningful for choice types (DROPDOWN / RADIO / CHECKBOX). */
    values: { type: [optionValueSchema], default: [] },

    /** Only meaningful for NUMBER / DIMENSION. */
    validation: {
      min: { type: Number, default: null },
      max: { type: Number, default: null },
      step: { type: Number, default: null },
    },

    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

/** Choice-type groups are meaningless with no values — catch it at write time. */
optionGroupSchema.pre('validate', function requireValuesForChoiceTypes(next) {
  const isChoice = ['DROPDOWN', 'RADIO', 'CHECKBOX'].includes(this.inputType)
  if (isChoice && (!this.values || this.values.length === 0)) {
    return next(new Error(`${this.inputType} option "${this.code}" needs at least one value`))
  }
  // Duplicate value codes would make a selection ambiguous at price time.
  const codes = (this.values ?? []).map((v) => v.code)
  if (new Set(codes).size !== codes.length) {
    return next(new Error(`Duplicate value codes in option group "${this.code}"`))
  }
  next()
})

export const OptionGroup = mongoose.model('OptionGroup', optionGroupSchema)
