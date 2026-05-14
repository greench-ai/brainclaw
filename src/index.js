// Brainclaw — Main server entry point
// Self-evolving multi-agent memory system sidecar
// Listens on port 3002

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { nanoid } from 'nanoid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { getDb, upsertAgent, listAgents, getStats, insertSharedHint, getSharedHints, voteHint, getEpisodesByAgent, getTopEpisodes } from './db.js';
import { recordExperience, processFeedback, retrieve, formatInjection, startTask, closeTask, getOpenTask } from './memory.js';
import { formatGuidelinesJSON, formatGuidelinesPrompt, decayGuidelines } from './guidelines.js';
import { sanitizeMemoryText, detectIntent } from './sanitize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3002;
const HOST = '0.0.0.0';
const CHAT_UI_PATH = join(__dirname, '..', 'src', 'chat-ui.html');

// ── LLM Integration ─────────────────────────────────────────────────────────

const LLM_CONFIG = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.2:latest',
};

let llm = null;
(async () => {
  try {
    const res = await fetch(`${LLM_CONFIG.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_CONFIG.model, prompt: 'hi', stream: false }),
    });
    if (res.ok) {
      llm = {
        async complete(prompt) {
          const r = await fetch(`${LLM_CONFIG.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: LLM_CONFIG.model, prompt, stream: false }),
          });
          const d = await r.json();
          return d.response || '';
        }
      };
      console.log('[brainclaw] LLM client ready');
    }
  } catch {
    console.warn('[brainclaw] LLM not available — guideline synthesis disabled');
  }
})();

// ── Fastify ─────────────────────────────────────────────────────────────────

const fastify = Fastify({ logger: { level: 'info' } });
await fastify.register(cors, { origin: true });

// Team chat UI
fastify.get('/chat', (req, reply) => {
  reply.header('Content-Type', 'text/html');
  reply.send(readFileSync(CHAT_UI_PATH, 'utf8'));
});

fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }));

// ── Agent management ────────────────────────────────────────────────────────

fastify.post('/api/agents/:agentId', async (req, reply) => {
  const { agentId } = req.params;
  const { name, platform, port, metadata } = req.body;
  upsertAgent({ id: agentId, name, platform, port, metadata: metadata || {} });
  return { ok: true, agentId };
});

fastify.get('/api/agents', async () => listAgents());

// ── Episodes ────────────────────────────────────────────────────────────────

fastify.get('/api/episodes/leaderboard', async () => {
  const agents = listAgents();
  const leaderboard = agents.map(a => {
    const stats = getStats(a.id);
    const topEps = getTopEpisodes(a.id, 0.3, 5);
    return { agentId: a.id, name: a.name, ...stats, topEps };
  }).sort((a, b) => b.avgQ - a.avgQ);
  return { leaderboard };
});

fastify.get('/api/episodes/:agentId', async (req) => {
  const { agentId } = req.params;
  const { limit = 20, minQ } = req.query;
  const episodes = minQ !== undefined
    ? getTopEpisodes(agentId, parseFloat(minQ), parseInt(limit))
    : getEpisodesByAgent(agentId, parseInt(limit));
  return { episodes, count: episodes.length };
});

// ── Experience recording ────────────────────────────────────────────────────

fastify.post('/api/experiences', async (req, reply) => {
  const { agentId, userMessage, agentReply, toolWasUsed } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });
  const episodeId = await recordExperience({ agentId, userMessage, agentReply, toolWasUsed, llm });
  return { ok: true, episodeId };
});

// ── Feedback ───────────────────────────────────────────────────────────────

fastify.post('/api/feedback', async (req, reply) => {
  const { agentId, episodeId, reward, confidence, note } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });
  const result = await processFeedback({ agentId, episodeId, reward, confidence: confidence ?? 0.8, note, llm });
  return result;
});

// ── Retrieval ──────────────────────────────────────────────────────────────

fastify.post('/api/retrieve', async (req, reply) => {
  const { agentId, contextText, contextEmbedding, limit } = req.body;
  if (!agentId) return reply.status(400).send({ error: 'agentId required' });
  const result = await retrieve({ agentId, contextEmbedding, contextText, limit: limit ?? 5 });
  return { ...result, injectionText: formatInjection(result) };
});

// ── Guidelines ─────────────────────────────────────────────────────────────

fastify.get('/api/guidelines/:agentId', async (req) => formatGuidelinesJSON(req.params.agentId));

fastify.get('/api/guidelines/:agentId/prompt', async (req) => ({
  text: formatGuidelinesPrompt(req.params.agentId)
}));

// ── Task management ────────────────────────────────────────────────────────

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

fastify.get('/api/tasks/:agentId', async (req) => getOpenTask(req.params.agentId) || { status: 'no_open_task' });

// ── Shared hints (A2A) ──────────────────────────────────────────────────

fastify.post('/api/shared', async (req, reply) => {
  const { fromAgent, pattern, guideline, category, confidence } = req.body;
  if (!fromAgent) return reply.status(400).send({ error: 'fromAgent required' });
  const id = insertSharedHint({ from_agent: fromAgent, pattern, guideline, category, confidence });
  return { id };
});

fastify.get('/api/shared', async (req) => getSharedHints(null, req.query.category));

fastify.post('/api/shared/:hintId/vote', async (req, reply) => {
  const { upvote } = req.body;
  voteHint(req.params.hintId, upvote ?? true);
  return { ok: true };
});

// ── Stats ─────────────────────────────────────────────────────────────────

fastify.get('/api/stats/:agentId', async (req) => getStats(req.params.agentId));

// ── Broadcast / PubSub ────────────────────────────────────────────────────

fastify.post('/api/broadcast/:channel', async (req, reply) => {
  const { channel } = req.params;
  const { from, text } = req.body;
  if (!from || !text) return reply.status(400).send({ error: 'from and text required' });
  broadcast(channel, { from, text, ts: Date.now() });
  return { ok: true, channel, from, ts: Date.now() };
});

fastify.get('/api/broadcast/channels', async () => ({
  channels: ['team', 'fuma', 'kojiro', 'sasuke', 'nexus']
}));

// ── Cron ─────────────────────────────────────────────────────────────────

fastify.post('/api/cron/decay', async () => {
  const agents = listAgents();
  const results = {};
  for (const agent of agents) results[agent.id] = decayGuidelines(agent.id);
  return { decayed: results };
});

// ── WebSocket + PubSub ────────────────────────────────────────────────────

let wsClients;    // clientId -> { ws, agentId, label }
let subscriptions; // clientId -> Set<channel>

function handleSubscribe(clientId, channel) {
  if (!subscriptions.has(clientId)) subscriptions.set(clientId, new Set());
  subscriptions.get(clientId).add(channel);
}

function handleUnsubscribe(clientId, channel) {
  subscriptions.get(clientId)?.delete(channel);
}

function broadcast(channel, msg) {
  if (!wsClients) return;
  const payload = JSON.stringify({ type: 'broadcast', channel, ...msg });
  for (const [clientId, client] of wsClients) {
    if (client.ws.readyState !== 1) continue;
    const subs = subscriptions.get(clientId);
    if (!subs || (!subs.has(channel) && !subs.has('team'))) continue;
    client.ws.send(payload);
  }
}

// ── Start ────────────────────────────────────────────────────────────────

async function start() {
  await fastify.listen({ port: PORT, host: HOST, listenTextResolver: () => {} });

  wsClients = new Map();
  subscriptions = new Map();

  const wss = new WebSocketServer({ noServer: true });

  fastify.server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/' && request.url !== '/ws') return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      const clientId = nanoid(8);
      wsClients.set(clientId, { ws, agentId: null, label: 'unknown' });
      console.log(`[brainclaw:ws] +${clientId} (total: ${wsClients.size})`);
      ws.send(JSON.stringify({ type: 'welcome', clientId }));

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const client = wsClients.get(clientId);

        switch (msg.type) {
          case 'register':
            client.agentId = msg.agentId;
            client.label = msg.label || 'unknown';
            console.log(`[brainclaw:ws] ${clientId} registered as ${msg.agentId}`);
            ws.send(JSON.stringify({ type: 'registered', agentId: msg.agentId }));
            break;
          case 'subscribe':
            handleSubscribe(clientId, msg.channel);
            ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));
            break;
          case 'unsubscribe':
            handleUnsubscribe(clientId, msg.channel);
            ws.send(JSON.stringify({ type: 'unsubscribed', channel: msg.channel }));
            break;
          case 'broadcast':
            broadcast(msg.channel || 'team', { from: client.agentId, text: msg.text, ts: Date.now() });
            break;
          case 'experience':
            recordExperience({ agentId: msg.agentId, ...msg.data, llm })
              .then(id => ws.send(JSON.stringify({ type: 'experience_recorded', episodeId: id })))
              .catch(e => ws.send(JSON.stringify({ type: 'error', message: e.message })));
            break;
          case 'retrieve':
            retrieve({ agentId: msg.agentId, contextText: msg.contextText, llm })
              .then(result => ws.send(JSON.stringify({ type: 'retrieval_result', injectionText: formatInjection(result), guidelines: result.guidelines })))
              .catch(e => ws.send(JSON.stringify({ type: 'error', message: e.message })));
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
        subscriptions.delete(clientId);
        console.log(`[brainclaw:ws] -${clientId} (total: ${wsClients.size})`);
      });

      ws.on('error', (err) => console.error(`[brainclaw:ws] ${clientId} error:`, err.message));
    });
  });

  console.log(`[brainclaw] Brainclaw sidecar running on http://${HOST}:${PORT}`);
  console.log(`[brainclaw] Team chat: http://${HOST}:${PORT}/chat`);
  console.log(`[brainclaw] WebSocket on ws://${HOST}:${PORT}/ws`);
  console.log(`[brainclaw] LLM: ${LLM_CONFIG.provider}/${LLM_CONFIG.model}`);
  getDb();
}

start().catch(err => { console.error('[brainclaw] Failed to start:', err); process.exit(1); });

process.on('SIGTERM', () => { console.log('[brainclaw] Shutting down...'); process.exit(0); });
