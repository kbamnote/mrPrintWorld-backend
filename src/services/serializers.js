import { resolveDisplayPrice } from './pricing/resolvePrice.js'

/**
 * Public serializers.
 *
 * These build the response by WHITELIST — they name every field that goes out,
 * rather than taking the document and deleting sensitive keys. A blacklist
 * fails open: add a field to the schema and it ships publicly until someone
 * remembers to exclude it. A whitelist fails closed, which is the behaviour we
 * want around pricing.
 *
 * In particular, the raw `pricing` sub-document is NEVER serialised. It holds
 * every tier's rates. Only the single resolved figure for the caller's own
 * tier is returned.
 */

export function publicCategory(cat) {
  if (!cat) return null
  return {
    id: String(cat._id),
    name: cat.name,
    slug: cat.slug,
    description: cat.description ?? null,
    image: cat.image?.url ? { url: cat.image.url, alt: cat.image.alt ?? cat.name } : null,
    depth: cat.depth ?? 0,
    parent: cat.parent ? String(cat.parent) : null,
    order: cat.order ?? 0,
    seo: { title: cat.seo?.title ?? null, description: cat.seo?.description ?? null },
    ...(cat.children ? { children: cat.children.map(publicCategory) } : {}),
  }
}

function primaryImage(product) {
  const chosen =
    product.images?.find((i) => i.isPrimary) ?? product.images?.[0] ?? null
  if (chosen) return { url: chosen.url, alt: chosen.alt ?? product.name }
  // Migrated hotlink — keeps a seeded product from rendering blank while it
  // waits for real photography. Never exposes that it is a legacy value.
  if (product.legacyImageUrl) return { url: product.legacyImageUrl, alt: product.name }
  return null
}

/** Listing card — deliberately lean. */
export function publicProductCard(product, { tierCode, tierIsPublic }) {
  return {
    id: String(product._id),
    name: product.name,
    slug: product.slug,
    shortDescription: product.shortDescription ?? null,
    image: primaryImage(product),
    featured: Boolean(product.featured),
    purchaseMode: product.purchaseMode,
    categories: (product.categories ?? []).map((c) =>
      typeof c === 'object' && c.slug ? { id: String(c._id), name: c.name, slug: c.slug } : String(c),
    ),
    // Price is omitted entirely when the tier is not public — the key is absent
    // rather than null, so nothing about trade pricing is inferable.
    ...(tierIsPublic ? { price: resolveDisplayPrice({ product, tierCode }) } : {}),
  }
}

/** Detail page — everything a product page renders, and nothing more. */
export function publicProductDetail(product, { tierCode, tierIsPublic, optionGroups = [] }) {
  return {
    id: String(product._id),
    name: product.name,
    slug: product.slug,
    shortDescription: product.shortDescription ?? null,
    description: product.description ?? null,
    images:
      product.images?.length > 0
        ? product.images
            .slice()
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((i) => ({ url: i.url, alt: i.alt ?? product.name, isPrimary: Boolean(i.isPrimary) }))
        : primaryImage(product)
          ? [primaryImage(product)]
          : [],
    specifications: product.specifications ?? [],
    applications: product.applications ?? [],
    customization: product.customization ?? [],
    materials: product.materials ?? [],
    sizes: product.sizes ?? [],
    moq: product.moq?.qty ? { qty: product.moq.qty, unit: product.moq.unit ?? 'pieces' } : null,

    categories: (product.categories ?? []).map((c) =>
      typeof c === 'object' && c.slug ? { id: String(c._id), name: c.name, slug: c.slug } : String(c),
    ),
    primaryCategory:
      product.primaryCategory && typeof product.primaryCategory === 'object'
        ? { id: String(product.primaryCategory._id), name: product.primaryCategory.name, slug: product.primaryCategory.slug }
        : null,

    pricingModel: product.pricingModel,
    purchaseMode: product.purchaseMode,
    // The calculator needs the option SHAPE, never the tier rate table.
    options: optionGroups,
    ...(tierIsPublic ? { price: resolveDisplayPrice({ product, tierCode }) } : {}),

    seo: {
      title: product.seo?.title ?? product.name,
      description: product.seo?.description ?? product.shortDescription ?? null,
    },
  }
}

/**
 * Option groups for the public calculator.
 * Price deltas are stripped — the client posts a selection and the server
 * returns the price, so the client never needs to know what an option costs.
 */
export function publicOptionGroup(group, productOption = {}) {
  return {
    code: group.code,
    label: productOption.labelOverride ?? group.label,
    helpText: group.helpText ?? null,
    inputType: group.inputType,
    unit: group.unit ?? null,
    required: Boolean(productOption.required),
    order: productOption.order ?? 0,
    validation: group.validation ?? null,
    values: (group.values ?? [])
      .filter((v) => v.isActive !== false)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((v) => ({ code: v.code, label: v.label })),
  }
}
