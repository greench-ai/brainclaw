#!/usr/bin/env node
/**
 * Brainclaw CLI Client
 * Register agents, record experiences, give feedback, retrieve memories
 *
 * Usage:
 *   node src/client.js register <agentId> [name] [platform] [port]
 *   node src/client.js experience <agentId> <userMsg> <agentReply> [--tool]
 *   node src/client.js feedback <agentId> <reward> [--confidence 0.9] [--note "..."]
 *   node src/client.js retrieve <agentId> <context>
 *   node src/client.js guidelines <agentId>
 *   node src/client.js stats <agentId>
 *   node src/client.js share <fromAgent> <pattern> <guideline> [--category coding]
 *   node src/client.js task start <agentId> <intent>
 *   node src/client.js task close <agentId> <outcome> [--reward 0]
 */

const BASE = 'http://127.0.0.1:3002';
const WS_BASE = 'ws://127.0.0.1:3002';

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function wsSend(msg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    ws.onmessage = (e) => { clearTimeout(timeout); ws.close(); resolve(JSON.parse(e.data)); };
    ws.onerror = (e) => { clearTimeout(timeout); ws.close(); reject(e); };
    ws.onopen = () => { ws.send(JSON.stringify(msg)); };
  });
}

const [,, cmd, ...args] = process.argv;

async function main() {
  try {
    switch (cmd) {
      case 'register': {
        const [agentId, name = agentId, platform = 'unknown', port = 0] = args;
        const r = await request('POST', `/api/agents/${agentId}`, { name, platform, port: parseInt(port) });
        console.log('Registered:', r);
        break;
      }
      case 'experience': {
        const [agentId, userMsg, agentReply, ...rest] = args;
        const toolUsed = rest.includes('--tool');
        const r = await request('POST', '/api/experiences', { agentId, userMessage: userMsg, agentReply, toolWasUsed: toolUsed });
        console.log('Experience recorded:', r);
        break;
      }
      case 'feedback': {
        const [agentId, reward, ...rest] = args;
        const confidence = parseFloat(rest.find(a => a.startsWith('--confidence'))?.split('=')[1] ?? '0.8');
        const note = rest.find(a => a.startsWith('--note='))?.split('=')[1] ?? '';
        const r = await request('POST', '/api/feedback', { agentId, reward: parseFloat(reward), confidence: parseFloat(confidence), note });
        console.log('Feedback result:', r);
        break;
      }
      case 'retrieve': {
        const [agentId, context] = args;
        const r = await request('POST', '/api/retrieve', { agentId, contextText: context });
        console.log('Retrieval result:');
        if (r.guidelines?.length) {
          console.log('\nGuidelines:');
          r.guidelines.forEach(g => console.log(`  [${g.category}] ${g.guideline} (conf:${(g.confidence*100).toFixed(0)}%)`));
        }
        if (r.injectionText) console.log('\nInjectable text:', r.injectionText.slice(0, 300));
        break;
      }
      case 'guidelines': {
        const [agentId] = args;
        const r = await request('GET', `/api/guidelines/${agentId}`);
        console.log('Active guidelines:', JSON.stringify(r, null, 2));
        break;
      }
      case 'stats': {
        const [agentId] = args;
        const r = await request('GET', `/api/stats/${agentId}`);
        console.log('Brainclaw stats:', r);
        break;
      }
      case 'share': {
        const [fromAgent, pattern, guideline, ...rest] = args;
        const category = rest.find(a => a.startsWith('--category='))?.split('=')[1] ?? 'general';
        const r = await request('POST', '/api/shared', { fromAgent, pattern, guideline, category, confidence: 0.7 });
        console.log('Shared hint:', r);
        break;
      }
      case 'task': {
        const [action, agentId, ...rest] = args;
        if (action === 'start') {
          const [intent] = rest;
          const r = await request('POST', '/api/tasks/start', { agentId, intent });
          console.log('Task started:', r.task);
        } else if (action === 'close') {
          const [outcome, ...rArgs] = rest;
          const reward = parseFloat(rArgs.find(a => a.startsWith('--reward='))?.split('=')[1] ?? '0');
          const r = await request('POST', '/api/tasks/close', { agentId, outcome, reward });
          console.log('Task closed, episode:', r.episode);
        } else {
          const r = await request('GET', `/api/tasks/${agentId}`);
          console.log('Open task:', r);
        }
        break;
      }
      case 'ws': {
        const [type, agentId, ...rest] = args;
        if (type === 'register') {
          const r = await wsSend({ type: 'register', agentId, label: rest[0] || agentId });
          console.log('WS registered:', r);
        } else if (type === 'experience') {
          const [userMsg, agentReply] = rest;
          const r = await wsSend({ type: 'experience', agentId, data: { userMessage: userMsg, agentReply } });
          console.log('WS experience:', r);
        } else if (type === 'retrieve') {
          const [context] = rest;
          const r = await wsSend({ type: 'retrieve', agentId, contextText: context });
          console.log('WS retrieve:', r);
        }
        break;
      }
      case 'agents':
        console.log(await request('GET', '/api/agents'));
        break;
      case 'health':
        console.log(await request('GET', '/health'));
        break;
      default:
        console.log(`Brainclaw CLI

register <agentId> [name] [platform] [port]
experience <agentId> <userMsg> <agentReply> [--tool]
feedback <agentId> <reward> [--confidence=0.9] [--note="..."]
retrieve <agentId> <context>
guidelines <agentId>
stats <agentId>
share <fromAgent> <pattern> <guideline> [--category=coding]
task start <agentId> <intent>
task close <agentId> <outcome> [--reward=0]
agents
health
`);
    }
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
}

main();
