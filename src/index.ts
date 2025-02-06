import { Hono } from 'hono'
import { stream, streamText } from 'hono/stream'
import { HTTPException } from 'hono/http-exception'

const app = new Hono()

// Session storage (you might want to use a proper database in production)
const sessions = new Map()

class DDGSChat {
  constructor() {
    this.impersonate = this.randomChoice([
      'chrome_131', 'safari_ios_17.4.1', 'edge_131', 'firefox_133'
    ])
    this.impersonateOS = this.randomChoice([
      'android', 'ios', 'macos', 'windows'
    ])
  }

  randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)]
  }

  async getVQD() {
    const response = await fetch('https://duckduckgo.com/duckchat/v1/status', {
      headers: { 'x-vqd-accept': '1' }
    })
    return response.headers.get('x-vqd-4') || ''
  }

  async chat(session, message, model = 'gpt-4o-mini', timeout = 30) {
    try {
      // Initialize or update session
      if (!session.vqd) {
        session.vqd = await this.getVQD()
        session.messages = []
        session.tokens = 0
      }

      // Add user message
      session.messages.push({ role: 'user', content: message })
      session.tokens += Math.ceil(message.length / 4)

      // API request
      const response = await fetch('https://duckduckgo.com/duckchat/v1/chat', {
        method: 'POST',
        headers: {
          'x-vqd-4': session.vqd,
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; rv:123.0) Gecko/20100101 Firefox/123.0'
        },
        body: JSON.stringify({
          model: this.modelMap(model),
          messages: session.messages
        }),
        timeout
      })

      // Handle new VQD
      session.vqd = response.headers.get('x-vqd-4') || session.vqd

      // Process streaming response
      const data = await response.text()
      const results = []
      const cleanData = data
        .replace(/\[DONE\]LIMT_CVRSA\n/g, '')
        .split('data:')
        .filter(x => x.trim())

      for (const chunk of cleanData) {
        try {
          const json = JSON.parse(chunk.trim())
          if (json.message) results.push(json.message)
          if (json.action === 'error') this.handleError(json)
        } catch (e) {
          console.error('Error parsing chunk:', chunk)
        }
      }

      // Add assistant response
      const fullResponse = results.join('')
      session.messages.push({ role: 'assistant', content: fullResponse })
      session.tokens += fullResponse.length

      return fullResponse
    } catch (error) {
      console.error('Chat error:', error)
      throw new HTTPException(500, { message: 'Chat processing failed' })
    }
  }

  modelMap(model) {
    const models = {
      '1': 'gpt-4o-mini',
      '2': 'claude-3-haiku-20240307',
      '3': 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
      '4': 'mistralai/Mixtral-8x7B-Instruct-v0.1'
    }
    return models[model] || models['1']
  }

  handleError(json) {
    const errorMap = {
      'ERR_CONVERSATION_LIMIT': { status: 429, message: 'Conversation limit reached' },
      'ERR_RATELIMIT': { status: 429, message: 'Rate limit exceeded' },
      'ERR_TIMEOUT': { status: 504, message: 'Request timeout' }
    }
    
    const errorInfo = errorMap[json.type] || { status: 500, message: 'Unknown error' }
    throw new HTTPException(errorInfo.status, { message: errorInfo.message })
  }
}

// Chat endpoint
app.post('/chat', async (c) => {
  const { message, model = '1', sessionId } = await c.req.json()
  const ddgs = new DDGSChat()

  // Session management
  let session = sessions.get(sessionId) || { 
    vqd: null,
    messages: [],
    tokens: 0,
    created: Date.now()
  }

  try {
    const response = await ddgs.chat(session, message, model)
    
    // Update session storage
    const newSessionId = sessionId || crypto.randomUUID()
    sessions.set(newSessionId, session)

    return c.json({
      response,
      sessionId: newSessionId,
      tokens: session.tokens,
      timestamp: Date.now()
    })

  } catch (error) {
    console.error('Endpoint error:', error)
    return c.json({ error: error.message }, error.status || 500)
  }
})

// Example usage:
// curl -X POST http://localhost:3000/chat \
//   -H "Content-Type: application/json" \
//   -d '{"message": "What is Hono?", "model": "1"}'

export default app
