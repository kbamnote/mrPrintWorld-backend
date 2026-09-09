/**
 * The category tree, and where each existing product lands in it.
 *
 * Roots 1–2 (Signage, Advertising Products) are the client's supplied
 * structure, verbatim. Roots 3–8 are the proposed home for the 27 products
 * that were already in the static catalogue — these are the part awaiting
 * review, and are easy to change here without touching any code.
 *
 * Every slug below is deliberate: category slugs are used in browse URLs
 * (/products/c/:root/:sub) and must stay stable once published.
 */

export const CATEGORY_TREE = [
  {
    slug: 'signage',
    name: 'Signage',
    description: 'Outdoor, indoor, retail and custom signage — fabricated, finished and installed.',
    children: [
      { slug: 'outdoor-signage', name: 'Outdoor Signage' },
      { slug: 'indoor-signage', name: 'Indoor Signage' },
      { slug: 'retail-signage', name: 'Retail Signage' },
      { slug: 'custom-signage', name: 'Custom Signage' },
    ],
  },
  {
    slug: 'advertising-products',
    name: 'Advertising Products',
    description: 'Banners, displays and event branding for campaigns, exhibitions and storefronts.',
    children: [
      { slug: 'banners-displays', name: 'Banners & Displays' },
      { slug: 'promotional-displays', name: 'Promotional Displays' },
      { slug: 'event-advertising', name: 'Event Advertising' },
    ],
  },
  {
    slug: 'printing-stationery',
    name: 'Printing & Stationery',
    description: 'Business stationery, marketing collateral and print media.',
    children: [
      { slug: 'business-stationery', name: 'Business Stationery' },
      { slug: 'marketing-collateral', name: 'Marketing Collateral' },
      { slug: 'stickers-decals', name: 'Stickers & Decals' },
    ],
  },
  {
    slug: 'corporate-gifts',
    name: 'Corporate Gifts & Merchandise',
    description: 'Awards, mementos, gift sets and branded merchandise.',
    children: [
      { slug: 'awards-mementos', name: 'Awards & Mementos' },
      { slug: 'gift-sets', name: 'Gift Sets' },
      { slug: 'apparel-merchandise', name: 'Apparel & Merchandise' },
    ],
  },
  {
    slug: 'acrylic-products',
    name: 'Acrylic Products',
    description: 'Precision-cut and laser-engraved acrylic for signage, interiors and display.',
    children: [],
  },
  {
    slug: 'fabrication-cutting',
    name: 'Fabrication & Cutting',
    description: 'Laser cutting, CNC routing and carving across wood, acrylic and composites.',
    children: [
      { slug: 'laser-cutting', name: 'Laser Cutting' },
      { slug: 'cnc-cutting', name: 'CNC Cutting & Carving' },
    ],
  },
  {
    slug: 'interior-decor',
    name: 'Interior & Decor',
    description: 'Wall murals, canvas prints and decorative interior surfaces.',
    children: [],
  },
  {
    slug: 'packaging',
    name: 'Packaging',
    description: 'Custom printed packaging and boxes.',
    children: [],
  },
]

/**
 * Existing product slug → the category slugs it belongs to.
 *
 * The FIRST entry becomes primaryCategory (breadcrumb + canonical URL).
 * Product slugs are NEVER changed here — they are indexed by Google, and
 * preserving them is what makes this migration invisible to search.
 */
export const PRODUCT_CATEGORY_MAP = {
  // Printing & Stationery
  'premium-business-cards': ['business-stationery'],
  'corporate-letterheads': ['business-stationery'],
  'custom-printed-envelopes': ['business-stationery'],
  'marketing-brochures': ['marketing-collateral'],
  'vinyl-stickers': ['stickers-decals'],

  // Corporate Gifts & Merchandise
  'acrylic-corporate-mementos': ['awards-mementos'],
  'uv-printed-plaques': ['awards-mementos'],
  'premium-corporate-gift-sets': ['gift-sets'],
  'promotional-apparel': ['apparel-merchandise'],
  'uv-printed-merchandise': ['apparel-merchandise'],

  // Acrylic
  'acrylic-table-tops': ['acrylic-products'],
  // Sits in two branches — the many-to-many case, pending confirmation of
  // whether this should also split into "Acrylic Letters" + "House Name Plates".
  'acrylic-led-nameplates': ['acrylic-products', 'custom-signage'],

  // Signage
  'glow-sign-boards': ['outdoor-signage'],
  'acp-led-sign-boards': ['outdoor-signage'],
  'dealer-boards': ['retail-signage'],
  'interior-wayfinding-signage': ['indoor-signage'],

  // Advertising
  'flex-banners': ['banners-displays'],
  'rollup-standees': ['banners-displays'],
  'led-clip-on-frames': ['promotional-displays'],
  'promotional-canopies': ['promotional-displays', 'event-advertising'],

  // Fabrication
  'laser-cut-mdf-art': ['laser-cutting'],
  'laser-engraved-nameplates': ['laser-cutting'],
  'cnc-router-cut-letters': ['cnc-cutting'],
  'cnc-carved-panels': ['cnc-cutting'],

  // Interior & Decor
  'custom-wall-murals': ['interior-decor'],
  'canvas-photo-prints': ['interior-decor'],

  // Packaging
  'custom-packaging-boxes': ['packaging'],
}

/**
 * Renames applied during migration.
 *
 * The client's new product list uses different names for four products that
 * already exist and already rank. The rule: the NEW NAME is adopted, the OLD
 * SLUG is kept — so the display updates while the indexed URL survives.
 */
export const PRODUCT_RENAMES = {
  'glow-sign-boards': 'Glow Sign Board',
  'rollup-standees': 'Roll-Up Standees',
  'flex-banners': 'Flex Banners',
  'interior-wayfinding-signage': 'Direction Signs',
}
