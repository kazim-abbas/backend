const { AdminSettings, Ticket } = require('../models');
const { getClient } = require('./openai.client');
const { retrieveArticles } = require('./rag.service');
const { assertAIAllowed, recordUsage } = require('./token.service');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const AUTO_REPLY_SYSTEM_PROMPT = `You are a support agent.

Use ONLY the provided help articles to answer.
If the answer is not contained in the articles, respond exactly with:
"I'll connect you with a human agent."

Be concise, friendly, and professional.`;

const SUMMARY_SYSTEM_PROMPT = `Summarize this support conversation in 3 lines.
Include:
- User intent
- Key facts discussed
- Sentiment (positive / neutral / negative)

Return plain text, no bullet markers.`;

function formatMessagesForPrompt(messages) {
  return messages
    .map((m) => {
      const who = m.sender === 'user' ? 'User' : m.sender === 'agent' ? 'Agent' : 'System';
      return `${who}: ${m.text}`;
    })
    .join('\n');
}

function formatArticlesForPrompt(matches) {
  if (!matches.length) return '(no relevant articles found)';
  return matches
    .map(
      (m, i) =>
        `[Article ${i + 1}] ${m.article.title}\n${m.article.content}\n(relevance: ${m.score.toFixed(3)})`
    )
    .join('\n\n---\n\n');
}

/**
 * Generate an AI auto-reply for a ticket using RAG against the agency's articles.
 * Gated by admin settings, agency settings, and remaining token budget.
 */
async function generateAutoReply({ ticket, agency }) {
  const adminSettings = await AdminSettings.getSingleton();
  await assertAIAllowed({ agency, adminSettings, feature: 'auto_reply' });

  const lastUserMessage = [...ticket.messages].reverse().find((m) => m.sender === 'user');
  if (!lastUserMessage) {
    throw AppError.badRequest('Ticket has no user messages to reply to');
  }

  const { matches, embedding_usage } = await retrieveArticles({
    agency_id: agency._id,
    query: lastUserMessage.text,
    topK: 3,
  });

  // Record embedding spend separately so it's attributable.
  if (embedding_usage) {
    await recordUsage({
      agency,
      ticketId: ticket._id,
      feature: 'embedding',
      model: env.openai.embeddingModel,
      usage: embedding_usage,
    });
  }

  const openai = getClient();
  const userContent = [
    `User message:\n${lastUserMessage.text}`,
    `\nHelp articles:\n${formatArticlesForPrompt(matches)}`,
  ].join('\n');

  const completion = await openai.chat.completions.create({
    model: env.openai.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: AUTO_REPLY_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });

  const reply = completion.choices?.[0]?.message?.content?.trim() || '';

  await recordUsage({
    agency,
    ticketId: ticket._id,
    feature: 'auto_reply',
    model: completion.model,
    usage: completion.usage,
  });

  logger.info('ai_reply_generated', {
    agency_id: agency._id.toString(),
    ticket_id: ticket._id.toString(),
    matches: matches.length,
  });

  return {
    reply,
    used_articles: matches.map((m) => ({
      id: m.article._id,
      title: m.article.title,
      score: m.score,
    })),
    usage: completion.usage,
  };
}

/**
 * Summarize a ticket conversation and persist the summary on the ticket.
 */
async function generateSummary({ ticket, agency }) {
  const adminSettings = await AdminSettings.getSingleton();
  await assertAIAllowed({ agency, adminSettings, feature: 'summary' });

  if (!ticket.messages.length) {
    throw AppError.badRequest('Ticket has no messages to summarize');
  }

  const openai = getClient();
  const completion = await openai.chat.completions.create({
    model: env.openai.model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: formatMessagesForPrompt(ticket.messages) },
    ],
  });

  const summary = completion.choices?.[0]?.message?.content?.trim() || '';

  ticket.ai_summary = summary;
  ticket.ai_summary_updated_at = new Date();
  await ticket.save();

  await recordUsage({
    agency,
    ticketId: ticket._id,
    feature: 'summary',
    model: completion.model,
    usage: completion.usage,
  });

  logger.info('ai_summary_generated', {
    agency_id: agency._id.toString(),
    ticket_id: ticket._id.toString(),
  });

  return { summary, usage: completion.usage };
}

module.exports = { generateAutoReply, generateSummary };
