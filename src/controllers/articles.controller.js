const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { HelpArticle } = require('../models');
const ragService = require('../services/rag.service');
const tokenService = require('../services/token.service');
const env = require('../config/env');

/**
 * Articles are a single shared pool. Every agency's AI and every agency's
 * knowledge-base page reads from the same collection. Only platform admins
 * can create / update / delete (enforced at the route layer); all other
 * authenticated users get a read-only, published-only view.
 */

function isAdmin(req) {
  return req.user?.role === 'admin';
}

const list = asyncHandler(async (req, res) => {
  const filter = isAdmin(req) ? {} : { is_published: true };
  const items = await HelpArticle.find(filter)
    .sort({ updated_at: -1 })
    .lean();
  res.json({ items });
});

const getById = asyncHandler(async (req, res) => {
  const filter = isAdmin(req)
    ? { _id: req.params.id }
    : { _id: req.params.id, is_published: true };
  const item = await HelpArticle.findOne(filter).lean();
  if (!item) throw AppError.notFound('Article not found');
  res.json({ item });
});

const create = asyncHandler(async (req, res) => {
  const article = new HelpArticle({
    ...req.body,
    // agency_id intentionally omitted — articles are global.
  });

  // Try to index (embed + save). If embedding fails (e.g. OpenAI down or
  // key missing), still persist the article — it simply won't be returned by
  // RAG until re-indexed later. `article.isNew` is true until a successful save.
  try {
    const { embedding_usage } = await ragService.indexArticle(article);
    // Embedding cost for the shared knowledge base is a platform expense —
    // no agency is charged. If that changes, assign a "platform" agency
    // record and pass it here.
    if (embedding_usage && req.agency) {
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
  const article = await HelpArticle.findById(req.params.id);
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
  const result = await HelpArticle.findByIdAndDelete(req.params.id);
  if (!result) throw AppError.notFound('Article not found');
  res.status(204).end();
});

module.exports = { list, getById, create, update, remove };
