/**
 * The price change for one option choice on one product, per customer tier.
 *
 * Most specific wins, tier by tier:
 *   1. this product's price for this choice on THIS quantity pack (Product.options[].packOverrides)
 *   2. this product's price for this choice at every quantity     (Product.options[].valueOverrides)
 *   3. an older per-product price for every choice                 (Product.options[].deltaOverrides)
 *   4. the library price on the choice itself                      (OptionGroup.values[].priceDelta)
 *
 * Merging per tier means a price only has to be typed where it differs. The
 * same function prices the product page, the quantity dropdown, the cart and
 * reseller prices, so none of them can disagree.
 */

/** A Mongoose Map or a plain object, as a plain object. */
function plain(map) {
  if (!map) return {}
  if (typeof map.get === 'function' && typeof map.entries === 'function') return Object.fromEntries(map.entries())
  return { ...map }
}

/**
 * The pack a quantity falls in, as the key pack prices are stored under: the
 * pack's quantity ("1000"). Null for a product not priced in packs. Matching
 * the band rather than the exact number keeps older range slabs (100 - 499)
 * working too; they key by their starting quantity.
 */
export function packKeyFor(product, quantity) {
  if (product?.pricingModel !== 'SLAB') return null
  const qty = Number(quantity)
  const slab = (product.pricing?.slabs ?? []).find(
    (s) => qty >= s.minQty && (s.maxQty === null || s.maxQty === undefined || qty <= s.maxQty),
  )
  return slab ? String(slab.minQty) : null
}

/**
 * @param driverCode  when this field's prices depend on another field of the
 *   product (Product.options[].dependsOn — e.g. printing sides by Size), the
 *   choice made in that field. Its prices come first, tier by tier:
 *   that choice on this pack, then that choice at every quantity, then
 *   everything above.
 */
export function effectiveDelta(value, productOption, packKey = null, driverCode = null) {
  const byDriver = driverCode ? productOption?.driverPrices?.[driverCode] : null
  return {
    ...plain(value?.priceDelta),
    ...plain(productOption?.deltaOverrides),
    ...plain(productOption?.valueOverrides?.[value?.code]),
    ...plain(packKey ? productOption?.packOverrides?.[packKey]?.[value?.code] : null),
    ...plain(byDriver?.every?.[value?.code]),
    ...plain(packKey ? byDriver?.packs?.[packKey]?.[value?.code] : null),
  }
}

/* ── Choices not offered on some packs ──────────────────────────────────── */

/**
 * Whether this product offers a choice on a given pack. Marked per product in
 * Product.options[].packUnavailable: { "2000": ["TEXTURED"] }. The same for
 * every customer type — availability is not a pricing question.
 */
export function isChoiceAvailable(productOption, packKey, code) {
  if (!packKey) return true
  const blocked = productOption?.packUnavailable?.[packKey]
  return !(Array.isArray(blocked) && blocked.includes(String(code)))
}

/**
 * Whether a field has anything left to choose on a pack. A field with every
 * choice unavailable is not shown for that pack, so it cannot be required there.
 */
export function fieldOfferedOnPack(productOption, packKey, group) {
  return (group?.values ?? []).some((v) => v.isActive !== false && isChoiceAvailable(productOption, packKey, v.code))
}
