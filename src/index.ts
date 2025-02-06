import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { streamText } from 'hono/streaming';

interface ChatMessage {
  content: string;
  role: 'user' | 'assistant';
}

interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
}

interface ChatResponse {
  content: string;
  success: boolean;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1'
];

const app = new Hono();

// Global Middleware
app.use('*', cors());

// Default route
app.get('/', (c) => c.text('Hono is running'));

// Helper functions
const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const fetchWithRetry = async (url: string, options: RequestInit, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
};

const fetchVQD = async (c: any) => {
  const response = await fetchWithRetry('https://duckduckgo.com/duckchat/v1/status', {
    headers: {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'text/event-stream',
      'x-vqd-accept': '1',
    },
  });

  const vqd = response.headers.get('x-vqd-4');
  if (!vqd) throw new HTTPException(500, { message: 'Failed to get VQD token' });
  return vqd;
};

const getVQD = async (c: any) => {
  return await fetchVQD(c);
};

// Rate limiting (adjust as needed)
const MAX_REQUESTS = 100; // Maximum requests per minute
const MINUTE_MS = 60 * 1000;

// Rate limiter middleware
let requestCount = 0;
let lastReset = Date.now();

app.use('*', (c, next) => {
  const now = Date.now();
  if (now - lastReset > MINUTE_MS) {
    requestCount = 0;
    lastReset = now;
  }

  if (requestCount >= MAX_REQUESTS) {
    throw new HTTPException(429, { message: 'Too many requests. Please try again later.' });
  }

  requestCount++;
  next();
});

// Main route
app.post('/chat', async (c) => {
  try {
    const vqd = await getVQD(c);
    const { messages, model = 'gpt-4-mini' } = await c.req.json<ChatRequest>();

    const headers = {
      'User-Agent': getRandomUserAgent(),
      'Accept': 'text/event-stream',
      'Content-Type': 'application/json',
      'Origin': 'https://duckduckgo.com',
      'Referer': 'https://duckduckgo.com/',
      'x-vqd-4': vqd,
      'Accept-Language': 'en-US,en;q=0.9',
      'x-client-data': 'VIa1yQEIjwEo0oEImsE2DgEImAE'
    };

    const response = await fetchWithRetry('https://duckduckgo.com/duckchat/v1/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages, model }),
    });

    if (!response.ok) {
      throw new HTTPException(500, { message: `DuckDuckGo API error: ${response.status}` });
    }

    return streamText(c, async (stream) => {
      const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();

      if (!reader) {
        throw new HTTPException(500, { message: 'Failed to read response stream' });
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = value.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const json = JSON.parse(data);
              if (json.message) {
                await stream.write(json.message);
              }
            } catch (e) {
              // Handle JSON parse errors
            }
          }
        }
      }
    });
  } catch (error) {
    throw new HTTPException(500, { message: 'Failed to process request' });
  }
});

// Error handling
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.status === 418) {
      return c.json({ success: false, message: 'Too many requests. Please try again later.' }, 418);
    }
    return c.json({ success: false, message: err.message }, err.status);
  }
  return c.json({ success: false, message: 'Internal server error' }, 500);
});

export default app;
