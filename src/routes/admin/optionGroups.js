import { Router } from 'express'
import { z } from 'zod'
import { OptionGroup, INPUT_TYPES, DELTA_TYPES } from '../../models/OptionGroup.js'
import { Product } from '../../models/Product.js'
import { validate } from '../../middleware/validate.js'
import { asyncHandler, ApiError } from '../../utils/ApiError.js'
import { objectId, tierAmountMap } from '../../schemas/common.js'

export const adminOptionGroupsRouter = Router()

const optionGroupBody = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
    label: z.string().trim().min(1).max(120),
    helpText: z.string().trim().max(300).optional(),
    inputType: z.enum(INPUT_TYPES),
    unit: z.string().trim().max(24).nullable().optional(),
    values: z
      .array(
        z
          .object({
            code: z.string().trim().toUpperCase().min(1).max(60),
            label: z.string().trim().min(1).max(120),
            order: z.number().int().optional(),
            priceDelta: tierAmountMap.optional(),
            deltaType: z.enum(DELTA_TYPES).optional(),
            isActive: z.boolean().optional(),
          })
          .strict(),
      )
      .max(80)
      .optional(),
    validation: z
      .object({
        min: z.number().nullable().optional(),
        max: z.number().nullable().optional(),
        step: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

adminOptionGroupsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const groups = await OptionGroup.find().sort({ label: 1 }).lean()

    // How many products use each group — deleting a shared one is a big deal.
    const usage = await Product.aggregate([
      { $unwind: '$options' },
      { $group: { _id: '$options.optionGroup', count: { $sum: 1 } } },
    ])
    const usedBy = new Map(usage.map((u) => [String(u._id), u.count]))

    res.json({
      ok: true,
      data: groups.map((g) => ({ ...g, id: String(g._id), usedByProducts: usedBy.get(String(g._id)) ?? 0 })),
    })
  }),
)

adminOptionGroupsRouter.post(
  '/',
  validate({ body: optionGroupBody }),
  asyncHandler(async (req, res) => {
    const group = new OptionGroup({ ...req.validatedBody, createdBy: req.user._id })
    await group.save()
    res.status(201).json({ ok: true, data: group.toJSON() })
  }),
)

adminOptionGroupsRouter.patch(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict(), body: optionGroupBody.partial() }),
  asyncHandler(async (req, res) => {
    const group = await OptionGroup.findById(req.validatedParams.id)
    if (!group) throw ApiError.notFound('Option group not found')

    // The code is referenced by product selections and by the pricing resolver;
    // changing it would silently orphan them.
    if (req.validatedBody.code && req.validatedBody.code !== group.code) {
      throw ApiError.conflict('An option group code cannot be changed once created')
    }

    Object.assign(group, req.validatedBody)
    await group.save()
    res.json({ ok: true, data: group.toJSON() })
  }),
)

adminOptionGroupsRouter.delete(
  '/:id',
  validate({ params: z.object({ id: objectId }).strict() }),
  asyncHandler(async (req, res) => {
    const id = req.validatedParams.id
    const inUse = await Product.countDocuments({ 'options.optionGroup': id })
    if (inUse > 0) {
      throw ApiError.conflict(`This option is used by ${inUse} product(s). Remove it from them first.`)
    }
    const deleted = await OptionGroup.findByIdAndDelete(id)
    if (!deleted) throw ApiError.notFound('Option group not found')
    res.json({ ok: true, data: { id } })
  }),
)
