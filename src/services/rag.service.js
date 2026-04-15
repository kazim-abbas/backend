const { HelpArticle } = require('../models');
const { getClient } = require('./openai.client');
const env = require('../config/env');

/**
 * Cosine similarity between two equal-length numeric vectors.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Generate an embedding for text via OpenAI.
 * Returns { vector, usage } so callers can record token spend.
 */
async function embed(text) {
  const openai = getClient();
  const res = await openai.embeddings.create({
    model: env.openai.embeddingModel,
    input: text,
  });
  return {
    vector: res.data[0].embedding,
    usage: res.usage,
    model: res.model,
  };
}

/**
 * Retrieve top-k relevant help articles for a query within an agency.
 *
 * Implementation note: for now we do exact kNN in JS over the agency's articles.
 * At scale (>10k articles/agency) this should move to Atlas Vector Search or a
 * dedicated vector store. The interface here stays the same.
 */
async function retrieveArticles({ agency_id, query, topK = 3 }) {
  const { vector, usage } = await embed(query);

  const articles = await HelpArticle.find({
    agency_id,
    is_published: true,
  })
    .select('+embedding')
    .lean();

  const scored = articles
    .filter((a) => Array.isArray(a.embedding) && a.embedding.length > 0)
    .map((a) => ({
      article: a,
      score: cosineSimilarity(vector, a.embedding),
    }))
    .sort((x, y) => y.score - x.score)
    .slice(0, topK);

  return {
    matches: scored,
    embedding_usage: usage,
  };
}

/**
 * Helper for ingesting an article: computes and stores its embedding.
 */
async function indexArticle(articleDoc) {
  const { vector, usage } = await embed(`${articleDoc.title}\n\n${articleDoc.content}`);
  articleDoc.embedding = vector;
  await articleDoc.save();
  return { embedding_usage: usage };
}

module.exports = { embed, retrieveArticles, indexArticle, cosineSimilarity };
