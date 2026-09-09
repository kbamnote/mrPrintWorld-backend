import { Router } from 'express'
import express from 'express'
import { Order } from '../models/Order.js'
import { verifyWebhookSignature } from '../services/payments.js'
import { env } from '../config/env.js'

export const webhooksRouter = Router()

/**
 * Razorpay webhook.
 *
 * This is the RELIABLE payment path. The browser callback fails whenever the
 * customer closes the tab, loses signal, or the redirect is interrupted mid-
 * flight — precisely the moments when money has moved but nothing has
 * confirmed it. Without this, those orders sit unpaid forever while the
 * customer has been charged.
 *
 * express.raw() is essential: the HMAC is computed over the EXACT bytes
 * Razorpay sent. Letting express.json() parse and re-serialise first changes
 * the bytes and every signature check fails.
 */
webhooksRouter.post(
  '/razorpay',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    const signature = req.headers['x-razorpay-signature']

    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      console.error('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set — rejecting')
      return res.status(503).json({ ok: false })
    }

    // An unverified webhook is just an anonymous POST claiming money arrived.
    if (!verifyWebhookSignature(req.body, signature)) {
      console.warn('Razorpay webhook rejected: bad signature')
      return res.status(400).json({ ok: false })
    }

    let event
    try {
      event = JSON.parse(req.body.toString('utf8'))
    } catch {
      return res.status(400).json({ ok: false })
    }

    try {
      const payment = event.payload?.payment?.entity
      const providerOrderId = payment?.order_id
      if (!providerOrderId) return res.json({ ok: true, ignored: true })

      const order = await Order.findOne({ 'payment.providerOrderId': providerOrderId })
      if (!order) return res.json({ ok: true, ignored: 'unknown order' })

      if (event.event === 'payment.captured') {
        // Idempotent — the browser callback may already have confirmed this,
        // and Razorpay retries webhooks.
        if (order.payment.status !== 'PAID') {
          order.payment.status = 'PAID'
          order.payment.providerPaymentId = payment.id
          order.payment.signatureVerified = true
          order.payment.method = payment.method ?? null
          order.payment.paidAt = new Date()
          order.status = 'PAID'
          order.pushTimeline('PAID', null, `Confirmed by webhook (${payment.id})`)
          await order.save()
        }
      } else if (event.event === 'payment.failed') {
        // Only record a failure if the order is not already paid — a retried
        // failure event must never undo a successful payment.
        if (order.payment.status !== 'PAID') {
          order.payment.status = 'FAILED'
          order.payment.failureReason = payment.error_description ?? 'Payment failed'
          order.status = 'PAYMENT_FAILED'
          order.pushTimeline('PAYMENT_FAILED', null, order.payment.failureReason)
          await order.save()
        }
      }
    } catch (err) {
      // Log, but still 200: a non-2xx makes Razorpay retry, and if our own
      // handler is broken the retries will fail identically.
      console.error('Razorpay webhook handling error:', err)
    }

    res.json({ ok: true })
  },
)
