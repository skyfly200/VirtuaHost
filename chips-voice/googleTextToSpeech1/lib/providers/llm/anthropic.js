// Anthropic Messages API. ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_BASE_URL.
const { request } = require('../http');

function create(env) {
  const base = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
  return {
    name: 'anthropic',
    model,
    async generate({ system, prompt, maxTokens = 300 }) {
      if (!env.ANTHROPIC_API_KEY) throw new Error('anthropic: ANTHROPIC_API_KEY is not set');
      const res = await request(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }] },
      });
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text) throw new Error('anthropic: empty response');
      return text;
    },
  };
}

module.exports = { create };
