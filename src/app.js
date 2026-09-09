import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import morgan from 'morgan'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import mongoose from 'mongoose'

import { env } from './config/env.js'
import { apiRouter } from './routes/index.js'
import { attachUser } from './middleware/auth.js'
import { notFound, errorHandler } from './middleware/error.js'

export function createApp() {
  const app = express()

  // Behind Railway/Render/Vercel the client IP arrives in X-Forwarded-For.
  // Without this the rate limiter would bucket every request under the proxy's
  // single address and throttle all users together.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  app.use(helmet())
  app.use(compression())
  app.use(cookieParser())
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))

  app.use(
    cors({
      origin(origin, cb) {
        // No Origin header — curl, server-to-server, the build-time sitemap
        // script. Those are not browser requests, so CORS is not the control.
        if (!origin) return cb(null, true)
        if (env.corsOrigins.includes(origin)) return cb(null, true)
        cb(new Error(`Origin ${origin} is not allowed`))
      },
      credentials: true, // the admin refresh cookie needs this
    }),
  )

  if (!env.isProd) app.use(morgan('dev'))

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // /health is polled by the platform; throttling it causes false alarms.
      skip: (req) => req.path === '/health',
    }),
  )

  app.get('/health', (_req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting']
    res.json({
      ok: true,
      service: 'mrprintworld-backend',
      env: env.NODE_ENV,
      db: states[mongoose.connection.readyState] ?? 'unknown',
      uptime: Math.round(process.uptime()),
    })
  })

  // Resolves req.user when a bearer token is present; anonymous otherwise.
  app.use(attachUser)
  app.use('/api', apiRouter)

  app.use(notFound)
  app.use(errorHandler)

  return app
}
