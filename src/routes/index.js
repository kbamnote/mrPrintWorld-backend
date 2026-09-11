import { Router } from 'express'
import { requireAdmin } from '../middleware/auth.js'

import { publicCategoriesRouter } from './public/categories.js'
import { publicProductsRouter } from './public/products.js'
import { publicPricingRouter } from './public/pricing.js'
import { publicTiersRouter } from './public/tiers.js'
import { customerAuthRouter } from './auth.js'
import { ordersRouter } from './orders.js'
import { resellerRouter } from './reseller.js'
import { publicResellersRouter } from './public/resellers.js'

import { adminAuthRouter } from './admin/auth.js'
import { adminCategoriesRouter } from './admin/categories.js'
import { adminProductsRouter } from './admin/products.js'
import { adminOptionGroupsRouter } from './admin/optionGroups.js'
import { adminUploadsRouter } from './admin/uploads.js'
import { adminCustomersRouter } from './admin/customers.js'
import { adminOrganizationsRouter } from './admin/organizations.js'
import { adminPriceOverridesRouter } from './admin/priceOverrides.js'
import { adminOrdersRouter } from './admin/orders.js'

export const apiRouter = Router()

/* ── Public surface — anonymous, cacheable, never exposes tier pricing ──── */
apiRouter.use('/public/categories', publicCategoriesRouter)
apiRouter.use('/public/products', publicProductsRouter)
apiRouter.use('/public/pricing', publicPricingRouter)
apiRouter.use('/public/tiers', publicTiersRouter)
apiRouter.use('/public/resellers', publicResellersRouter)

/* ── Customer auth — separate surface, separate refresh cookie ─────────── */
apiRouter.use('/auth', customerAuthRouter)

/* ── Reseller programme — the reseller's own dashboard ─────────────────── */
apiRouter.use('/reseller', resellerRouter)

/* ── Cart, checkout and order history ──────────────────────────────────── */
apiRouter.use('/', ordersRouter)

/* ── Admin surface ───────────────────────────────────────────────────────
   Auth is mounted BEFORE the guard (login must be reachable). Everything
   after it is gated once, here, rather than per handler — so a newly added
   admin route cannot accidentally ship unguarded. */
apiRouter.use('/admin/auth', adminAuthRouter)

apiRouter.use('/admin', requireAdmin)
apiRouter.use('/admin/categories', adminCategoriesRouter)
apiRouter.use('/admin/products', adminProductsRouter)
apiRouter.use('/admin/option-groups', adminOptionGroupsRouter)
apiRouter.use('/admin/uploads', adminUploadsRouter)
apiRouter.use('/admin/customers', adminCustomersRouter)
apiRouter.use('/admin/organizations', adminOrganizationsRouter)
apiRouter.use('/admin/price-overrides', adminPriceOverridesRouter)
apiRouter.use('/admin/orders', adminOrdersRouter)
