import { Hono } from 'hono';
import { createPhindChat, createDuckDuckGoChat, createBlackboxChat } from 'free-chatbot';

const app = new Hono();

app.get('/', (c) => c.text('Hono API is running')); // Default endpoint

app.post('/v1/chat/completions', async (c) => {
  try {
    const body = await c.req.json();
    const { provider, message, options } = body;

    let chatbot;
    if (provider === 'phind') {
      chatbot = createPhindChat();
    } else if (provider === 'duckduckgo') {
      chatbot = createDuckDuckGoChat();
    } else if (provider === 'blackbox') {
      chatbot = createBlackboxChat();
    } else {
      return c.json({ error: 'Invalid provider' }, 400);
    }

    const response = await chatbot.chat(message, options);
    return c.json({ response });
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

export default app;
