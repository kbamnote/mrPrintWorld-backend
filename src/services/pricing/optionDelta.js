/**
 * The price change for one option choice on one product, per customer tier.
 *
 * Most specific wins, tier by tier:
 *   1. this product's own price for this choice   (Product.options[].valueOverrides)
 *   2. an older per-product price for every choice (Product.options[].deltaOverrides)
 *   3. the library price on the choice itself      (OptionGroup.values[].priceDelta)
 *
 * Merging per tier lets a product charge retail customers differently while
 * trade customers keep the library price, without retyping it. The same
 * function prices the product page and the cart, so the two cannot disagree.
 */

/** A Mongoose Map or a plain object, as a plain object. */
function plain(map) {
  if (!map) return {}
  if (typeof map.get === 'function' && typeof map.entries === 'function') return Object.fromEntries(map.entries())
  return { ...map }
}

export function effectiveDelta(value, productOption) {
  return {
    ...plain(value?.priceDelta),
    ...plain(productOption?.deltaOverrides),
    ...plain(productOption?.valueOverrides?.[value?.code]),
  }
}
