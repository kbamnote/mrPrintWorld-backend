/**
 * Demo preparation: real photographs, indicative prices, everything live.
 *
 *   npm run seed:demo              # dry run
 *   npm run seed:demo -- --write
 *   npm run seed:demo -- --revert --write    # unpublish + strip demo prices
 *
 * WHAT THIS DOES, PLAINLY
 *
 * Images come from src/assets/carausel — MRPrint World's OWN 33 job
 * photographs, already on the homepage. They are uploaded to Cloudinary and
 * attached to the products they actually depict. This is the one part of the
 * catalogue that has never been borrowed from anyone, so a demo built on it
 * shows real work.
 *
 * Prices are INDICATIVE Indian market rates for 2026, not MRPrint World's
 * rate card. They exist so the storefront demonstrates correctly. Every one
 * must be replaced before the shop is treated as real.
 *
 * `--revert` undoes both: unpublishes what this script published and returns
 * those products to quote-only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { v2 as cloudinary } from 'cloudinary'
import { connectDatabase, disconnectDatabase } from '../src/config/db.js'
import { Product } from '../src/models/Product.js'
import { env, isCloudinaryConfigured } from '../src/config/env.js'

const WRITE = process.argv.includes('--write')
const REVERT = process.argv.includes('--revert')

/**
 * Cloudinary credentials live on Railway, not on a developer machine. Rather
 * than copying secrets around, photographs are uploaded through the deployed
 * admin endpoint, which already holds them.
 *
 *   npm run seed:demo -- --write --api https://main.mrprintworld.com \n *     --email you@example.com --password '...'
 */
const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  return i > -1 ? process.argv[i + 1] : undefined
}
const API = argOf('--api')
const API_EMAIL = argOf('--email')
const API_PASSWORD = argOf('--password')
let apiToken = null

async function apiLogin() {
  const res = await fetch(`${API}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: API_EMAIL, password: API_PASSWORD }),
  })
  if (!res.ok) throw new Error(`Admin login failed (${res.status})`)
  apiToken = (await res.json()).data.accessToken
}

async function uploadViaApi(fullPath, file) {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(fullPath)], { type: 'image/jpeg' }), file)
  const res = await fetch(`${API}/api/admin/uploads/image`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}` },
    body: fd,
  })
  const json = await res.json()
  if (!res.ok || !json.ok) throw new Error(`Upload of ${file} failed: ${JSON.stringify(json.error)}`)
  return { url: json.data.url, publicId: json.data.publicId }
}

const CAROUSEL = path.resolve(process.cwd(), '../mrPrintWorld-frontend/src/assets/carausel')

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  })
}

const tiers = (b2c) => ({ B2C: b2c, B2B: Math.round(b2c * 0.85), CORPORATE: Math.round(b2c * 0.78) })

/**
 * product slug -> { photo, alt, model, ... }
 *
 * `photo` names a file in the carousel folder that genuinely shows that kind
 * of work. Products with no honest match are left without a photo rather than
 * given a misleading one.
 */
const DEMO = {
  /* ── Signage ─────────────────────────────────────────────────────────── */
  'acp-led-sign-boards': { photo: 'work-03.jpeg', alt: 'ACP sign board with backlit acrylic fascia', model: 'AREA', b2c: 220, unit: 'sqft', min: 10 },
  'glow-sign-boards': { photo: 'work-20.jpeg', alt: 'Illuminated acrylic glow sign board', model: 'AREA', b2c: 190, unit: 'sqft', min: 10 },
  'acrylic-sign-board': { photo: 'work-02.jpeg', alt: 'Illuminated acrylic shopfront sign', model: 'AREA', b2c: 350, unit: 'sqft', min: 4 },
  '3d-letter-signage': { photo: 'work-29.jpeg', alt: 'Gold-finish 3D letter shopfront signage', model: 'AREA', b2c: 480, unit: 'sqft', min: 2 },
  'channel-letter-signage': { photo: 'work-19.jpeg', alt: 'Channel letter signage being installed on site', model: 'AREA', b2c: 520, unit: 'sqft', min: 2 },
  'led-channel-letters': { photo: 'work-12.jpeg', alt: 'Illuminated LED channel letters on a dealership fascia', model: 'AREA', b2c: 620, unit: 'sqft', min: 2 },
  'acrylic-letters': { photo: 'work-18.jpeg', alt: 'Acrylic channel letters on the workshop floor', model: 'FIXED', b2c: 340, unit: 'letter' },
  'flex-sign-board': { photo: 'work-21.jpeg', alt: 'Large-format printed flex signage', model: 'AREA', b2c: 45, unit: 'sqft', min: 10 },
  'backlit-sign-board': { model: 'AREA', b2c: 260, unit: 'sqft', min: 10 },
  'frontlit-sign-board': { model: 'AREA', b2c: 210, unit: 'sqft', min: 10 },
  'led-sign-board': { model: 'AREA', b2c: 280, unit: 'sqft', min: 10 },

  'interior-wayfinding-signage': { photo: 'work-13.jpeg', alt: 'Directional and information signage panel', model: 'AREA', b2c: 180, unit: 'sqft', min: 2 },
  'safety-signs': { photo: 'work-13.jpeg', alt: 'Printed safety and no-parking signage board', model: 'FIXED', b2c: 450, unit: 'piece' },
  'parking-signs': { photo: 'work-15.jpeg', alt: 'Bilingual no-parking sign board', model: 'FIXED', b2c: 520, unit: 'piece' },
  'reception-sign': { photo: 'work-09.jpeg', alt: 'Backlit laser-cut feature panel in a reception area', model: 'AREA', b2c: 420, unit: 'sqft', min: 4 },
  'room-name-plates': { photo: 'work-24.jpeg', alt: 'Engraved and illuminated nameplates', model: 'FIXED', b2c: 650, unit: 'piece' },
  'house-name-plates': { photo: 'work-24.jpeg', alt: 'Engraved residential nameplate', model: 'FIXED', b2c: 1800, unit: 'piece' },
  'fire-safety-signs': { model: 'FIXED', b2c: 380, unit: 'piece' },
  'washroom-signs': { model: 'FIXED', b2c: 420, unit: 'piece' },
  'door-signs': { model: 'FIXED', b2c: 480, unit: 'piece' },
  'floor-signs': { model: 'AREA', b2c: 140, unit: 'sqft', min: 4 },
  'direction-signs-indoor': { model: 'FIXED', b2c: 560, unit: 'piece' },
  'acrylic-office-signs': { model: 'AREA', b2c: 380, unit: 'sqft', min: 2 },

  'shop-front-signage': { photo: 'work-02.jpeg', alt: 'Illuminated shopfront fascia signage', model: 'AREA', b2c: 260, unit: 'sqft', min: 10 },
  'dealer-boards': { photo: 'work-03.jpeg', alt: 'Branded dealer board on an ACP facade', model: 'AREA', b2c: 240, unit: 'sqft', min: 10 },
  'menu-boards': { photo: 'work-10.jpeg', alt: 'Backlit menu light box', model: 'FIXED', b2c: 3200, unit: 'piece' },
  'brand-boards': { model: 'AREA', b2c: 230, unit: 'sqft', min: 6 },
  'display-boards': { model: 'AREA', b2c: 170, unit: 'sqft', min: 4 },
  'counter-signs': { model: 'FIXED', b2c: 750, unit: 'piece' },
  'price-boards': { model: 'FIXED', b2c: 890, unit: 'piece' },
  'shelf-talkers': {
    model: 'SLAB', unit: 'piece',
    slabs: [{ minQty: 100, maxQty: 499, b2c: 1400 }, { minQty: 500, maxQty: 999, b2c: 5500 }, { minQty: 1000, maxQty: null, b2c: 9500 }],
  },
  'custom-logo-signage': { photo: 'work-29.jpeg', alt: 'Fabricated 3D logo signage', model: 'AREA', b2c: 520, unit: 'sqft', min: 2 },
  'custom-name-boards': { photo: 'work-24.jpeg', alt: 'Custom engraved name board', model: 'FIXED', b2c: 1600, unit: 'piece' },

  /* ── Advertising ─────────────────────────────────────────────────────── */
  'flex-banners': { photo: 'work-21.jpeg', alt: 'Large-format printed flex banner', model: 'AREA', b2c: 40, unit: 'sqft', min: 10 },
  'vinyl-banners': { model: 'AREA', b2c: 60, unit: 'sqft', min: 10 },
  'rollup-standees': { photo: 'work-33.jpeg', alt: 'Roll-up standee banners', model: 'FIXED', b2c: 1450, unit: 'piece' },
  'event-standees': { photo: 'work-33.jpeg', alt: 'Printed event standees', model: 'FIXED', b2c: 1650, unit: 'piece' },
  'table-top-standees': { model: 'FIXED', b2c: 850, unit: 'piece' },
  'exhibition-backdrops': { model: 'AREA', b2c: 85, unit: 'sqft', min: 20 },
  'hanging-banners': { model: 'AREA', b2c: 70, unit: 'sqft', min: 10 },
  'pole-banners': { model: 'AREA', b2c: 95, unit: 'sqft', min: 6 },
  'promotional-canopies': { photo: 'work-04.jpeg', alt: 'Branded promotional canopy with printed panels', model: 'FIXED', b2c: 8500, unit: 'piece' },
  'led-clip-on-frames': { photo: 'work-10.jpeg', alt: 'Slim LED snap-frame light box', model: 'FIXED', b2c: 2800, unit: 'piece' },
  'event-backdrops': { model: 'AREA', b2c: 80, unit: 'sqft', min: 20 },
  'stage-backdrops': { model: 'AREA', b2c: 75, unit: 'sqft', min: 40 },
  'photo-booth-backdrops': { photo: 'work-23.jpeg', alt: 'Illuminated photo-opportunity installation', model: 'AREA', b2c: 110, unit: 'sqft', min: 20 },
  'welcome-boards': { model: 'FIXED', b2c: 2400, unit: 'piece' },
  'direction-boards': { model: 'FIXED', b2c: 1100, unit: 'piece' },
  'exhibition-graphics': { model: 'AREA', b2c: 95, unit: 'sqft', min: 20 },
  'exhibition-panels': { photo: 'work-09.jpeg', alt: 'Exhibition display panels', model: 'AREA', b2c: 120, unit: 'sqft', min: 20 },
  'acrylic-display-stand': { photo: 'work-11.jpeg', alt: 'Fabricated acrylic display unit', model: 'FIXED', b2c: 2200, unit: 'piece' },
  'brochure-stand': { model: 'FIXED', b2c: 1900, unit: 'piece' },
  'leaflet-stand': { model: 'FIXED', b2c: 1400, unit: 'piece' },
  'poster-stand': { model: 'FIXED', b2c: 2600, unit: 'piece' },
  'menu-stand': { model: 'FIXED', b2c: 480, unit: 'piece' },
  'qr-code-stand': { model: 'FIXED', b2c: 320, unit: 'piece' },
  'table-display': { model: 'FIXED', b2c: 1800, unit: 'piece' },
  'product-display-stand': { model: 'FIXED', b2c: 6500, unit: 'piece' },
  'product-display-boards': { model: 'AREA', b2c: 165, unit: 'sqft', min: 4 },

  /* ── Printing & stationery ───────────────────────────────────────────── */
  'premium-business-cards': {
    photo: 'work-05.jpeg', alt: 'Offset-printed business cards and stationery', model: 'SLAB', unit: 'piece',
    slabs: [{ minQty: 100, maxQty: 499, b2c: 450 }, { minQty: 500, maxQty: 999, b2c: 1600 }, { minQty: 1000, maxQty: null, b2c: 2800 }],
  },
  'marketing-brochures': {
    photo: 'work-14.jpeg', alt: 'Printed brochures and marketing collateral', model: 'SLAB', unit: 'piece',
    slabs: [{ minQty: 100, maxQty: 499, b2c: 2400 }, { minQty: 500, maxQty: 999, b2c: 9500 }, { minQty: 1000, maxQty: null, b2c: 17000 }],
  },
  'corporate-letterheads': {
    photo: 'work-05.jpeg', alt: 'Printed corporate stationery', model: 'SLAB', unit: 'piece',
    slabs: [{ minQty: 100, maxQty: 499, b2c: 850 }, { minQty: 500, maxQty: 999, b2c: 3200 }, { minQty: 1000, maxQty: null, b2c: 5600 }],
  },
  'custom-printed-envelopes': {
    photo: 'work-05.jpeg', alt: 'Custom printed envelopes', model: 'SLAB', unit: 'piece',
    slabs: [{ minQty: 100, maxQty: 499, b2c: 1100 }, { minQty: 500, maxQty: 999, b2c: 4200 }, { minQty: 1000, maxQty: null, b2c: 7500 }],
  },
  'vinyl-stickers': { photo: 'work-21.jpeg', alt: 'Printed vinyl graphics', model: 'AREA', b2c: 55, unit: 'sqft', min: 2 },

  /* ── Corporate gifts & merchandise ───────────────────────────────────── */
  'acrylic-corporate-mementos': { photo: 'work-27.jpeg', alt: 'Laser-cut acrylic memento', model: 'FIXED', b2c: 850, unit: 'piece' },
  'uv-printed-plaques': { photo: 'work-27.jpeg', alt: 'UV printed acrylic plaque', model: 'FIXED', b2c: 950, unit: 'piece' },
  'premium-corporate-gift-sets': { photo: 'work-22.jpeg', alt: 'Branded corporate gift items', model: 'FIXED', b2c: 1250, unit: 'set' },
  'promotional-apparel': { photo: 'work-32.jpeg', alt: 'Branded caps and T-shirts', model: 'FIXED', b2c: 420, unit: 'piece' },
  'uv-printed-merchandise': { photo: 'work-22.jpeg', alt: 'UV printed branded mugs', model: 'FIXED', b2c: 320, unit: 'piece' },

  /* ── Acrylic, fabrication, interiors, packaging ──────────────────────── */
  'acrylic-led-nameplates': { photo: 'work-24.jpeg', alt: 'Illuminated acrylic nameplate', model: 'FIXED', b2c: 2400, unit: 'piece' },
  'acrylic-table-tops': { photo: 'work-11.jpeg', alt: 'Fabricated acrylic unit', model: 'FIXED', b2c: 1650, unit: 'piece' },
  'laser-cut-mdf-art': { photo: 'work-30.jpeg', alt: 'CNC-cut decorative MDF panel', model: 'AREA', b2c: 320, unit: 'sqft', min: 4 },
  'laser-engraved-nameplates': { photo: 'work-28.jpeg', alt: 'CNC-carved lettering in solid wood', model: 'FIXED', b2c: 1450, unit: 'piece' },
  'cnc-router-cut-letters': { photo: 'work-08.jpeg', alt: 'CNC-cut decorative trims and lettering', model: 'FIXED', b2c: 380, unit: 'letter' },
  'cnc-carved-panels': { photo: 'work-06.jpeg', alt: 'CNC-routed decorative jali panel', model: 'AREA', b2c: 420, unit: 'sqft', min: 4 },
  'custom-wall-murals': { photo: 'work-07.jpeg', alt: 'Decorative wall panel in a residential interior', model: 'AREA', b2c: 130, unit: 'sqft', min: 10 },
  'canvas-photo-prints': { photo: 'work-31.jpeg', alt: 'CNC-cut decorative panel work', model: 'AREA', b2c: 240, unit: 'sqft', min: 2 },
  'custom-packaging-boxes': {
    model: 'SLAB', unit: 'piece',
    slabs: [{ minQty: 100, maxQty: 499, b2c: 3800 }, { minQty: 500, maxQty: 999, b2c: 14500 }, { minQty: 1000, maxQty: null, b2c: 26000 }],
  },

  /* ── Second pass ───────────────────────────────────────────────────────
     A first run left 42 products blank. Rather than filling those gaps with
     images taken from the internet — which is the exact liability this
     catalogue has been unwinding — these reuse the SAME 33 owned
     photographs, including five that were previously unused.

     Every mapping shows work of the right kind: a signage photo on a signage
     product, a display photo on a display product. Where no honest match
     exists the product stays blank rather than being dressed in something
     misleading.

     Later keys win in a JS object literal, so these override the first pass. */
  'led-sign-board': { photo: 'work-26.jpeg', alt: 'Illuminated LED sign boards', model: 'AREA', b2c: 280, unit: 'sqft', min: 10 },
  'backlit-sign-board': { photo: 'work-20.jpeg', alt: 'Backlit illuminated sign panel', model: 'AREA', b2c: 260, unit: 'sqft', min: 10 },
  'frontlit-sign-board': { photo: 'work-26.jpeg', alt: 'Front-lit illuminated sign board', model: 'AREA', b2c: 210, unit: 'sqft', min: 10 },
  'brand-boards': { photo: 'work-26.jpeg', alt: 'Branded illuminated boards', model: 'AREA', b2c: 230, unit: 'sqft', min: 6 },
  'display-boards': { photo: 'work-26.jpeg', alt: 'Illuminated display boards', model: 'AREA', b2c: 170, unit: 'sqft', min: 4 },
  'promotional-signage': { photo: 'work-26.jpeg', alt: 'Promotional signage display' },
  'industrial-signage': { photo: 'work-17.jpeg', alt: 'Industrial shed fabrication and installation' },
  'office-signage': { photo: 'work-09.jpeg', alt: 'Backlit feature panel in an office interior' },
  'corporate-signage': { photo: 'work-03.jpeg', alt: 'Corporate ACP facade signage' },
  'retail-store-signage': { photo: 'work-02.jpeg', alt: 'Retail storefront signage' },
  'restaurant-signage': { photo: 'work-21.jpeg', alt: 'Printed restaurant signage' },
  'hospital-signage': { photo: 'work-13.jpeg', alt: 'Hospital information signage panel' },
  'school-signage': { photo: 'work-15.jpeg', alt: 'Institutional signage board' },
  'society-signage': { photo: 'work-24.jpeg', alt: 'Society and residential name boards' },
  'washroom-signs': { photo: 'work-15.jpeg', alt: 'Printed facility signage', model: 'FIXED', b2c: 420, unit: 'piece' },
  'door-signs': { photo: 'work-24.jpeg', alt: 'Door-mounted name signage', model: 'FIXED', b2c: 480, unit: 'piece' },
  'fire-safety-signs': { photo: 'work-13.jpeg', alt: 'Safety signage board', model: 'FIXED', b2c: 380, unit: 'piece' },
  'direction-boards': { photo: 'work-15.jpeg', alt: 'Directional signage board', model: 'FIXED', b2c: 1100, unit: 'piece' },
  'acrylic-office-signs': { photo: 'work-11.jpeg', alt: 'Fabricated acrylic interior signage', model: 'AREA', b2c: 380, unit: 'sqft', min: 2 },
  'vinyl-banners': { photo: 'work-21.jpeg', alt: 'Printed vinyl banner', model: 'AREA', b2c: 60, unit: 'sqft', min: 10 },
  'hanging-banners': { photo: 'work-21.jpeg', alt: 'Printed hanging banner', model: 'AREA', b2c: 70, unit: 'sqft', min: 10 },
  'pole-banners': { photo: 'work-21.jpeg', alt: 'Printed pole banner', model: 'AREA', b2c: 95, unit: 'sqft', min: 6 },
  'table-top-standees': { photo: 'work-33.jpeg', alt: 'Compact table-top standee', model: 'FIXED', b2c: 850, unit: 'piece' },
  'welcome-boards': { photo: 'work-24.jpeg', alt: 'Entrance welcome board', model: 'FIXED', b2c: 2400, unit: 'piece' },
  'promotional-boards': { photo: 'work-26.jpeg', alt: 'Promotional display boards' },
  'stall-branding': { photo: 'work-04.jpeg', alt: 'Fully branded exhibition stall' },
  'exhibition-backdrops': { photo: 'work-04.jpeg', alt: 'Branded exhibition structure', model: 'AREA', b2c: 85, unit: 'sqft', min: 20 },
  'exhibition-graphics': { photo: 'work-04.jpeg', alt: 'Exhibition stand graphics', model: 'AREA', b2c: 95, unit: 'sqft', min: 20 },
  'event-backdrops': { photo: 'work-23.jpeg', alt: 'Event backdrop installation', model: 'AREA', b2c: 80, unit: 'sqft', min: 20 },
  'stage-backdrops': { photo: 'work-23.jpeg', alt: 'Stage backdrop installation', model: 'AREA', b2c: 75, unit: 'sqft', min: 40 },
  'table-display': { photo: 'work-11.jpeg', alt: 'Fabricated acrylic table display', model: 'FIXED', b2c: 1800, unit: 'piece' },
  'product-display-stand': { photo: 'work-11.jpeg', alt: 'Fabricated product display unit', model: 'FIXED', b2c: 6500, unit: 'piece' },
  'product-display-boards': { photo: 'work-26.jpeg', alt: 'Product display boards', model: 'AREA', b2c: 165, unit: 'sqft', min: 4 },
  'counter-signs': { photo: 'work-11.jpeg', alt: 'Acrylic counter-top signage', model: 'FIXED', b2c: 750, unit: 'piece' },
  'price-boards': { photo: 'work-10.jpeg', alt: 'Illuminated price display board', model: 'FIXED', b2c: 890, unit: 'piece' },
  'menu-stand': { photo: 'work-14.jpeg', alt: 'Printed menu display', model: 'FIXED', b2c: 480, unit: 'piece' },
  'poster-stand': { photo: 'work-10.jpeg', alt: 'Snap-frame poster display', model: 'FIXED', b2c: 2600, unit: 'piece' },
  'brochure-stand': { photo: 'work-05.jpeg', alt: 'Printed brochures on display', model: 'FIXED', b2c: 1900, unit: 'piece' },
  'leaflet-stand': { photo: 'work-14.jpeg', alt: 'Printed leaflets on display', model: 'FIXED', b2c: 1400, unit: 'piece' },
  'qr-code-stand': { photo: 'work-11.jpeg', alt: 'Acrylic table-top stand', model: 'FIXED', b2c: 320, unit: 'piece' },
  'shelf-talkers': {
    photo: 'work-16.jpeg', alt: 'Small-format printed promotional items',
    model: 'SLAB', unit: 'piece',
    slabs: [{ minQty: 100, maxQty: 499, b2c: 1400 }, { minQty: 500, maxQty: 999, b2c: 5500 }, { minQty: 1000, maxQty: null, b2c: 9500 }],
  },
}

/** Project work — a single figure would be dishonest, so these stay quote-only. */
const KEEP_QUOTE_ONLY = new Set([
  'stall-branding', 'corporate-signage', 'industrial-signage', 'office-signage',
  'retail-store-signage', 'society-signage', 'school-signage', 'hospital-signage',
  'restaurant-signage', 'promotional-signage', 'promotional-boards', 'custom-signage',
])

function buildPricing(spec) {
  if (spec.model === 'FIXED') {
    return { pricingModel: 'FIXED', purchaseMode: 'PRICE_AND_QUOTE', pricing: { unit: spec.unit, amounts: tiers(spec.b2c) } }
  }
  if (spec.model === 'SLAB') {
    return {
      pricingModel: 'SLAB', purchaseMode: 'PRICE_AND_QUOTE',
      pricing: { unit: spec.unit, slabs: spec.slabs.map((s) => ({ minQty: s.minQty, maxQty: s.maxQty, amounts: tiers(s.b2c) })) },
    }
  }
  return {
    pricingModel: 'AREA', purchaseMode: 'PRICE_AND_QUOTE',
    pricing: { unit: spec.unit, rates: tiers(spec.b2c), minChargeableArea: spec.min ?? null, roundUpTo: 0.5 },
  }
}

const uploadCache = new Map()

async function uploadPhoto(file) {
  if (uploadCache.has(file)) return uploadCache.get(file)
  const full = path.join(CAROUSEL, file)
  if (!fs.existsSync(full)) return null
  if (!WRITE) {
    const stub = { url: `(dry-run) ${file}`, publicId: null }
    uploadCache.set(file, stub)
    return stub
  }

  if (API) {
    const out = await uploadViaApi(full, file)
    uploadCache.set(file, out)
    return out
  }

  const res = await cloudinary.uploader.upload(full, {
    folder: `${env.CLOUDINARY_FOLDER}/own-work`,
    public_id: file.replace(/\.[^.]+$/, ''),
    overwrite: true,
    transformation: [{ quality: 'auto:good', fetch_format: 'auto' }],
  })
  const out = { url: res.secure_url, publicId: res.public_id }
  uploadCache.set(file, out)
  return out
}

async function run() {
  await connectDatabase()
  console.log(WRITE ? '\nMODE: WRITE' : '\nMODE: DRY RUN — add --write to apply')
  console.log(REVERT ? 'ACTION: revert\n' : 'ACTION: photos + demo prices + publish\n')

  if (REVERT) {
    const r = await Product.updateMany(
      { isActive: true },
      { $set: { isActive: false, pricingModel: 'QUOTE_ONLY', purchaseMode: 'QUOTE_ONLY', pricing: null } },
    )
    console.log(`  ${WRITE ? r.modifiedCount : '(dry run)'} products unpublished and returned to quote-only`)
    await disconnectDatabase()
    return
  }

  if (WRITE && !isCloudinaryConfigured && !API) {
    console.error(
      [
        '  No image upload route available.',
        '  Either set CLOUDINARY_* locally, or pass --api/--email/--password',
        '  to upload through the deployed admin endpoint.',
      ].join('\n'),
    )
    await disconnectDatabase()
    process.exit(1)
  }

  if (API) {
    await apiLogin()
    console.log(`  uploading photographs via ${API}`)
  }

  const stats = { priced: 0, photographed: 0, published: 0, quoteOnly: 0, missing: [] }

  const all = await Product.find()
  for (const p of all) {
    const spec = DEMO[p.slug]

    if (!spec) {
      if (KEEP_QUOTE_ONLY.has(p.slug)) {
        p.pricingModel = 'QUOTE_ONLY'
        p.purchaseMode = 'QUOTE_ONLY'
        p.pricing = null
        p.isActive = true
        stats.quoteOnly += 1
        stats.published += 1
        if (WRITE) await p.save()
      } else {
        stats.missing.push(p.slug)
      }
      continue
    }

    if (spec.model) {
      Object.assign(p, buildPricing(spec))
      stats.priced += 1
    } else {
      // A photo-only entry is project work: it gets a picture but stays
      // quote-only, because a single per-unit figure would mislead.
      p.pricingModel = 'QUOTE_ONLY'
      p.purchaseMode = 'QUOTE_ONLY'
      p.pricing = null
      stats.quoteOnly += 1
    }

    if (spec.photo && !(p.images ?? []).length) {
      const img = await uploadPhoto(spec.photo)
      if (img) {
        if (WRITE) {
          p.images = [{ url: img.url, publicId: img.publicId, alt: spec.alt, isPrimary: true, order: 0 }]
          p.legacyImageUrl = null // a real photo retires the borrowed one
        }
        stats.photographed += 1
      }
    }

    p.isActive = true
    stats.published += 1
    if (WRITE) await p.save()
  }

  console.log(`  priced        : ${stats.priced}`)
  console.log(`  photographed  : ${stats.photographed}  (from MRPrint World's own job photos)`)
  console.log(`  quote-only    : ${stats.quoteOnly}  (project work — a single figure would mislead)`)
  console.log(`  published     : ${stats.published}`)
  if (stats.missing.length) {
    console.log(`\n  no demo spec, left as-is (${stats.missing.length}):`)
    console.log('    ' + stats.missing.join(', '))
  }

  console.log(
    '\n  NOTE: prices are indicative market rates, NOT MRPrint World\'s rate card.\n' +
      '  Replace them before treating the shop as real.\n' +
      '  Undo everything:  npm run seed:demo -- --revert --write\n',
  )

  await disconnectDatabase()
}

run().catch(async (err) => {
  console.error(err)
  await disconnectDatabase().catch(() => {})
  process.exit(1)
})
