import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import { paperTile, bandTile, TILE_SIZE } from './pdfTexture.js'

/**
 * The reseller's price list as a PDF, made to be forwarded on WhatsApp.
 *
 * Built with the fonts PDFKit ships, so there is nothing to install on the
 * server and the file renders the same everywhere. Those fonts have no rupee
 * sign, so prices read "Rs. 1,500".
 *
 * A cover with a QR code to the store, then one card per product — photo,
 * name, and a small price table — grouped under category headings.
 */

const BRAND = '#0f5132'
const BRAND_SOFT = '#eaf3ed'
const INK = '#16231d'
const SOFT = '#6b7a72'
const LINE = '#e1e8e3'
const PAPER = '#f7f9f8'

// Whole rupees where the price is whole, paise in full where it is not:
// "Rs. 1,500" and "Rs. 5,142.50", never "Rs. 5,142.5".
const money = (n) =>
  `Rs. ${Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
const today = () => new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * A product photo, small enough to keep the file sendable. Cloudinary is
 * asked for a small JPEG; anything else is taken as it is and skipped if it
 * is not a JPEG or PNG, which are the formats PDFKit can place.
 */
async function loadPhoto(url) {
  if (!url || !/^https:\/\//i.test(url)) return null
  // Small on purpose: the photo is printed at about 78pt, and a catalogue of
  // several hundred products has to stay light enough to send on WhatsApp.
  const source = url.replace(/\/image\/upload\/(?!.*\/image\/upload\/)/, '/image/upload/f_jpg,q_auto:eco,w_200,c_limit/')
  try {
    const res = await fetch(source, { signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    if (!/image\/(jpeg|jpg|png)/i.test(type)) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    return buffer.length > 3_000_000 ? null : buffer
  } catch {
    return null // a photo that will not load is simply left out
  }
}

/** Every photo in the catalogue, fetched a dozen at a time. */
async function loadPhotos(groups) {
  const urls = [...new Set(groups.flatMap((g) => g.items.map((i) => i.image)).filter(Boolean))]
  const photos = new Map()
  for (let i = 0; i < urls.length; i += 12) {
    const batch = urls.slice(i, i + 12)
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
  const qr = await QRCode.toBuffer(store.url, { margin: 0, width: 320, color: { dark: BRAND, light: '#ffffff' } })

  const MARGIN = 36
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    bufferPages: true,
    info: { Title: `${store.name} — price list`, Author: store.name },
  })
  const chunks = []
  doc.on('data', (c) => chunks.push(c))
  const finished = new Promise((resolve) => doc.on('end', resolve))

  const PAGE_W = doc.page.width
  const PAGE_H = doc.page.height
  const W = PAGE_W - MARGIN * 2
  const TOP = MARGIN + 22 // below the running header
  const BOTTOM = PAGE_H - MARGIN - 20 // above the footer

  const GAP = 14
  const CARD_W = (W - GAP) / 2
  const CARD_H = 100
  const PAD = 10
  const PHOTO = CARD_H - PAD * 2

  /**
   * The paper texture, laid before anything else on every page — one small
   * tile placed repeatedly, so it is embedded once for the whole file.
   */
  const tile = (image, x0, y0, x1, y1) => {
    for (let ty = y0; ty < y1; ty += TILE_SIZE) {
      for (let tx = x0; tx < x1; tx += TILE_SIZE) {
        doc.image(image, tx, ty, { width: TILE_SIZE, height: TILE_SIZE })
      }
    }
  }
  // openImage() embeds the tile ONCE. Passing the buffer to image() instead
  // embeds a fresh copy on every placement — a megabyte of identical tiles.
  const paper = doc.openImage(paperTile())
  const paintPaper = () => tile(paper, 0, 0, PAGE_W, PAGE_H)
  doc.on('pageAdded', paintPaper)
  paintPaper() // the first page exists before the listener could fire

  /* ── Cover ──────────────────────────────────────────────────────────── */
  doc.save()
  doc.rect(0, 0, PAGE_W, 232).clip()
  tile(doc.openImage(bandTile()), 0, 0, PAGE_W, 232)
  doc.restore()

  const qrBox = 128
  const qrX = PAGE_W - MARGIN - qrBox
  doc.roundedRect(qrX, 52, qrBox, qrBox + 24, 10).fill('#ffffff')
  doc.image(qr, qrX + 14, 66, { width: qrBox - 28 })
  doc
    .fillColor(BRAND)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text('SCAN TO ORDER', qrX, 52 + qrBox + 4, { width: qrBox, align: 'center', characterSpacing: 0.6 })

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(28).text(store.name, MARGIN, 74, { width: W - qrBox - 30 })
  doc
    .font('Helvetica')
    .fontSize(13)
    .fillColor('#cfe3d7')
    .text('Product catalogue & price list', { width: W - qrBox - 30 })
  doc.fontSize(10).text(today(), { width: W - qrBox - 30 })

  let y = 262
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text('Order online', MARGIN, y)
  doc.font('Helvetica').fontSize(10).fillColor(BRAND).text(store.url, MARGIN, doc.y + 2, { link: store.url, width: W * 0.55 })
  if (store.phone) doc.fillColor(SOFT).text(`WhatsApp / call ${store.phone}`, MARGIN, doc.y + 2)
  doc
    .fillColor(SOFT)
    .fontSize(9.5)
    .text('Scan the code above, or open the link, to see every product and place an order.', MARGIN, doc.y + 6, {
      width: W * 0.55,
    })

  // What is inside, so a customer can find what they want quickly.
  const listX = MARGIN + W * 0.6
  const listW = W * 0.4
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text('Inside this catalogue', listX, y, { width: listW })
  let listY = doc.y + 6
  for (const group of groups.slice(0, 14)) {
    doc.font('Helvetica').fontSize(9).fillColor(SOFT).text(group.name, listX, listY, {
      width: listW - 42,
      height: 11,
      ellipsis: true,
    })
    doc.fillColor(INK).text(String(group.items.length), listX + listW - 40, listY, { width: 40, align: 'right' })
    listY += 13
  }
  if (groups.length > 14) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(SOFT).text(`+ ${groups.length - 14} more categories`, listX, listY, { width: listW })
  }

  // How to order, so a customer who has only been sent the file knows what to do.
  const stepsY = Math.max(listY + 26, 430)
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text('How to order', MARGIN, stepsY)
  const steps = [
    ['1', 'Choose', 'Pick the products and the quantity you need from this list.'],
    ['2', 'Tell us', 'Send us the product name and quantity on WhatsApp, or scan the code.'],
    ['3', 'Approve', 'We share a proof for your approval, then print and deliver.'],
  ]
  const stepW = (W - 20) / 3
  steps.forEach(([number, title, body], i) => {
    const sx = MARGIN + i * (stepW + 10)
    const sy = stepsY + 22
    doc.roundedRect(sx, sy, stepW, 76, 8).fillAndStroke('#ffffff', LINE)
    doc.circle(sx + 22, sy + 22, 11).fill(BRAND_SOFT)
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10).text(number, sx + 12, sy + 18, { width: 20, align: 'center' })
    doc.fillColor(INK).fontSize(10).text(title, sx + 40, sy + 17, { width: stepW - 52 })
    doc.fillColor(SOFT).font('Helvetica').fontSize(8.5).text(body, sx + 14, sy + 42, { width: stepW - 28, lineGap: 1.5 })
  })

  const noteY = stepsY + 118
  doc.roundedRect(MARGIN, noteY, W, 58, 8).fill(PAPER)
  doc
    .fillColor(SOFT)
    .font('Helvetica')
    .fontSize(9)
    .text(
      `${catalogue.productCount} products · prices as on ${today()}\n` +
        'Prices are exclusive of GST and may change without notice. Design, delivery and installation, where they apply, are quoted separately.',
      MARGIN + 14,
      noteY + 14,
      { width: W - 28, lineGap: 3 },
    )

  /* ── Products ───────────────────────────────────────────────────────── */
  let x = MARGIN
  y = BOTTOM + 1 // forces a page break before the first card

  const newPage = () => {
    doc.addPage()
    y = TOP
    x = MARGIN
  }

  /** A category band, carried over with "(continued)" when it spans pages. */
  const band = (name, count, continued = false) => {
    if (y + 34 + CARD_H > BOTTOM) newPage()
    else if (y > TOP) y += 12
    doc.roundedRect(MARGIN, y, W, 24, 6).fill(BRAND_SOFT)
    doc
      .fillColor(BRAND)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(continued ? `${name} (continued)` : name, MARGIN + 12, y + 7, { width: W - 90, height: 13, ellipsis: true })
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(BRAND)
      .text(`${count} product${count === 1 ? '' : 's'}`, MARGIN + W - 90, y + 8, { width: 78, align: 'right' })
    y += 34
    x = MARGIN
  }

  const card = (item) => {
    doc.roundedRect(x, y, CARD_W, CARD_H, 8).fillAndStroke('#ffffff', LINE)

    const photo = item.image ? photos.get(item.image) : null
    if (photo) {
      try {
        doc.save()
        doc.roundedRect(x + PAD, y + PAD, PHOTO, PHOTO, 6).clip()
        doc.image(photo, x + PAD, y + PAD, { cover: [PHOTO, PHOTO], align: 'center', valign: 'center' })
        doc.restore()
      } catch {
        doc.restore() // an image PDFKit cannot place leaves the space empty
      }
      doc.roundedRect(x + PAD, y + PAD, PHOTO, PHOTO, 6).lineWidth(0.5).stroke(LINE)
    } else {
      doc.roundedRect(x + PAD, y + PAD, PHOTO, PHOTO, 6).fill(PAPER)
    }

    const textX = x + PAD * 2 + PHOTO
    const textW = CARD_W - (textX - x) - PAD
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(item.name, textX, y + PAD + 1, {
      width: textW,
      height: 23,
      ellipsis: true,
      lineGap: 1,
    })

    let rowY = y + PAD + 26
    if (item.quoteOnly) {
      doc.roundedRect(textX, rowY, 84, 15, 7).fill(PAPER)
      doc.fillColor(SOFT).font('Helvetica').fontSize(8).text('Price on request', textX, rowY + 4, { width: 84, align: 'center' })
      return
    }

    const rows = item.rows.slice(0, 4)
    rows.forEach((row, i) => {
      if (i > 0) {
        doc.moveTo(textX, rowY - 2).lineTo(textX + textW, rowY - 2).lineWidth(0.4).stroke(LINE)
      }
      doc.font('Helvetica').fontSize(8.5).fillColor(SOFT).text(row.label, textX, rowY, {
        width: textW * 0.5,
        height: 10,
        ellipsis: true,
      })
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(INK)
        .text(money(row.price), textX + textW * 0.5, rowY - 0.5, { width: textW * 0.5, align: 'right' })
      rowY += 14
    })
    if (item.rows.length > rows.length) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(7.5)
        .fillColor(SOFT)
        .text(`+ ${item.rows.length - rows.length} more quantities online`, textX, rowY, { width: textW })
    }
  }

  for (const group of groups) {
    band(group.name, group.items.length)

    for (const item of group.items) {
      if (y + CARD_H > BOTTOM) {
        newPage()
        band(group.name, group.items.length, true)
      }
      card(item)

      if (x === MARGIN) {
        x = MARGIN + CARD_W + GAP
      } else {
        x = MARGIN
        y += CARD_H + GAP
      }
    }
    if (x !== MARGIN) {
      x = MARGIN
      y += CARD_H + GAP
    }
  }

  /* ── Running header and footer ──────────────────────────────────────── */
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i)
    // Writing below the bottom margin would otherwise start a new page —
    // which is how a three-page catalogue ends up with six blank ones.
    doc.page.margins.bottom = 0
    const first = i === range.start

    if (!first) {
      doc.fillColor(SOFT).font('Helvetica-Bold').fontSize(8).text(store.name, MARGIN, MARGIN - 6, {
        width: W * 0.6,
        lineBreak: false,
      })
      doc.font('Helvetica').text(`Price list · ${today()}`, MARGIN + W * 0.6, MARGIN - 6, {
        width: W * 0.4,
        align: 'right',
        lineBreak: false,
      })
      doc.moveTo(MARGIN, MARGIN + 6).lineTo(MARGIN + W, MARGIN + 6).lineWidth(0.5).stroke(LINE)
    }

    doc.moveTo(MARGIN, PAGE_H - MARGIN - 12).lineTo(MARGIN + W, PAGE_H - MARGIN - 12).lineWidth(0.5).stroke(LINE)
    doc.fillColor(SOFT).font('Helvetica').fontSize(8)
    doc.text(`${store.name} · ${store.url}`, MARGIN, PAGE_H - MARGIN - 6, { width: W * 0.7, lineBreak: false })
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN + W * 0.7, PAGE_H - MARGIN - 6, {
      width: W * 0.3,
      align: 'right',
      lineBreak: false,
    })
  }

  doc.end()
  await finished
  return Buffer.concat(chunks)
}
