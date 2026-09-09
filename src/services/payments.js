import crypto from 'node:crypto'
import Razorpay from 'razorpay'
import { env } from '../config/env.js'

/**
 * Razorpay integration.
 *
 * Two rules govern everything here:
 *
 * 1. The AMOUNT sent to Razorpay is computed server-side from the cart, never
 *    taken from the client. A client that could name its own amount could pay
 *    ₹1 for a ₹10,000 order.
 *
 * 2. An order is marked PAID only after the signature is verified with the
 *    key secret. Razorpay's browser callback is not proof of payment on its
 *    own — anyone can POST that endpoint. The HMAC is the proof.
 */

export const isPaymentsConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)

let client = null
if (isPaymentsConfigured) {
  client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET })
}

/** Razorpay works in the smallest currency unit — paise, not rupees. */
export function toPaise(rupees) {
  return Math.round(rupees * 100)
}

export async function createProviderOrder({ amount, receipt, notes }) {
  if (!client) throw new Error('Payments are not configured')
  return client.orders.create({
    amount: toPaise(amount),
    currency: 'INR',
    receipt,
    notes,
    // Razorpay captures automatically; leaving it manual would require a
    // second call and risks funds sitting uncaptured.
    payment_capture: 1,
  })
}

/**
 * Verify the checkout callback signature.
 *
 * HMAC-SHA256 of "<razorpay_order_id>|<razorpay_payment_id>" keyed with the
 * API secret. Compared in constant time so the check cannot be probed by
 * timing.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!env.RAZORPAY_KEY_SECRET) return false
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex')

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(String(signature ?? ''), 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * Verify a webhook payload.
 *
 * The webhook is the reliable path: it fires even when the customer closes
 * the browser mid-redirect, which is exactly when the callback does not
 * arrive and an order would otherwise be stuck unpaid despite the money
 * having moved.
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(String(signature ?? ''), 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function fetchPayment(paymentId) {
  if (!client) throw new Error('Payments are not configured')
  return client.payments.fetch(paymentId)
}
