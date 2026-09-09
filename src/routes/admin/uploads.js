import { Router } from 'express'
import multer from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { z } from 'zod'
import { env, isCloudinaryConfigured } from '../../config/env.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'

export const adminUploadsRouter = Router()

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  })
}

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']

// Memory storage: the buffer goes straight to Cloudinary and is never written
// to the server's disk, so there is no temp file to clean up or leak.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED.includes(file.mimetype)) {
      return cb(new ApiError(415, `Unsupported type ${file.mimetype}. Use JPEG, PNG, WebP or AVIF.`))
    }
    cb(null, true)
  },
})

/** Guard so a missing credential produces a clear 503, not an SDK stack trace. */
function requireCloudinary(_req, _res, next) {
  if (!isCloudinaryConfigured) {
    return next(
      ApiError.serviceUnavailable(
        'Image uploads are not configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.',
      ),
    )
  }
  next()
}

adminUploadsRouter.post(
  '/image',
  requireCloudinary,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file received — send it as multipart field "file"')

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: env.CLOUDINARY_FOLDER,
          resource_type: 'image',
          // Strip EXIF and normalise: product photos carry no useful metadata
          // and sometimes carry GPS coordinates from a phone camera.
          transformation: [{ quality: 'auto:good', fetch_format: 'auto' }],
        },
        (err, out) => (err ? reject(err) : resolve(out)),
      )
      stream.end(req.file.buffer)
    })

    res.status(201).json({
      ok: true,
      data: {
        url: result.secure_url,
        publicId: result.public_id,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        format: result.format,
      },
    })
  }),
)

adminUploadsRouter.delete(
  '/image',
  requireCloudinary,
  validate({ body: z.object({ publicId: z.string().trim().min(1).max(300) }).strict() }),
  asyncHandler(async (req, res) => {
    const result = await cloudinary.uploader.destroy(req.validatedBody.publicId)
    if (result.result !== 'ok' && result.result !== 'not found') {
      throw ApiError.badRequest(`Cloudinary refused the delete: ${result.result}`)
    }
    res.json({ ok: true, data: { publicId: req.validatedBody.publicId, result: result.result } })
  }),
)
