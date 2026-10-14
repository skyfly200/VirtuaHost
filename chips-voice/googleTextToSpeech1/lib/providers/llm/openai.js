// Chat-completions client for OpenAI and anything that speaks the same API (OpenRouter, Ollama, ...).
const { request } = require('../http');

function createChat({ name, baseUrl, apiKey, model, headers = {}, extraBody = {}, requireKey = true }) {
  return {
    name,
    model,
    async generate({ system, prompt, maxTokens = 300 }) {
      if (requireKey && !apiKey) throw new Error(`${name}: API key is not set`);
      if (!model) throw new Error(`${name}: no model configured`);
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      const res = await request(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers },
        body: { model, messages, max_tokens: maxTokens, ...extraBody },
      });
      const text = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
      if (!text) throw new Error(`${name}: empty response`);
      return String(text).trim();
    },
  };
}

module.exports = { createChat };
