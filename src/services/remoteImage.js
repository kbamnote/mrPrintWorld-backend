import { v2 as cloudinary } from 'cloudinary'
import { env, isCloudinaryConfigured } from '../config/env.js'

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  })
}

/**
 * A photo link as pasted into the bulk Excel, turned into one that returns the
 * image itself — Google Drive and Dropbox share links open a viewer page, not
 * the file. Null when it is not a web link at all.
 */
export function directImageLink(link) {
  let url
  try {
    url = new URL(String(link).trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  if (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com') {
    const id = url.pathname.match(/\/d\/([\w-]{10,})/)?.[1] ?? url.searchParams.get('id')
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`
  }
  if (url.hostname === 'dropbox.com' || url.hostname.endsWith('.dropbox.com')) {
    url.searchParams.delete('dl')
    url.searchParams.set('raw', '1')
  }
  return url.toString()
}

/** A link to a photo already in our own image storage — added as it is, not copied again. */
export function isOwnImage(link) {
  return Boolean(env.CLOUDINARY_CLOUD_NAME) && String(link).startsWith(`https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/`)
}

/**
 * Copies a photo from a link into our image storage.
 *
 * Cloudinary fetches the link, not this server, so a link typed into a
 * spreadsheet can never be used to reach addresses inside our own network.
 * Errors read as the end of a sentence: "Image 2 could not be found…".
 */
export async function importRemoteImage(link) {
  if (!isCloudinaryConfigured) throw new Error('could not be copied — image uploads are not configured on the server')
  const source = directImageLink(link)
  if (!source) throw new Error('is not a web link')

  try {
    const out = await cloudinary.uploader.upload(source, {
      folder: env.CLOUDINARY_FOLDER,
      resource_type: 'image',
      transformation: [{ quality: 'auto:good', fetch_format: 'auto' }],
      timeout: 60_000,
    })
    return { url: out.secure_url, publicId: out.public_id }
  } catch (err) {
    const message = String(err?.message ?? err?.error?.message ?? '')
    if (/not found|404/i.test(message)) throw new Error('could not be found — check the link')
    if (/invalid image|unsupported|not an image/i.test(message)) {
      throw new Error('is not a photo — if it is on Google Drive, share it with "Anyone with the link"')
    }
    throw new Error(`could not be copied${message ? ` (${message})` : ''}`)
  }
}

/** Best-effort removal of photos copied for a product that then failed to save. */
export async function removeImportedImages(publicIds) {
  if (!isCloudinaryConfigured || !publicIds.length) return
  await Promise.allSettled(publicIds.map((id) => cloudinary.uploader.destroy(id)))
}

/**
 * Stores a generated file (a reseller's catalogue PDF) and returns a link
 * anyone can open — it is meant to be forwarded on WhatsApp.
 */
export async function uploadFile(buffer, { folder, publicId, contentType = 'application/pdf' }) {
  if (!isCloudinaryConfigured) throw new Error('File storage is not configured on the server')
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `${env.CLOUDINARY_FOLDER}/${folder}`,
        public_id: publicId,
        resource_type: 'raw',
        overwrite: true,
        content_type: contentType,
      },
      (err, out) => (err ? reject(new Error(err.message ?? 'Could not store the file')) : resolve({ url: out.secure_url, publicId: out.public_id })),
    )
    stream.end(buffer)
  })
}

/** Removes a stored file — used when a catalogue is replaced by a newer one. */
export async function removeFile(publicId) {
  if (!isCloudinaryConfigured || !publicId) return
  await Promise.allSettled([cloudinary.uploader.destroy(publicId, { resource_type: 'raw' })])
}
