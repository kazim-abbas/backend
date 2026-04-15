const OpenAI = require('openai');
const env = require('../config/env');
const AppError = require('../utils/AppError');

let client = null;

function getClient() {
  if (!env.openai.apiKey) {
    throw AppError.badRequest('OPENAI_API_KEY is not configured');
  }
  if (!client) {
    client = new OpenAI({ apiKey: env.openai.apiKey });
  }
  return client;
}

module.exports = { getClient };
