const { AdminSettings, Ticket } = require('../models');
const { getClient } = require('./openai.client');
const { retrieveArticles } = require('./rag.service');
const { assertAIAllowed, recordUsage } = require('./token.service');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const HANDOFF_MESSAGE = "I'll connect you with a human agent.";

// Minimum cosine similarity below which we refuse to answer — even if the
// LLM would happily confabulate, we hand off to a human instead.
const RAG_MIN_SCORE = 0.62;

const AUTO_REPLY_SYSTEM_PROMPT = `You are a customer support assistant for an agency's help desk.

STRICT RULES — non-negotiable:
1. Answer ONLY from the "Help articles" provided below. Do not use outside knowledge.
2. If the articles do not contain a clear answer to the user's question, reply with EXACTLY this text and nothing else: "${HANDOFF_MESSAGE}"
3. Never invent product names, prices, URLs, phone numbers, policies, steps, or timelines.
4. Never promise actions you cannot verify from the articles (refunds, escalations, account changes).
5. Never guess. Partial or uncertain answers must hand off to a human.
6. If the user expresses frustration, asks for a human, or the conversation has been going in circles, hand off immediately with the exact handoff message.

STYLE:
- Be concise (2–5 short sentences unless the article requires more).
- Friendly, professional, no filler ("Great question!", "As an AI...").
- Plain text only. No markdown, no emojis.`;

const SUMMARY_SYSTEM_PROMPT = `Summarize this support conversation in 3 lines.
Include:
- User intent
- Key facts discussed
- Sentiment (positive / neutral / negative)

Return plain text, no bullet markers.`;

/**
 * Heuristic detector for "user wants a human" intent. Runs before any LLM
 * spend — if it triggers, we short-circuit straight to the handoff message.
 * Kept conservative (explicit phrases only) so we don't hijack genuine
 * product questions that merely mention the word "human".
 */
const HANDOFF_PATTERNS = [
  /\btalk to (a |an )?(human|person|agent|someone|real (person|human))\b/i,
  /\bspeak (to|with) (a |an )?(human|person|agent|someone|real (person|human))\b/i,
  /\b(human|live|real) (agent|person|support|rep|representative)\b/i,
  /\b(connect|transfer|escalate) me\b/i,
  /\b(i want|i need|get me) (a |an )?(human|person|agent|manager|supervisor)\b/i,
  /\bstop (the )?(bot|ai|chatbot)\b/i,
  /\bthis (bot|ai) is (useless|not helping|dumb|stupid)\b/i,
];

function detectHandoffIntent(text = '') {
  const s = String(text);
  return HANDOFF_PATTERNS.some((re) => re.test(s));
}

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

  // 1. Cheap intent check first — skip all RAG/LLM spend if the user is
  //    explicitly asking for a human.
  if (detectHandoffIntent(lastUserMessage.text)) {
    logger.info('ai_reply_handoff_intent_detected', {
      agency_id: agency._id.toString(),
      ticket_id: ticket._id.toString(),
    });
    return {
      reply: HANDOFF_MESSAGE,
      handoff: true,
      handoff_reason: 'user_requested_human',
      used_articles: [],
      usage: null,
    };
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

  // 2. Relevance gate: if the best match is too weak, the articles don't
  //    cover this question — hand off instead of risking a hallucination.
  const topScore = matches[0]?.score || 0;
  if (!matches.length || topScore < RAG_MIN_SCORE) {
    logger.info('ai_reply_handoff_low_relevance', {
      agency_id: agency._id.toString(),
      ticket_id: ticket._id.toString(),
      top_score: topScore,
      threshold: RAG_MIN_SCORE,
    });
    return {
      reply: HANDOFF_MESSAGE,
      handoff: true,
      handoff_reason: 'no_relevant_article',
      used_articles: matches.map((m) => ({
        id: m.article._id,
        title: m.article.title,
        score: m.score,
      })),
      usage: null,
    };
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

  // 3. Post-LLM handoff detection — model either produced the canonical
  //    handoff message, or an empty / extremely short reply we don't trust.
  const isHandoff =
    reply === HANDOFF_MESSAGE ||
    reply.toLowerCase().includes('connect you with a human') ||
    reply.length < 10;

  logger.info('ai_reply_generated', {
    agency_id: agency._id.toString(),
    ticket_id: ticket._id.toString(),
    matches: matches.length,
    top_score: topScore,
    handoff: isHandoff,
  });

  return {
    reply: isHandoff ? HANDOFF_MESSAGE : reply,
    handoff: isHandoff,
    handoff_reason: isHandoff ? 'model_refused' : undefined,
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

module.exports = {
  generateAutoReply,
  generateSummary,
  detectHandoffIntent,
  HANDOFF_MESSAGE,
  RAG_MIN_SCORE,
};
