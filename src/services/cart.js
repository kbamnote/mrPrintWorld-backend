import { Product } from '../models/Product.js'
import { OptionGroup } from '../models/OptionGroup.js'
import { calculatePrice } from './pricing/resolvePrice.js'
import { resolvePricingContext, buildVisibilityFilter } from './pricing/resolveOverride.js'
import { resolveResellerFor, loadMarkups, markupFor, priceForReferred } from './reseller.js'

/**
 * Prices a cart.
 *
 * The client sends INTENT — which product, how many, what size, which options.
 * It never sends a price, and there is no field in which it could. Every
 * figure here is resolved server-side through the same calculatePrice() that
 * quotes a single product, so a cart total cannot disagree with the product
 * page, and an edited bundle cannot buy anything cheaply.
 *
 * This same function runs again at checkout, immediately before a payment is
 * created. A price that changed between adding to cart and paying is caught
 * there rather than being honoured silently.
 */

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * @param {Array}  lines  [{ slug, quantity, width, height, selections: [{group, value}] }]
 * @param {object} user   authenticated user, or null
 * @returns {Promise<{items, subtotal, taxTotal, grandTotal, issues}>}
 */
export async function priceCart(lines, user) {
  const issues = []
  const items = []

  if (!lines?.length) {
    return {
      items: [], subtotal: 0, taxTotal: 0, shippingTotal: 0, grandTotal: 0, issues: [],
      reseller: null, commissionTotal: 0,
    }
  }

  // One visibility filter for the whole cart — a product the caller may not
  // see is simply not found, exactly as on the product page.
  const visibility = await buildVisibilityFilter(user)
  const slugs = lines.map((l) => l.slug)
  const products = await Product.find({ slug: { $in: slugs }, ...visibility }).lean()
  const bySlug = new Map(products.map((p) => [p.slug, p]))

  // Resolve every option group referenced across the cart in one query.
  const groupIds = products.flatMap((p) => (p.options ?? []).map((o) => o.optionGroup))
  const groups = groupIds.length
    ? await OptionGroup.find({ _id: { $in: groupIds }, isActive: true }).lean()
    : []
  const groupByCode = new Map(groups.map((g) => [g.code, g]))

  // A reseller's customer is priced at the reseller's price — resolved once
  // for the whole cart.
  const reseller = await resolveResellerFor(user)
  const markups = reseller ? await loadMarkups(reseller._id, products.map((p) => p._id)) : new Map()

  for (const line of lines) {
    const product = bySlug.get(line.slug)

    if (!product) {
      issues.push({ slug: line.slug, message: 'This product is no longer available.' })
      continue
    }
    if (product.pricingModel === 'QUOTE_ONLY' || product.purchaseMode === 'QUOTE_ONLY') {
      issues.push({ slug: line.slug, message: `${product.name} is quoted individually and cannot be bought online.` })
      continue
    }

    // Minimum order quantity is enforced HERE, server-side — the client may
    // display it, but cannot waive it.
    const qty = Math.max(1, Number(line.quantity) || 1)
    if (product.moq?.qty && qty < product.moq.qty) {
      issues.push({
        slug: line.slug,
        message: `${product.name} has a minimum order of ${product.moq.qty} ${product.moq.unit ?? 'units'}.`,
      })
      continue
    }

    // Translate selection codes into priced option values. Anything the
    // product does not actually offer is dropped rather than trusted.
    const overridesByGroupId = new Map(
      (product.options ?? []).map((po) => [String(po.optionGroup), po.deltaOverrides]),
    )
    const resolvedSelections = []
    const selectionSnapshot = []

    for (const sel of line.selections ?? []) {
      const group = groupByCode.get(sel.group)
      if (!group) continue
      // The group must be attached to THIS product.
      if (!(product.options ?? []).some((po) => String(po.optionGroup) === String(group._id))) continue
      const value = (group.values ?? []).find((v) => v.code === String(sel.value))
      if (!value) continue

      resolvedSelections.push({
        label: `${group.label}: ${value.label}`,
        deltaType: value.deltaType,
        priceDelta: overridesByGroupId.get(String(group._id)) ?? value.priceDelta,
      })
      selectionSnapshot.push({
        group: group.code,
        groupLabel: group.label,
        value: value.code,
        valueLabel: value.label,
      })
    }

    const input = { quantity: qty, width: line.width, height: line.height, selections: resolvedSelections }
    let priced = null
    let resellerCost = null
    let commission = null

    if (reseller) {
      const sale = await priceForReferred({
        reseller,
        product,
        input,
        markupPercent: markupFor(reseller, product._id, markups),
      })
      if (sale) {
        priced = sale.priced
        resellerCost = sale.costTotal
        commission = sale.commission
      }
    }

    if (!priced) {
      const { tierCode, override } = await resolvePricingContext(user, product)
      priced = calculatePrice({ product, tierCode: tierCode ?? 'B2C', override, input })
    }

    if (!priced.quotable) {
      issues.push({ slug: line.slug, message: `${product.name}: ${priced.reason}` })
      continue
    }

    const taxPercent = product.taxPercent ?? 0
    const taxAmount = round((priced.total * taxPercent) / 100)

    items.push({
      product: product._id,
      name: product.name,
      slug: product.slug,
      imageUrl: product.images?.[0]?.url ?? product.legacyImageUrl ?? null,
      quantity: qty,
      width: line.width ?? null,
      height: line.height ?? null,
      area: priced.area ?? null,
      selections: selectionSnapshot,
      unitPrice: priced.unitPrice,
      lineTotal: priced.total,
      tierCode: priced.tier,
      negotiated: Boolean(priced.negotiated),
      hsnCode: product.hsnCode ?? null,
      taxPercent,
      taxAmount,
      breakdown: priced.breakdown,
      purchaseMode: product.purchaseMode,
      resellerCost,
      commission,
    })
  }

  const subtotal = round(items.reduce((s, i) => s + i.lineTotal, 0))
  const taxTotal = round(items.reduce((s, i) => s + i.taxAmount, 0))
  const shippingTotal = 0 // quoted separately for now — see routes/orders.js
  const grandTotal = round(subtotal + taxTotal + shippingTotal)
  const commissionTotal = round(items.reduce((s, i) => s + (i.commission ?? 0), 0))

  // `reseller` and the per-item cost/commission are INTERNAL. Routes that
  // answer a customer pass the result through customerSafeCart().
  return {
    items, subtotal, taxTotal, shippingTotal, grandTotal, issues,
    reseller: commissionTotal > 0 || items.some((i) => i.commission !== null) ? reseller : null,
    commissionTotal,
  }
}

/** Unused option groups map export kept for potential reuse by admin tooling. */
export { }
