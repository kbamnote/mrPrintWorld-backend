import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'

/**
 * The reseller's price list as a PDF, made to be forwarded on WhatsApp.
 *
 * Built with the fonts PDFKit ships, so there is nothing to install on the
 * server and the file renders the same everywhere. Those fonts have no rupee
 * sign, so prices read "Rs. 1,500".
 */

const INK = '#14201a'
const SOFT = '#5b6b62'
const LINE = '#dfe5e1'
const BRAND = '#0f5132'

const money = (n) => `Rs. ${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const today = () => new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * A product photo, small enough to keep the file sendable. Cloudinary is
 * asked for a 320px JPEG; anything else is taken as it is and skipped if it
 * is not a JPEG or PNG, which are the formats PDFKit can place.
 */
async function loadPhoto(url) {
  if (!url || !/^https:\/\//i.test(url)) return null
  const source = url.replace(/\/image\/upload\/(?!.*\/image\/upload\/)/, '/image/upload/f_jpg,q_auto:eco,w_320,c_limit/')
  try {
    const res = await fetch(source, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (!/image\/(jpeg|jpg|png)/i.test(type)) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length > 3_000_000 ? null : buffer
  } catch {
    return null // a photo that will not load is simply left out
  }
}

/** Every photo in the catalogue, fetched a few at a time. */
async function loadPhotos(groups) {
  const urls = [...new Set(groups.flatMap((g) => g.items.map((i) => i.image)).filter(Boolean))]
  const photos = new Map()
  for (let i = 0; i < urls.length; i += 6) {
    const batch = urls.slice(i, i + 6)
    const loaded = await Promise.all(batch.map(loadPhoto))
    batch.forEach((url, n) => loaded[n] && photos.set(url, loaded[n]))
  }
  return photos
}

/**
 * @param {object} catalogue  from services/catalogue.js
 * @returns {Promise<Buffer>} the PDF
 */
export async function renderCataloguePdf(catalogue) {
  const { store, groups } = catalogue
  const photos = await loadPhotos(groups)
  const qr = await QRCode.toBuffer(store.url, { margin: 1, width: 300, color: { dark: '#0f5132', light: '#ffffff' } })

  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    bufferPages: true,
    info: { Title: `${store.name} — price list`, Author: store.name },
  })
  const chunks = []
  doc.on('data', (c) => chunks.push(c))
  const finished = new Promise((resolve) => doc.on('end', resolve))

  const left = doc.page.margins.left
  const width = doc.page.width - left - doc.page.margins.right
  const bottom = doc.page.height - doc.page.margins.bottom

  /* ── Cover ──────────────────────────────────────────────────────────── */
  doc.rect(0, 0, doc.page.width, 190).fill(BRAND)
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(30).text(store.name, left, 62, { width: width - 150 })
  doc.font('Helvetica').fontSize(14).text('Price list', { width: width - 150 })
  doc.fontSize(10).fillColor('#d7e6dd').text(today(), { width: width - 150 })

  doc.image(qr, doc.page.width - left - 110, 45, { width: 110 })
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text('Order online', left, 220)
  doc.font('Helvetica').fontSize(10).fillColor(SOFT).text(store.url, { link: store.url, underline: false })
  if (store.phone) doc.text(`WhatsApp / call: ${store.phone}`)
  doc.moveDown(0.8)
  doc.text('Scan the code on this page to open the store and order. Prices below are for the quantity shown.')
  doc.moveDown(0.4)
  doc.text('Prices are exclusive of GST and may change without notice. Design and delivery charges, where they apply, are quoted separately.')

  /* ── Products ───────────────────────────────────────────────────────── */
  const COLUMNS = 2
  const GAP = 16
  const CARD_W = (width - GAP) / COLUMNS
  const CARD_H = 118
  let x = left
  let y = 999999 // forces the first page

  const newPage = () => {
    doc.addPage()
    y = doc.page.margins.top
    x = left
  }
  const heading = (name) => {
    if (y + 40 + CARD_H > bottom) newPage()
    else if (y > doc.page.margins.top) y += 10
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(13).text(name, left, y, { width })
    y = doc.y + 6
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(LINE).stroke()
    y += 10
    x = left
  }

  for (const group of groups) {
    heading(group.name)

    for (const item of group.items) {
      if (y + CARD_H > bottom) {
        newPage()
        doc.fillColor(SOFT).font('Helvetica-Oblique').fontSize(9).text(`${group.name} (continued)`, left, y)
        y = doc.y + 8
      }

      const photo = item.image ? photos.get(item.image) : null
      const boxX = x
      doc.roundedRect(boxX, y, CARD_W, CARD_H - 8, 6).lineWidth(1).strokeColor(LINE).stroke()

      const pad = 10
      const photoSize = CARD_H - 8 - pad * 2
      if (photo) {
        try {
          doc.save()
          doc.roundedRect(boxX + pad, y + pad, photoSize, photoSize, 4).clip()
          doc.image(photo, boxX + pad, y + pad, { cover: [photoSize, photoSize], align: 'center', valign: 'center' })
          doc.restore()
        } catch {
          doc.restore() // an image PDFKit cannot place leaves the space empty
        }
      } else {
        doc.roundedRect(boxX + pad, y + pad, photoSize, photoSize, 4).fillColor('#f1f5f2').fill()
      }

      const textX = boxX + pad * 2 + photoSize
      const textW = CARD_W - (textX - boxX) - pad
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(item.name, textX, y + pad, {
        width: textW,
        height: 26,
        ellipsis: true,
      })
      let rowY = Math.min(doc.y + 2, y + pad + 28)

      if (item.quoteOnly) {
        doc.font('Helvetica').fontSize(9).fillColor(SOFT).text('Price on request', textX, rowY, { width: textW })
      } else {
        for (const row of item.rows.slice(0, 4)) {
          doc.font('Helvetica').fontSize(8.5).fillColor(SOFT).text(row.label, textX, rowY, { width: textW * 0.56, ellipsis: true })
          doc
            .font('Helvetica-Bold')
            .fontSize(9)
            .fillColor(INK)
            .text(money(row.price), textX + textW * 0.56, rowY, { width: textW * 0.44, align: 'right' })
          rowY += 13
        }
        if (item.rows.length > 4) {
          doc.font('Helvetica-Oblique').fontSize(8).fillColor(SOFT).text('more quantities online', textX, rowY, { width: textW })
        }
      }

      if (x === left && COLUMNS > 1) {
        x = left + CARD_W + GAP
      } else {
        x = left
        y += CARD_H
      }
    }
    if (x !== left) {
      x = left
      y += CARD_H
    }
  }

  /* ── Footers ────────────────────────────────────────────────────────── */
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i)
    // Writing below the bottom margin would otherwise start a new page —
    // which is how a three-page catalogue ends up with six blank ones.
    doc.page.margins.bottom = 0
    doc.fillColor(SOFT).font('Helvetica').fontSize(8)
    doc.text(`${store.name} · ${store.url}`, left, bottom + 12, { width: width * 0.7, lineBreak: false })
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width * 0.7, bottom + 12, {
      width: width * 0.3,
      align: 'right',
      lineBreak: false,
    })
  }

  doc.end()
  await finished
  return Buffer.concat(chunks)
}
