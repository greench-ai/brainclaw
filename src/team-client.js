#!/usr/bin/env node
/**
 * Brainclaw Team Client
 * Lightweight WebSocket client for joining the team pub/sub
 * 
 * Usage:
 *   node team-client.js --agent fuma --channel team
 *   node team-client.js --agent nexus --channel team --url ws://127.0.0.1:3002
 *
 * Works on: Node.js 18+, should work across all platforms
 */

import { WebSocket } from 'ws';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    agent:   { type: 'string', default: 'unknown' },
    channel: { type: 'string', default: 'team' },
    url:     { type: 'string', default: 'ws://127.0.0.1:3002' },
    name:    { type: 'string' },
    token:   { type: 'string' },
    help:    { type: 'boolean', default: false },
  }
});

if (values.help) {
  console.log(`
Brainclaw Team Client
Usage: node team-client.js [options]

Options:
  --agent   Agent ID (e.g. fuma, kojiro, nexus, sasuke)
  --channel Channel to join (default: team)
  --url     Brainclaw WebSocket URL (default: ws://127.0.0.1:3002)
  --name    Display name (default: agent value)

Examples:
  node team-client.js --agent fuma --channel team
  node team-client.js --agent nexus --channel nexus
  `);
  process.exit(0);
}

const AGENT   = values.agent;
const CHANNEL = values.channel;
const WS_URL  = values.url;
const NAME    = values.name || AGENT;

console.log(`[${NAME}] Connecting to Brainclaw at ${WS_URL}...`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log(`[${NAME}] Connected. Registering as ${AGENT}...`);
  ws.send(JSON.stringify({ type: 'register', agentId: AGENT, label: NAME }));

  // Subscribe to channel after registration (wait for registered ack)
  setTimeout(() => {
    console.log(`[${NAME}] Subscribing to #${CHANNEL}...`);
    ws.send(JSON.stringify({ type: 'subscribe', channel: CHANNEL }));
    console.log(`[${NAME}] Joined #${CHANNEL}. Waiting for messages...`);
    console.log(`[${NAME}] Commands: type 'broadcast <text>' to send, 'quit' to exit`);
    prompt();
  }, 200);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  switch (msg.type) {
    case 'welcome':
      console.log(`[${NAME}] Welcome! Client ID: ${msg.clientId}`);
      break;
    case 'registered':
      console.log(`[${NAME}] Registered as ${msg.agentId}`);
      break;
    case 'subscribed':
      console.log(`[${NAME}] Subscribed to #${msg.channel}`);
      break;
    case 'broadcast':
      if (msg.from !== AGENT) {
        console.log(`\n[${msg.channel}] ${msg.from}: ${msg.text}`);
        prompt();
      }
      break;
    case 'pong':
      // ignore
      break;
    default:
      if (msg.type !== 'pong') console.log(`[${NAME}] Unknown message:`, msg.type);
  }
});

ws.on('close', () => {
  console.log(`[${NAME}] Disconnected. Reconnecting in 5s...`);
  setTimeout(() => { process.stdout.write('\n'); start(); }, 5000);
});

ws.on('error', (err) => {
  console.error(`[${NAME}] WS error:`, err.message);
});

// ── Interactive input ─────────────────────────────────────────────────────

function prompt() {
  process.stdout.write(`[${NAME}] > `);
}

function start() {
  // Simple repl for broadcasting
  prompt();
}

import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) { prompt(); return; }
  if (text === 'quit' || text === 'exit') {
    console.log(`[${NAME}] Goodbye!`);
    ws.close();
    process.exit(0);
  }
  if (text.startsWith('broadcast ')) {
    const msg = text.slice(10);
    ws.send(JSON.stringify({ type: 'broadcast', channel: CHANNEL, text: msg }));
    console.log(`[${NAME}] Sent to #${CHANNEL}: ${msg}`);
  } else {
    // Default: broadcast to team channel
    ws.send(JSON.stringify({ type: 'broadcast', channel: CHANNEL, text: text }));
  }
  prompt();
});

ws.on('error', (err) => {
  console.error(`[${NAME}] Connection error: ${err.message}`);
  rl.close();
});
