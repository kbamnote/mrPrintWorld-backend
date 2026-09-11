import mongoose from 'mongoose'

export const ORDER_STATUSES = [
  'PENDING_PAYMENT', // created, awaiting payment
  'PAID', // payment verified
  'IN_PRODUCTION',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'PAYMENT_FAILED',
]

export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'REFUNDED']

/**
 * A line item stores the price it was CHARGED AT, not a reference to the
 * product's current price.
 *
 * An order is a historical record. If the rate card changes tomorrow, or a
 * customer's contract ends, this order must still show what was actually
 * agreed — recomputing from the live product would silently rewrite history
 * and make invoices disagree with what was paid.
 */
const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    // Snapshot, so the order still reads correctly if the product is renamed
    // or deleted later.
    name: { type: String, required: true },
    slug: { type: String, required: true },
    imageUrl: { type: String, default: null },

    quantity: { type: Number, required: true, min: 1 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    area: { type: Number, default: null },
    selections: [
      {
        group: String,
        groupLabel: String,
        value: String,
        valueLabel: String,
        _id: false,
      },
    ],

    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },

    // What the customer was priced at, kept for audit.
    tierCode: { type: String, required: true },
    negotiated: { type: Boolean, default: false },

    // GST, carried per line because rates differ by HSN.
    hsnCode: { type: String, default: null },
    taxPercent: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },

    breakdown: { type: Array, default: [] },

    // Reseller sales only. What the reseller would have paid for this line,
    // and the margin credited to them. Never sent to the customer — see
    // customerSafeOrder() in services/reseller.js.
    resellerCost: { type: Number, default: null },
    commission: { type: Number, default: null },
  },
  { _id: false },
)

const addressSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    line1: { type: String, trim: true },
    line2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, trim: true, default: 'India' },
  },
  { _id: false },
)

const orderSchema = new mongoose.Schema(
  {
    /** Human-readable, sequential: MRPW-2026-00001 */
    orderNumber: { type: String, required: true, unique: true, index: true },

    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },

    // Snapshot of who ordered, so the record survives a profile edit.
    customer: {
      name: String,
      email: String,
      phone: String,
      gstin: String,
    },

    items: { type: [orderItemSchema], required: true },

    subtotal: { type: Number, required: true, min: 0 },
    taxTotal: { type: Number, required: true, min: 0, default: 0 },
    shippingTotal: { type: Number, required: true, min: 0, default: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },

    shippingAddress: addressSchema,
    billingAddress: addressSchema,
    customerNote: { type: String, trim: true, maxlength: 1000 },

    status: { type: String, enum: ORDER_STATUSES, default: 'PENDING_PAYMENT', index: true },

    /**
     * Reseller sale. The commission is a snapshot, like every other figure on
     * an order: a reseller changing their markup tomorrow does not change what
     * they earned today.
     */
    reseller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    resellerSnapshot: { name: String, storeName: String, code: String },
    commissionTotal: { type: Number, default: 0 },

    /** Starts the 7-day clock before a reseller's commission can be withdrawn. */
    deliveredAt: { type: Date, default: null },

    payment: {
      provider: { type: String, default: 'razorpay' },
      status: { type: String, enum: PAYMENT_STATUSES, default: 'PENDING' },
      // Razorpay's order id — created before the customer pays.
      providerOrderId: { type: String, default: null, index: true },
      // Set only after the signature is verified server-side.
      providerPaymentId: { type: String, default: null },
      signatureVerified: { type: Boolean, default: false },
      method: { type: String, default: null },
      paidAt: { type: Date, default: null },
      failureReason: { type: String, default: null },
    },

    /** Append-only audit trail. Every status change is recorded. */
    timeline: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        note: String,
        _id: false,
      },
    ],
  },
  { timestamps: true },
)

orderSchema.index({ user: 1, createdAt: -1 })
orderSchema.index({ status: 1, createdAt: -1 })

orderSchema.methods.pushTimeline = function pushTimeline(status, by = null, note = null) {
  this.timeline.push({ status, at: new Date(), by, note })
}

export const Order = mongoose.model('Order', orderSchema)

/**
 * Sequential order numbers.
 *
 * findOneAndUpdate with $inc is atomic, so two simultaneous checkouts cannot
 * receive the same number — which a count() + 1 approach would allow.
 */
const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
})
export const Counter = mongoose.model('Counter', counterSchema)

export async function nextOrderNumber() {
  const year = new Date().getFullYear()
  const key = `order-${year}`
  const doc = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  )
  return `MRPW-${year}-${String(doc.seq).padStart(5, '0')}`
}
