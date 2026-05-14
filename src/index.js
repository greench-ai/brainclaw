// Brainclaw — Main server entry point
// Self-evolving multi-agent memory system sidecar
// Listens on port 3002

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import { getDb, upsertAgent, listAgents, getStats, insertSharedHint, getSharedHints, voteHint, getEpisodesByAgent, getTopEpisodes } from './db.js';
import { recordExperience, processFeedback, retrieve, formatInjection, startTask, closeTask, getOpenTask } from './memory.js';
import { formatGuidelinesJSON, formatGuidelinesPrompt, decayGuidelines } from './guidelines.js';
import { sanitizeMemoryText, detectIntent, generalizeWithLLM } from './sanitize.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3002;
const HOST = '0.0.0.0';

// ── LLM Integration ─────────────────────────────────────────────────────────

// Configure your LLM endpoint here
// Default: use Ollama on the local machine
const LLM_CONFIG = {
  provider: 'ollama',       // 'ollama' | 'openai' | 'anthropic'
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.2:latest',
  apiKey: null,
};

async function createLLMClient() {
  return {
    async complete(prompt) {
      if (LLM_CONFIG.provider === 'ollama') {
        const res = await fetch(`${LLM_CONFIG.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: LLM_CONFIG.model,
            prompt,
            stream: false,
          }),
        });
        const data = await res.json();
        return data.response || '';
      }
      // Add OpenAI/Anthropic support as needed
      return '';
    }
  };
}

let llm = null;
createLLMClient().then(c => { llm = c; console.log('[brainclaw] LLM client ready'); }).catch(() => {
  console.warn('[brainclaw] LLM not available — guideline synthesis disabled');
});

// ── Fastify ─────────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: { level: 'info' } });

await fastify.register(cors, { origin: true });

// Health
fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }));

// ── Agent management ────────────────────────────────────────────────────────

fastify.post('/api/agents/:agentId', async (req, reply) => {
  const { agentId } = req.params;
  const { name, platform, port, metadata } = req.body;
  upsertAgent({ id: agentId, name, platform, port, metadata: metadata || {} });
  return { ok: true, agentId };
});

fastify.get('/api/agents', async () => listAgents());

// ── Episodes ─────────────────────────────────────────────────────────────────

fastify.get('/api/episodes/leaderboard', async (req, reply) => {
  const agents = listAgents();
  const leaderboard = agents.map(a => {
    const stats = getStats(a.id);
    const topEps = getTopEpisodes(a.id, 0.3, 5);
    return { agentId: a.id, name: a.name, ...stats, topEps };
  }).sort((a, b) => b.avgQ - a.avgQ);
  return { leaderboard };
});

fastify.get('/api/episodes/:agentId', async (req, reply) => {
  const { agentId } = req.params;
  const { limit = 20, minQ } = req.query;
  const episodes = minQ !== undefined
    ? getTopEpisodes(agentId, parseFloat(minQ), parseInt(limit))
    : getEpisodesByAgent(agentId, parseInt(limit));
  return { episodes, count: episodes.length };
});

// ── Experience recording ─────────────────────────────────────────────────────

fastify.post('/api/experiences', async (req, reply) => {
  const { agentId, userMessage, agentReply, toolWasUsed, contextEmbedding } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });

  const episodeId = await recordExperience({ agentId, userMessage, agentReply, toolWasUsed, reward: 0, llm });
  return { ok: true, episodeId };
});

// ── Feedback ────────────────────────────────────────────────────────────────

fastify.post('/api/feedback', async (req, reply) => {
  const { agentId, episodeId, reward, confidence, note } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });

  const result = await processFeedback({ agentId, episodeId, reward, confidence: confidence ?? 0.8, note, llm });
  return result;
});

// ── Retrieval ───────────────────────────────────────────────────────────────

fastify.post('/api/retrieve', async (req, reply) => {
  const { agentId, contextText, contextEmbedding, limit } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });

  const result = await retrieve({ agentId, contextEmbedding, contextText, limit: limit ?? 5 });
  const injection = formatInjection(result);
  return { ...result, injectionText: injection };
});

// ── Guidelines ──────────────────────────────────────────────────────────────

fastify.get('/api/guidelines/:agentId', async (req, reply) => {
  const { agentId } = req.params;
  return formatGuidelinesJSON(agentId);
});

fastify.get('/api/guidelines/:agentId/prompt', async (req, reply) => {
  const { agentId } = req.params;
  return { text: formatGuidelinesPrompt(agentId) };
});

// ── Task management ─────────────────────────────────────────────────────────

fastify.post('/api/tasks/start', async (req, reply) => {
  const { agentId, intent } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });
  const task = startTask(agentId, sanitizeMemoryText(detectIntent(intent) + ': ' + intent.slice(0, 200)));
  return { task };
});

fastify.post('/api/tasks/close', async (req, reply) => {
  const { agentId, outcome, reward } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });
  const episode = closeTask(agentId, outcome || 'completed', reward ?? 0);
  return { episode };
});

fastify.get('/api/tasks/:agentId', async (req, reply) => {
  const { agentId } = req.params;
  return getOpenTask(agentId) || { status: 'no_open_task' };
});

// ── Shared hints (A2A) ──────────────────────────────────────────────────────

fastify.post('/api/shared', async (req, reply) => {
  const { fromAgent, pattern, guideline, category, confidence } = req.body;
  if (!fromAgent) return reply.status(400).send({ error: 'fromAgent required' });
  const id = insertSharedHint({ from_agent: fromAgent, pattern, guideline, category, confidence });
  return { id };
});

fastify.get('/api/shared', async (req, reply) => {
  const { category } = req.query;
  return getSharedHints(null, category);
});

fastify.post('/api/shared/:hintId/vote', async (req, reply) => {
  const { hintId } = req.params;
  const { upvote } = req.body;
  voteHint(hintId, upvote ?? true);
  return { ok: true };
});

// ── Stats ───────────────────────────────────────────────────────────────────

fastify.get('/api/stats/:agentId', async (req, reply) => {
  const { agentId } = req.params;
  return getStats(agentId);
});

// ── Memory summary ───────────────────────────────────────────────────────────

fastify.post('/api/summarize', async (req, reply) => {
  // Lightweight context summarization for injection
  const { agentId, recentMessages } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });

  const summary = recentMessages
    .map(m => `[${m.role}]: ${sanitizeMemoryText(m.content || '').slice(0, 150)}`)
    .join('\n');

  return { summary: summary.slice(0, 1000) };
});

// ── Decay cron (called by external scheduler) ─────────────────────────────────

fastify.post('/api/cron/decay', async (req, reply) => {
  const agents = listAgents();
  const results = {};
  for (const agent of agents) {
    results[agent.id] = decayGuidelines(agent.id);
  }
  return { decayed: results };
});

// ── HTTP Server + WebSocket ──────────────────────────────────────────────────

// ── Start ───────────────────────────────────────────────────────────────────

async function start() {
  // Start Fastify (HTTP + WebSocket on same port)
  await fastify.listen({ port: PORT, host: HOST, listenTextResolver: () => {} });

  // Attach WebSocket server to the same HTTP server
  const wss = new WebSocketServer({ noServer: true });
  const wsClients = new Map(); // clientId -> { ws, agentId, label }

  fastify.server.on('upgrade', (request, socket, head) => {
    if (request.url === '/' || request.url === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const clientId = nanoid(8);
        wsClients.set(clientId, { ws, agentId: null, label: 'unknown' });
        console.log(`[brainclaw:ws] +${clientId} (total: ${wsClients.size})`);
        ws.send(JSON.stringify({ type: 'welcome', clientId }));

        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }

          switch (msg.type) {
            case 'register':
              wsClients.get(clientId).agentId = msg.agentId;
              wsClients.get(clientId).label = msg.label || 'unknown';
              console.log(`[brainclaw:ws] ${clientId} registered as ${msg.agentId} (${msg.label})`);
              ws.send(JSON.stringify({ type: 'registered', agentId: msg.agentId }));
              break;
            case 'experience':
              recordExperience({ agentId: msg.agentId, ...msg.data, llm })
                .then(episodeId => ws.send(JSON.stringify({ type: 'experience_recorded', episodeId })))
                .catch(e => ws.send(JSON.stringify({ type: 'error', message: e.message })));
              break;
            case 'retrieve':
              retrieve({ agentId: msg.agentId, contextText: msg.contextText, contextEmbedding: msg.contextEmbedding, llm })
                .then(result => {
                  const injection = formatInjection(result);
                  ws.send(JSON.stringify({ type: 'retrieval_result', injectionText: injection, guidelines: result.guidelines }));
                }).catch(e => ws.send(JSON.stringify({ type: 'error', message: e.message })));
              break;
            case 'feedback':
              processFeedback({ agentId: msg.agentId, ...msg.data, llm })
                .then(result => ws.send(JSON.stringify({ type: 'feedback_processed', result })))
                .catch(e => ws.send(JSON.stringify({ type: 'error', message: e.message })));
              break;
            case 'ping':
              ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
              break;
          }
        });

        ws.on('close', () => {
          wsClients.delete(clientId);
          console.log(`[brainclaw:ws] -${clientId} (total: ${wsClients.size})`);
        });

        ws.on('error', (err) => {
          console.error(`[brainclaw:ws] ${clientId} error:`, err.message);
        });
      });
    }
  });

  // Broadcast helper
  fastify.server._wsClients = wsClients;

  console.log(`[brainclaw] Brainclaw sidecar running on http://${HOST}:${PORT}`);
  console.log(`[brainclaw] WebSocket on ws://${HOST}:${PORT}/ws`);
  console.log(`[brainclaw] LLM: ${LLM_CONFIG.provider}/${LLM_CONFIG.model}`);
  getDb(); // Initialize DB on startup
}

start().catch(err => {
  console.error('[brainclaw] Failed to start:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[brainclaw] Shutting down...');
  httpServer.close();
  process.exit(0);
});
