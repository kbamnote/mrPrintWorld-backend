import { PriceOverride } from '../../models/PriceOverride.js'
import { Organization } from '../../models/Organization.js'

/**
 * Finds the negotiated rate that applies to a given customer and product.
 *
 * Kept in its own module, and kept ASYNC, so that calculatePrice() can stay a
 * pure synchronous function. That separation is what lets the arithmetic be
 * unit-tested exhaustively without a database.
 *
 * Precedence — most specific wins:
 *   1. USER          + this product
 *   2. USER          + a category this product is in
 *   3. USER          + all products
 *   4. ORGANIZATION  + this product
 *   5. ORGANIZATION  + a category this product is in
 *   6. ORGANIZATION  + all products
 *   → none: the product's own tier pricing applies
 *
 * A personal override beats the organisation's because it is the narrower
 * agreement; a product override beats a category one for the same reason.
 */

/** Rank a candidate: lower sorts first. */
function specificity(override, productId) {
  const scopeRank = override.scope === 'USER' ? 0 : 3
  const targetRank = override.product
    ? String(override.product) === String(productId)
      ? 0
      : 99 // a product override for a DIFFERENT product never applies
    : override.category
      ? 1
      : 2
  return scopeRank + targetRank
}

/**
 * @param {object|null} user      the authenticated user, or null
 * @param {object}      product   lean product doc (needs _id, categories, categoryAncestors)
 * @returns {Promise<object|null>} the winning override, or null
 */
export async function resolveOverrideFor(user, product) {
  if (!user || !product) return null

  const scopeIds = [user._id]
  if (user.organization) scopeIds.push(user.organization)

  const candidates = await PriceOverride.find({
    scopeId: { $in: scopeIds },
    isActive: true,
  }).lean()

  if (!candidates.length) return null

  // Every category the product sits in, plus their ancestors — so a category
  // override on "Signage" reaches a product filed under "Outdoor Signage".
  const productCategoryIds = new Set(
    [...(product.categories ?? []), ...(product.categoryAncestors ?? [])].map(String),
  )

  const now = new Date()
  const applicable = candidates.filter((o) => {
    // Contract window.
    if (o.validFrom && now < new Date(o.validFrom)) return false
    if (o.validTo && now > new Date(o.validTo)) return false

    // Correct scope holder.
    if (o.scope === 'USER' && String(o.scopeId) !== String(user._id)) return false
    if (o.scope === 'ORGANIZATION' && String(o.scopeId) !== String(user.organization ?? '')) return false

    // Correct target.
    if (o.product) return String(o.product) === String(product._id)
    if (o.category) return productCategoryIds.has(String(o.category))
    return true // blanket override
  })

  if (!applicable.length) return null

  applicable.sort((a, b) => specificity(a, product._id) - specificity(b, product._id))
  return applicable[0]
}

/**
 * The full pricing context for a request: which tier, and which negotiated
 * rate (if any). Resolved server-side from the session — never from input.
 */
export async function resolvePricingContext(user, product) {
  let tierCode = user?.resolvedTier ?? null
  let organization = null

  if (user?.organization) {
    organization = await Organization.findById(user.organization).lean()
    // An organisation's tier applies to its members unless the individual has
    // been given a higher one of their own. Suspended orgs fall back to the
    // user's own tier rather than inheriting a contract rate.
    if (organization && organization.status === 'ACTIVE' && organization.tierCode) {
      if (!tierCode || tierCode === 'B2C') tierCode = organization.tierCode
    }
  }

  const override = await resolveOverrideFor(user, product)
  return { tierCode, organization, override }
}

/**
 * Build the visibility filter for a caller, including per-organization
 * product access.
 *
 * Returned as a Mongo filter fragment so it composes into the QUERY. A
 * product a caller may not see is never loaded — it is not fetched and then
 * hidden, which is how hidden products leak through an endpoint that forgot
 * a check.
 */
export async function buildVisibilityFilter(user) {
  const tierCode = user?.resolvedTier ?? 'B2C'
  const field =
    { B2C: 'visibility.b2c', B2B: 'visibility.b2b', CORPORATE: 'visibility.corporate' }[tierCode] ??
    'visibility.b2c'

  const filter = { isActive: true, [field]: true }

  if (!user?.organization) return filter

  const org = await Organization.findById(user.organization)
    .select('status productAccessMode allowedProducts allowedCategories')
    .lean()

  if (!org || org.status !== 'ACTIVE' || org.productAccessMode === 'ALL') return filter

  if (org.productAccessMode === 'ALLOWLIST') {
    filter._id = { $in: org.allowedProducts ?? [] }
  } else if (org.productAccessMode === 'CATEGORY_ALLOWLIST') {
    const ids = org.allowedCategories ?? []
    // Matches the category itself or anything beneath it, so adding a product
    // to an allowed category grants access automatically.
    filter.$or = [{ categories: { $in: ids } }, { categoryAncestors: { $in: ids } }]
  }

  return filter
}
