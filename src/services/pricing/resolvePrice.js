import { CustomerTier } from '../../models/CustomerTier.js'

/**
 * THE single place a price is ever produced.
 *
 * Both the public pricing endpoint and the admin live-preview call this. Two
 * implementations of this logic is the most likely way the platform develops
 * pricing bugs — where admin shows one number and the customer is charged
 * another — so there must only ever be one.
 *
 * Non-negotiable rules:
 *   1. The tier is passed in by the caller, derived from the SESSION. It is
 *      never read from a request body. See routes/public/pricing.js.
 *   2. If no price can be resolved the product becomes quote-only. It never
 *      falls back to a cheaper tier and never returns zero — a missing price
 *      must not become a cheap price.
 */

/** Read a tier-keyed Map/object safely. Mongoose gives a Map; .lean() gives an object. */
function readTierValue(map, tierCode) {
  if (!map) return undefined
  if (typeof map.get === 'function') return map.get(tierCode)
  return map[tierCode]
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Resolve the effective tier code for a request.
 * Anonymous callers, and customers whose application is still pending, land on
 * the default tier — which is exactly what makes public B2C pricing work
 * without a special case anywhere else.
 */
export async function resolveTierCode(user) {
  if (user?.resolvedTier) return user.resolvedTier
  const fallback = await CustomerTier.resolveDefault()
  return fallback?.code ?? 'B2C'
}

/**
 * Apply a negotiated override to a resolved unit figure.
 *
 * Takes the tier price as the starting point and returns the contracted one,
 * plus a line for the breakdown so a customer (and an admin) can see WHY the
 * number differs from the published rate.
 *
 * Returns null when no override applies, so the caller keeps the tier price.
 */
function applyOverride(basePrice, override, readTier) {
  if (!override) return null

  if (override.overrideType === 'ABSOLUTE') {
    return { price: override.value, label: 'Contracted rate' }
  }

  // PERCENT_OFF and MARKUP_ON_TIER are computed FROM a named tier, not from
  // whatever the customer would otherwise have paid — so the discount is
  // stable even if the customer's own tier changes.
  const from = readTier(override.baseTier) ?? basePrice
  if (from === undefined || from === null) return null

  if (override.overrideType === 'PERCENT_OFF') {
    return { price: from * (1 - override.value / 100), label: `Contracted ${override.value}% off` }
  }
  if (override.overrideType === 'MARKUP_ON_TIER') {
    return { price: from * override.value, label: 'Contracted rate' }
  }
  return null
}

/** Pick the slab covering `qty`. Returns null when no slab matches. */
function findSlab(slabs, qty) {
  return (
    slabs.find((s) => qty >= s.minQty && (s.maxQty === null || s.maxQty === undefined || qty <= s.maxQty)) ?? null
  )
}

/** Chargeable area, honouring minimum area and rounding rules. */
function computeArea(width, height, pricing) {
  const raw = width * height
  const rounded = pricing.roundUpTo
    ? Math.ceil(raw / pricing.roundUpTo) * pricing.roundUpTo
    : raw
  return Math.max(rounded, pricing.minChargeableArea ?? 0)
}

/**
 * Apply option deltas to a running subtotal.
 * Order matters: FLAT and PER_SQFT accumulate, then PERCENT, then MULTIPLIER —
 * so a percentage applies to the built-up line rather than to the base only.
 */
function applyOptionDeltas({ subtotal, area, selections, tierCode }) {
  const lines = []
  let flat = 0

  for (const sel of selections) {
    const delta = readTierValue(sel.priceDelta, tierCode)
    if (delta === undefined || delta === null) continue

    if (sel.deltaType === 'FLAT') {
      flat += delta
      lines.push({ label: sel.label, type: 'FLAT', amount: round(delta) })
    } else if (sel.deltaType === 'PER_SQFT') {
      const amount = delta * (area ?? 0)
      flat += amount
      lines.push({ label: sel.label, type: 'PER_SQFT', rate: delta, amount: round(amount) })
    }
  }

  let running = subtotal + flat

  for (const sel of selections) {
    const delta = readTierValue(sel.priceDelta, tierCode)
    if (delta === undefined || delta === null) continue
    if (sel.deltaType === 'PERCENT') {
      const amount = running * (delta / 100)
      running += amount
      lines.push({ label: sel.label, type: 'PERCENT', percent: delta, amount: round(amount) })
    }
  }

  for (const sel of selections) {
    const delta = readTierValue(sel.priceDelta, tierCode)
    if (delta === undefined || delta === null) continue
    if (sel.deltaType === 'MULTIPLIER') {
      const before = running
      running *= delta
      lines.push({ label: sel.label, type: 'MULTIPLIER', factor: delta, amount: round(running - before) })
    }
  }

  return { total: running, lines }
}

/**
 * @param {object}  product     a Product document or lean object
 * @param {string}  tierCode    resolved server-side — NOT from the client
 * @param {object}  input       { quantity, width, height, selections[] }
 * @returns {object} { quotable, unitPrice, total, currency, breakdown[], reason? }
 */
export function calculatePrice({ product, tierCode, input = {}, override = null }) {
  const quoteOnly = (reason) => ({
    quotable: false,
    requiresQuote: true,
    total: null,
    unitPrice: null,
    currency: 'INR',
    tier: tierCode,
    breakdown: [],
    reason,
  })

  if (!product) return quoteOnly('Product not found')
  if (product.pricingModel === 'QUOTE_ONLY') return quoteOnly('This product is quoted individually')

  const pricing = product.pricing ?? {}
  const quantity = Math.max(1, Number(input.quantity) || 1)
  const selections = input.selections ?? []
  const breakdown = []
  let area = null
  let unitPrice = null

  switch (product.pricingModel) {
    case 'FIXED': {
      const amt = readTierValue(pricing.amounts, tierCode)
      if (amt === undefined) return quoteOnly('No price configured for your account type')
      const neg = applyOverride(amt, override, (t) => readTierValue(pricing.amounts, t))
      unitPrice = neg ? neg.price : amt
      breakdown.push({
        label: neg ? `${neg.label} per ${pricing.unit ?? 'unit'}` : `Base price per ${pricing.unit ?? 'unit'}`,
        amount: round(unitPrice),
      })
      break
    }

    case 'SLAB': {
      if (!pricing.slabs?.length) return quoteOnly('No quantity slabs configured')
      const slab = findSlab(pricing.slabs, quantity)
      if (!slab) return quoteOnly(`No price band covers a quantity of ${quantity}`)
      const amt = readTierValue(slab.amounts, tierCode)
      if (amt === undefined) return quoteOnly('No price configured for your account type')
      const negSlab = applyOverride(amt, override, (t) => readTierValue(slab.amounts, t))
      const bandPrice = negSlab ? negSlab.price : amt
      // A slab price is the price FOR THAT BAND, not per unit.
      breakdown.push({
        label: `${slab.minQty}${slab.maxQty ? `–${slab.maxQty}` : '+'} ${pricing.unit ?? 'units'}${negSlab ? ` · ${negSlab.label}` : ''}`,
        amount: round(bandPrice),
      })
      const withOptions = applyOptionDeltas({ subtotal: bandPrice, area: null, selections, tierCode })
      breakdown.push(...withOptions.lines)
      return {
        quotable: true,
        requiresQuote: product.purchaseMode === 'PRICE_AND_QUOTE',
        quantity,
        unitPrice: round(withOptions.total / quantity),
        total: round(withOptions.total),
        currency: 'INR',
        tier: tierCode,
        negotiated: Boolean(override),
        breakdown,
      }
    }

    case 'AREA':
    case 'OPTION': {
      const rate = readTierValue(pricing.rates, tierCode) ?? readTierValue(pricing.amounts, tierCode)
      if (rate === undefined) return quoteOnly('No rate configured for your account type')

      const width = Number(input.width)
      const height = Number(input.height)
      if (!width || !height || width <= 0 || height <= 0) {
        return quoteOnly('Enter a width and height to see a price')
      }

      area = computeArea(width, height, pricing)
      const negArea = applyOverride(rate, override, (t) => readTierValue(pricing.rates, t) ?? readTierValue(pricing.amounts, t))
      unitPrice = negArea ? negArea.price : rate
      breakdown.push({
        label: `${width} × ${height} = ${round(area)} ${pricing.unit ?? 'sq.ft'} @ ₹${round(unitPrice)}${negArea ? ` · ${negArea.label}` : ''}`,
        amount: round(area * unitPrice),
      })
      break
    }

    default:
      return quoteOnly('Unsupported pricing model')
  }

  const base = product.pricingModel === 'FIXED' ? unitPrice * quantity : area * unitPrice * quantity
  const withOptions = applyOptionDeltas({ subtotal: base, area, selections, tierCode })
  breakdown.push(...withOptions.lines)

  if (product.pricingModel === 'FIXED' && quantity > 1) {
    breakdown.push({ label: `× ${quantity} units`, amount: null })
  }

  return {
    quotable: true,
    requiresQuote: product.purchaseMode === 'PRICE_AND_QUOTE',
    quantity,
    area: area ? round(area) : null,
    unitPrice: round(unitPrice),
    total: round(withOptions.total),
    currency: 'INR',
    tier: tierCode,
    // Flags a contracted rate without revealing the agreement's terms.
    negotiated: Boolean(override),
    breakdown,
  }
}

/**
 * The "from" price shown on listing cards — cheapest configuration, no options.
 * Returns null for quote-only products so the card can say "Request a quote".
 */
export function resolveDisplayPrice({ product, tierCode }) {
  if (!product || product.pricingModel === 'QUOTE_ONLY') return null
  const p = product.pricing ?? {}

  if (product.pricingModel === 'FIXED') {
    const amt = readTierValue(p.amounts, tierCode)
    return amt === undefined ? null : { from: round(amt), unit: p.unit ?? 'unit', currency: 'INR' }
  }
  if (product.pricingModel === 'SLAB' && p.slabs?.length) {
    const first = [...p.slabs].sort((a, b) => a.minQty - b.minQty)[0]
    const amt = readTierValue(first?.amounts, tierCode)
    return amt === undefined ? null : { from: round(amt), unit: `${first.minQty} ${p.unit ?? 'units'}`, currency: 'INR' }
  }
  const rate = readTierValue(p.rates, tierCode) ?? readTierValue(p.amounts, tierCode)
  return rate === undefined ? null : { from: round(rate), unit: p.unit ?? 'sq.ft', currency: 'INR' }
}
