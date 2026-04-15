const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { HelpArticle } = require('../models');
const ragService = require('../services/rag.service');
const tokenService = require('../services/token.service');
const env = require('../config/env');

const list = asyncHandler(async (req, res) => {
  const filter = { ...req.tenantFilter };
  const items = await HelpArticle.find(filter)
    .sort({ updated_at: -1 })
    .lean();
  res.json({ items });
});

const getById = asyncHandler(async (req, res) => {
  const item = await HelpArticle.findOne({
    _id: req.params.id,
    ...req.tenantFilter,
  }).lean();
  if (!item) throw AppError.notFound('Article not found');
  res.json({ item });
});

const create = asyncHandler(async (req, res) => {
  if (!req.agency) throw AppError.badRequest('Agency context required');
  const article = new HelpArticle({
    ...req.body,
    agency_id: req.agency._id,
  });

  // Try to index (embed + save). If embedding fails (e.g. OpenAI down or
  // key missing), still persist the article — it simply won't be returned by
  // RAG until re-indexed later. `article.isNew` is true until a successful save.
  try {
    const { embedding_usage } = await ragService.indexArticle(article);
    if (embedding_usage) {
      await tokenService.recordUsage({
        agency: req.agency,
        feature: 'embedding',
        model: env.openai.embeddingModel,
        usage: embedding_usage,
      });
    }
  } catch (err) {
    if (article.isNew) await article.save();
  }

  res.status(201).json({ item: article });
});

const update = asyncHandler(async (req, res) => {
  const article = await HelpArticle.findOne({
    _id: req.params.id,
    ...req.tenantFilter,
  });
  if (!article) throw AppError.notFound('Article not found');

  Object.assign(article, req.body);

  if (req.body.title !== undefined || req.body.content !== undefined) {
    try {
      const { embedding_usage } = await ragService.indexArticle(article);
      if (embedding_usage && req.agency) {
        await tokenService.recordUsage({
          agency: req.agency,
          feature: 'embedding',
          model: env.openai.embeddingModel,
          usage: embedding_usage,
        });
      }
    } catch {
      await article.save();
    }
  } else {
    await article.save();
  }

  res.json({ item: article });
});

const remove = asyncHandler(async (req, res) => {
  const result = await HelpArticle.findOneAndDelete({
    _id: req.params.id,
    ...req.tenantFilter,
  });
  if (!result) throw AppError.notFound('Article not found');
  res.status(204).end();
});

module.exports = { list, getById, create, update, remove };
