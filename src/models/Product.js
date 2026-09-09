import mongoose from 'mongoose'

export const PRICING_MODELS = ['FIXED', 'SLAB', 'AREA', 'OPTION', 'QUOTE_ONLY', 'HYBRID']
export const PURCHASE_MODES = ['BUY_NOW', 'QUOTE_ONLY', 'PRICE_AND_QUOTE']

/** Tier-keyed money map: { B2C: 220, B2B: 185, CORPORATE: 170 } */
const tierAmounts = { type: Map, of: Number, default: undefined }

const slabSchema = new mongoose.Schema(
  {
    minQty: { type: Number, required: true, min: 1 },
    maxQty: { type: Number, default: null }, // null = open-ended top slab
    amounts: tierAmounts,
  },
  { _id: false },
)

const productOptionSchema = new mongoose.Schema(
  {
    optionGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'OptionGroup', required: true },
    order: { type: Number, default: 0 },
    required: { type: Boolean, default: false },
    /** Per-product overrides — label only, or per-value price deltas. */
    labelOverride: { type: String, trim: true, default: null },
    deltaOverrides: { type: Map, of: Number, default: undefined },
  },
  { _id: false },
)

/**
 * Product — the single master record.
 *
 * ONE product serves B2C, B2B and Corporate. There are no duplicate records
 * per customer type; tier differences live in `pricing` and `visibility`.
 */
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },

    /**
     * Globally unique and STABLE. The public URL is /products/:slug and it must
     * never change — 27 of these are already indexed by Google. Changing a slug
     * is a deliberate, redirect-managed act, never a side effect of an edit.
     */
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    /**
     * MANY-TO-MANY. Your own product list has "Corporate Signage" under both
     * Indoor and Custom Signage, and "Promotional Boards" under both Retail and
     * Event Advertising. One product, one URL, listed in every category it
     * genuinely belongs to — rather than duplicated (two pages competing in
     * search) or awkwardly renamed.
     */
    categories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true }],

    /** Drives breadcrumbs and the canonical URL, which would otherwise be ambiguous. */
    primaryCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true },

    /** Cached union of every ancestor of every category — one-query branch filters. */
    categoryAncestors: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category', index: true }],

    shortDescription: { type: String, trim: true, maxlength: 400 },
    description: { type: String, trim: true, maxlength: 8000 },

    images: [
      {
        url: { type: String, required: true, trim: true },
        publicId: { type: String, trim: true }, // Cloudinary handle, for deletion
        alt: { type: String, trim: true },
        isPrimary: { type: Boolean, default: false },
        order: { type: Number, default: 0 },
        // No _id on image subdocuments. Mongoose adds one by default, the
        // admin form loads it, sends it back on save, and the strict write
        // schema then rejects it as an unrecognised key — which made saving a
        // product after uploading an image impossible.
        _id: false,
      },
    ],

    /**
     * A hotlinked third-party image carried over from the static catalogue, so
     * migrated products do not render blank. Its presence means "still needs a
     * real photograph" and the admin list flags it. Cleared when a genuine
     * image is uploaded.
     */
    legacyImageUrl: { type: String, trim: true, default: null },

    specifications: [{ type: String, trim: true }],
    applications: [{ type: String, trim: true }],
    customization: [{ type: String, trim: true }],
    materials: [{ type: String, trim: true }],
    sizes: [{ type: String, trim: true }],

    /** Real number + unit, not the display string "100 pieces" — so it can be enforced. */
    moq: {
      qty: { type: Number, default: null, min: 0 },
      unit: { type: String, trim: true, default: null },
    },

    // GST fields carried from day one. They cost nothing now and save a
    // migration when invoicing lands in Phase 6.
    hsnCode: { type: String, trim: true, default: null },
    taxPercent: { type: Number, default: null, min: 0, max: 100 },

    pricingModel: { type: String, enum: PRICING_MODELS, default: 'QUOTE_ONLY', index: true },
    purchaseMode: { type: String, enum: PURCHASE_MODES, default: 'QUOTE_ONLY' },

    /**
     * Shape depends on pricingModel:
     *   FIXED  → { unit, amounts }
     *   SLAB   → { unit, slabs[] }
     *   AREA   → { unit:'sqft', rates, minChargeableArea, roundUpTo }
     *   OPTION → { unit, rates|amounts, optionsAffectPrice: true }
     *   QUOTE_ONLY → null
     */
    pricing: {
      unit: { type: String, trim: true, default: null },
      amounts: tierAmounts,
      rates: tierAmounts,
      slabs: { type: [slabSchema], default: undefined },
      minChargeableArea: { type: Number, default: null, min: 0 },
      roundUpTo: { type: Number, default: null, min: 0 },
      optionsAffectPrice: { type: Boolean, default: false },
    },

    options: { type: [productOptionSchema], default: [] },

    /** Broad tier gate. Per-organization allowlists arrive in Phase 4. */
    visibility: {
      b2c: { type: Boolean, default: true },
      b2b: { type: Boolean, default: true },
      corporate: { type: Boolean, default: true },
    },

    featured: { type: Boolean, default: false, index: true },

    /**
     * Seeded products start false. They exist in admin but are absent from the
     * public API AND the sitemap, so customers never land on an empty product
     * page and Google never indexes thin content.
     */
    isActive: { type: Boolean, default: false, index: true },

    seo: {
      title: { type: String, trim: true, maxlength: 200 },
      description: { type: String, trim: true, maxlength: 400 },
    },

    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
)

productSchema.index({ isActive: 1, featured: -1, order: 1 })
productSchema.index({ categories: 1, isActive: 1 })
productSchema.index({ name: 'text', shortDescription: 'text' })

/** Slabs must be ordered and non-overlapping, or price resolution is ambiguous. */
productSchema.pre('validate', function validateSlabs(next) {
  const slabs = this.pricing?.slabs
  if (!slabs?.length) return next()

  const sorted = [...slabs].sort((a, b) => a.minQty - b.minQty)
  for (let i = 0; i < sorted.length; i += 1) {
    const s = sorted[i]
    if (s.maxQty !== null && s.maxQty < s.minQty) {
      return next(new Error(`Slab ${s.minQty}-${s.maxQty}: maxQty is below minQty`))
    }
    const prev = sorted[i - 1]
    if (prev && prev.maxQty !== null && s.minQty <= prev.maxQty) {
      return next(new Error(`Slabs overlap at quantity ${s.minQty}`))
    }
    if (prev && prev.maxQty === null) {
      return next(new Error('An open-ended slab (maxQty null) must be the last one'))
    }
  }
  next()
})

/** A priced product needs pricing; a quote-only product must not carry any. */
productSchema.pre('validate', function validatePricingShape(next) {
  if (this.pricingModel === 'QUOTE_ONLY') {
    this.purchaseMode = 'QUOTE_ONLY'
    return next()
  }
  const p = this.pricing ?? {}
  const hasAny =
    (p.amounts && p.amounts.size > 0) ||
    (p.rates && p.rates.size > 0) ||
    (p.slabs && p.slabs.length > 0)

  // Only enforced for published products — a draft is expected to be incomplete.
  if (this.isActive && !hasAny) {
    return next(
      new Error(`Product "${this.slug}" is active with pricingModel ${this.pricingModel} but has no prices`),
    )
  }
  next()
})

/** primaryCategory must be one of `categories`, or breadcrumbs lie. */
productSchema.pre('validate', function validatePrimaryCategory(next) {
  if (!this.categories?.length) return next()
  if (!this.primaryCategory) {
    this.primaryCategory = this.categories[0]
    return next()
  }
  const ok = this.categories.some((c) => String(c) === String(this.primaryCategory))
  if (!ok) return next(new Error('primaryCategory must be one of the product categories'))
  next()
})

export const Product = mongoose.model('Product', productSchema)
