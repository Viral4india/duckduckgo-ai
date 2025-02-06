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

// Global Middleware (KV-based rate limiting removed)
app.use('*', cors());

// Default route to indicate Hono is running
app.get('/', (c) => c.text('Hono is running'));

// Helper functions
const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Always fetch a new VQD token instead of using KV caching
const fetchVQD = async (c: any) => {
  const response = await fetch('https://duckduckgo.com/duckchat/v1/status', {
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

// Routes
app.post('/chat', async (c) => {
  const vqd = await getVQD(c);
  const { messages, model = 'gpt-4o-mini' } = await c.req.json<ChatRequest>();

  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'Origin': 'https://duckduckgo.com',
    'Referer': 'https://duckduckgo.com/',
    'x-vqd-4': vqd,
  };

  const response = await fetch('https://duckduckgo.com/duckchat/v1/chat', {
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
});

// Error handling
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ success: false, message: err.message }, err.status);
  }
  return c.json({ success: false, message: 'Internal server error' }, 500);
});

export default app;
