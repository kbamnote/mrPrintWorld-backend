import crypto from 'node:crypto'
import { Product } from '../models/Product.js'
import { Category } from '../models/Category.js'
import { loadMarkups, markupFor, priceForReferred, storeNameOf } from './reseller.js'
import { resolveDisplayPrice } from './pricing/resolvePrice.js'
import { resolvePricingContext } from './pricing/resolveOverride.js'

/**
 * A reseller's own price list: every product their customers can buy, at the
 * price THEY sell it for — their markup, or our retail price where they have
 * not set one.
 *
 * Prices come from priceForReferred(), the same function that quotes their
 * customer at checkout, so a catalogue can never disagree with the website.
 * Their cost and commission are never part of it: this file is made to be
 * forwarded to customers.
 *
 * The fingerprint is a hash of everything printed. The dashboard rebuilds the
 * PDF only when it changes, so a new product, a new price or a changed markup
 * produces a new catalogue and nothing else does.
 */

const MAX_PRODUCTS = 300
const MAX_PACKS_SHOWN = 6

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100
const qty = (n) => Number(n).toLocaleString('en-IN')

/** The reseller's selling price for a rate-based product (per sq.ft and the like). */
function rateRow(product, reseller, markupPercent) {
  const cost = resolveDisplayPrice({ product, tierCode: reseller.resolvedTier ?? 'B2C' })
  const retail = resolveDisplayPrice({ product, tierCode: 'B2C' })
  if (!cost) return null
  const price =
    markupPercent === null || markupPercent === undefined
      ? retail
        ? Math.max(retail.from, cost.from)
        : null
      : round(cost.from * (1 + markupPercent / 100))
  return price === null ? null : { label: `per ${cost.unit}`, price: round(Math.max(price, cost.from)) }
}

/**
 * @param {object} reseller  the signed-in reseller (lean user)
 * @param {string} storeUrl  their store link, printed and turned into a QR code
 */
export async function buildCatalogue(reseller, storeUrl) {
  // Only what a retail customer of theirs could actually buy.
  const products = await Product.find({ isActive: true, 'visibility.b2c': true })
    .select('name slug images legacyImageUrl pricingModel purchaseMode pricing primaryCategory shortDescription')
    .sort({ name: 1 })
    .limit(MAX_PRODUCTS)
    .lean()

  const markups = await loadMarkups(reseller._id, products.map((p) => p._id))
  const categoryIds = [...new Set(products.map((p) => String(p.primaryCategory)).filter((id) => id !== 'undefined'))]
  const categories = categoryIds.length
    ? await Category.find({ _id: { $in: categoryIds } }).select('name').lean()
    : []
  const categoryName = new Map(categories.map((c) => [String(c._id), c.name]))

  const groups = new Map()
  for (const product of products) {
    const markupPercent = markupFor(reseller, product._id, markups)
    // One pricing context per product, reused for every quantity.
    const context = await resolvePricingContext(reseller, product)
    const rows = []

    const quoted = product.pricingModel === 'QUOTE_ONLY' || product.purchaseMode === 'QUOTE_ONLY'
    if (!quoted && product.pricingModel === 'SLAB') {
      const quantities = [...(product.pricing?.slabs ?? [])]
        .map((s) => s.minQty)
        .sort((a, b) => a - b)
        .slice(0, MAX_PACKS_SHOWN)
      for (const quantity of quantities) {
        const sale = await priceForReferred({ reseller, product, markupPercent, context, input: { quantity } })
        if (sale) rows.push({ label: `${qty(quantity)} ${product.pricing?.unit ?? 'pieces'}`, price: sale.priced.total })
      }
    } else if (!quoted && product.pricingModel === 'FIXED') {
      const sale = await priceForReferred({ reseller, product, markupPercent, context, input: { quantity: 1 } })
      if (sale) rows.push({ label: `per ${product.pricing?.unit ?? 'unit'}`, price: sale.priced.total })
    } else if (!quoted) {
      const row = rateRow(product, reseller, markupPercent)
      if (row) rows.push(row)
    }

    const group = categoryName.get(String(product.primaryCategory)) ?? 'More products'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push({
      name: product.name,
      note: product.shortDescription ?? null,
      image: product.images?.find((i) => i.isPrimary)?.url ?? product.images?.[0]?.url ?? product.legacyImageUrl ?? null,
      rows,
      quoteOnly: rows.length === 0,
    })
  }

  const catalogue = {
    store: {
      name: storeNameOf(reseller) ?? 'Our store',
      code: reseller.reseller?.code ?? null,
      phone: reseller.phone ?? null,
      url: storeUrl,
    },
    groups: [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, items]) => ({ name, items })),
    productCount: products.length,
  }

  return {
    ...catalogue,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(catalogue)).digest('hex'),
  }
}
