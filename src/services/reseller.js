import crypto from 'node:crypto'
import { User } from '../models/User.js'
import { ResellerPrice } from '../models/ResellerPrice.js'
import { calculatePrice } from './pricing/resolvePrice.js'
import { resolvePricingContext } from './pricing/resolveOverride.js'

/**
 * Reseller pricing and commission.
 *
 * The model, as agreed:
 *   - A reseller's customer pays the RESELLER'S price, in full, to MRPrint World.
 *   - The reseller earns that price minus their own cost, both before GST.
 *   - Pricing is free; the only floor is cost, so commission is never negative.
 *   - With no markup set, customers pay our normal retail price.
 *
 * Every figure still comes from calculatePrice() — this module only decides
 * WHICH calculations to run and how to combine them. There is no second
 * pricing engine.
 */

/** Days after delivery before a commission can be withdrawn. */
export const COMMISSION_HOLD_DAYS = 7

const CODE_PATTERN = /^[A-Z0-9]{3,16}$/

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function normaliseCode(code) {
  const c = String(code ?? '').trim().toUpperCase()
  return CODE_PATTERN.test(c) ? c : null
}

/** An ACTIVE reseller by referral code, or null. */
export function findActiveResellerByCode(code) {
  const c = normaliseCode(code)
  if (!c) return null
  return User.findOne({ 'reseller.code': c, 'reseller.status': 'ACTIVE', isActive: true }).lean()
}

/**
 * The reseller whose pricing applies to this customer, or null.
 *
 * Applies only to a RETAIL customer. Once a referred customer is approved for
 * trade pricing, or joins an organization, their own agreement governs what
 * they pay. A paused reseller's customers simply pay normal retail.
 */
export async function resolveResellerFor(user) {
  if (!user?.referredBy) return null
  if (user.resolvedTier && user.resolvedTier !== 'B2C') return null
  if (user.organization) return null
  if (user.reseller?.status === 'ACTIVE') return null // a reseller buys at their own price
  if (String(user.referredBy) === String(user._id)) return null

  return User.findOne({ _id: user.referredBy, 'reseller.status': 'ACTIVE', isActive: true }).lean()
}

export function storeNameOf(reseller) {
  return reseller?.reseller?.storeName || reseller?.name || null
}

/** Per-product markups for one reseller, keyed by product id. */
export async function loadMarkups(resellerId, productIds) {
  if (!productIds?.length) return new Map()
  const rows = await ResellerPrice.find({ reseller: resellerId, product: { $in: productIds } })
    .select('product markupPercent')
    .lean()
  return new Map(rows.map((r) => [String(r.product), r.markupPercent]))
}

/** Per-product markup, else the reseller's default, else null (= retail). */
export function markupFor(reseller, productId, markups) {
  const own = markups.get(String(productId))
  if (own !== undefined && own !== null) return own
  const fallback = reseller?.reseller?.defaultMarkupPercent
  return fallback === undefined ? null : fallback
}

function describe(product, cost) {
  const unit = product.pricing?.unit
  if (cost.area) {
    return `${cost.area} ${unit ?? 'sq.ft'}${cost.quantity > 1 ? ` × ${cost.quantity}` : ''}`
  }
  return `${cost.quantity} × ${product.name}`
}

/**
 * Price one product for a reseller's customer.
 *
 * @returns {{ priced, costTotal, commission } | null}
 *   `priced` is safe to send to the customer — it carries no cost-derived
 *   rates. null when the reseller has no cost for this product; the caller
 *   then prices the customer normally, with no commission.
 */
export async function priceForReferred({ reseller, product, input, markupPercent }) {
  const { tierCode, override } = await resolvePricingContext(reseller, product)
  const cost = calculatePrice({ product, tierCode: tierCode ?? 'B2C', override, input })
  if (!cost.quotable) return null

  let total
  if (markupPercent === null || markupPercent === undefined) {
    const retail = calculatePrice({ product, tierCode: 'B2C', input })
    if (!retail.quotable) return null
    total = retail.total
  } else {
    total = cost.total * (1 + markupPercent / 100)
  }

  // The floor. Also covers a retail price that has fallen below trade.
  total = round(Math.max(total, cost.total))
  const factor = cost.total > 0 ? total / cost.total : 1

  return {
    priced: {
      quotable: true,
      requiresQuote: cost.requiresQuote,
      quantity: cost.quantity,
      area: cost.area ?? null,
      unitPrice: round(cost.unitPrice * factor),
      total,
      currency: 'INR',
      tier: 'B2C',
      negotiated: false,
      // ONE line. The itemised breakdown names per-sq.ft rates, which here
      // would be the reseller's cost — exactly what the customer must not see.
      breakdown: [{ label: describe(product, cost), amount: total }],
    },
    costTotal: round(cost.total),
    commission: round(total - cost.total),
  }
}

/* ── Keeping reseller economics away from customers ───────────────────── */

export function customerSafeItem(item) {
  const copy = { ...item }
  delete copy.resellerCost
  delete copy.commission
  return copy
}

/** A cart as the customer may see it. */
export function customerSafeCart(priced) {
  return {
    items: priced.items.map(customerSafeItem),
    subtotal: priced.subtotal,
    taxTotal: priced.taxTotal,
    shippingTotal: priced.shippingTotal,
    grandTotal: priced.grandTotal,
    issues: priced.issues,
    soldBy: priced.reseller ? storeNameOf(priced.reseller) : null,
  }
}

/** An order as the customer may see it. */
export function customerSafeOrder(order) {
  const copy = { ...order, items: (order.items ?? []).map(customerSafeItem) }
  const soldBy = order.resellerSnapshot?.storeName ?? null
  delete copy.reseller
  delete copy.resellerSnapshot
  delete copy.commissionTotal
  return { ...copy, soldBy }
}

/* ── Commission state (the wallet builds on this) ─────────────────────── */

function deliveredAtOf(order) {
  if (order.deliveredAt) return new Date(order.deliveredAt)
  const entry = (order.timeline ?? []).findLast?.((t) => t.status === 'DELIVERED')
  return entry?.at ? new Date(entry.at) : null
}

/**
 * PENDING until delivered + 7 days, then READY. Cancelled or refunded orders
 * earn nothing.
 */
export function commissionState(order, now = Date.now()) {
  if (['CANCELLED', 'REFUNDED'].includes(order.status) || order.payment?.status === 'REFUNDED') {
    return { state: 'CANCELLED', readyOn: null }
  }
  if (order.status === 'DELIVERED') {
    const delivered = deliveredAtOf(order) ?? new Date(order.updatedAt ?? now)
    const readyOn = new Date(delivered.getTime() + COMMISSION_HOLD_DAYS * 86_400_000)
    return { state: now >= readyOn.getTime() ? 'READY' : 'PENDING', readyOn }
  }
  return { state: 'PENDING', readyOn: null }
}

/** A short, unique, shareable code — e.g. SHARMA482. */
export async function generateResellerCode(seed) {
  const base = String(seed ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MRPW'
  for (let i = 0; i < 8; i += 1) {
    const code = `${base}${crypto.randomInt(100, 1000)}`
    if (!(await User.exists({ 'reseller.code': code }))) return code
  }
  return `${base}${crypto.randomBytes(3).toString('hex').toUpperCase()}`
}
