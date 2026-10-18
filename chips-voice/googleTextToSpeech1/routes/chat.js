// Chat webhooks. Each adapter checks that the message really came from the service, then hands it to lib/chat.js.
//   POST /chat/twilio     WhatsApp and SMS through Twilio   (TWILIO_AUTH_TOKEN, PUBLIC_URL)
//   POST /chat/telegram   a Telegram bot webhook            (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET)
//   POST /chat/message    anything else (Slack, Discord, Zapier ...): { from, text }, needs the API key or a login
const express = require('express');
const twilio = require('../lib/twilio');
const crypto = require('crypto');

const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function createChatRoutes({ chat, twilioAuthToken = '', publicUrl = '', telegramToken = '', telegramSecret = '', telegramApi = 'https://api.telegram.org', fetchImpl = fetch }) {
  // Public: verified by the service's own signature or secret, not by a login.
  const webhooks = express.Router();

  webhooks.post('/chat/twilio', async (req, res) => {
    if (!twilioAuthToken) return res.status(503).type('text/plain').send('TWILIO_AUTH_TOKEN is not set');
    const url = `${publicUrl.replace(/\/+$/, '')}${req.originalUrl}`;
    if (!twilio.valid(url, req.body || {}, twilioAuthToken, req.get('x-twilio-signature'))) {
      return res.status(403).type('text/plain').send('bad signature');
    }
    const { reply } = await chat.handle({ from: req.body.From, text: req.body.Body });
    res.type('text/xml').send(twilio.twiml(reply));          // no reply (not allowed) is an empty response, nothing is revealed
  });

  webhooks.post('/chat/telegram', async (req, res) => {
    if (!telegramToken || !telegramSecret) return res.status(503).json({ error: 'Telegram is not configured' });
    if (!same(req.get('x-telegram-bot-api-secret-token'), telegramSecret)) return res.status(403).json({ error: 'bad secret' });
    const message = (req.body || {}).message;
    if (message && message.text && message.from) {
      const { reply } = await chat.handle({ from: `telegram:${message.from.id}`, text: message.text });
      if (reply) {
        try {
          await fetchImpl(`${telegramApi}/bot${telegramToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: message.chat ? message.chat.id : message.from.id, text: reply }),
            signal: AbortSignal.timeout(15000),
          });
        } catch (err) {
          console.error('telegram reply failed:', err.message);
        }
      }
    }
    res.json({ ok: true });                                  // always 200 so Telegram does not retry
  });

  // Authenticated (mounted after the login check). The sender name is a label; the API key already proves who is calling.
  const router = express.Router();
  router.post('/chat/message', async (req, res) => {
    const { from, text } = req.body || {};
    const sender = `api:${String(from || 'default').slice(0, 60)}`;
    const reply = await chat.handleTrusted({ from: sender, text });
    res.json({ reply });
  });

  return { webhooks, router };
}

module.exports = { createChatRoutes };
