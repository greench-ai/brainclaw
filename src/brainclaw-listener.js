#!/usr/bin/env node
/**
 * Brainclaw Persistent Listener
 * Stays connected to Brainclaw pub/sub, logs all broadcasts
 * Auto-reconnects on disconnect
 *
 * Usage:
 *   node brainclaw-listener.js --agent akuma --channel team --url ws://100.82.67.48:3002
 *
 * Runs 24/7 as a background process
 */

import { WebSocket } from 'ws';
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';

const { values } = parseArgs({
  options: {
    agent:   { type: 'string', default: 'akuma' },
    channel: { type: 'string', default: 'team' },
    url:     { type: 'string', default: 'ws://127.0.0.1:3002' },
    label:   { type: 'string' },
    log:     { type: 'string', default: '' },  // optional log file
  }
});

const AGENT   = values.agent;
const CHANNEL = values.channel;
const WS_URL  = values.url;
const LABEL   = values.label || `${AGENT}-listener`;
const LOG_FILE = values.log;

const LOG = (...args) => {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${LABEL}] ${args.join(' ')}`;
  console.log(line);
  if (LOG_FILE) {
    try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
  }
};

let ws;
let retries = 0;
const MAX_RETRIES = 50;
const BASE_DELAY = 2000;

function connect() {
  LOG(`Connecting to ${WS_URL}...`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    retries = 0;
    LOG(`Connected! Registering as ${AGENT}...`);
    ws.send(JSON.stringify({ type: 'register', agentId: AGENT, label: LABEL }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'subscribe', channel: CHANNEL }));
      LOG(`Subscribed to #${CHANNEL}. Listening for broadcasts...`);
      ws.send(JSON.stringify({
        type: 'broadcast',
        channel: CHANNEL,
        text: `${LABEL} connected — listening for team broadcasts`
      }));
    }, 200);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'broadcast') {
      LOG(`📢 [#${msg.channel}] ${msg.from}: ${msg.text}`);
    }
  });

  ws.on('close', () => {
    LOG(`Disconnected.`);
    if (retries < MAX_RETRIES) {
      retries++;
      const delay = Math.min(BASE_DELAY * Math.pow(1.5, retries - 1), 60000);
      LOG(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${retries}/${MAX_RETRIES})...`);
      setTimeout(connect, delay);
    } else {
      LOG(`Max retries reached. Exiting.`);
      process.exit(1);
    }
  });

  ws.on('error', (err) => {
    LOG(`WS error: ${err.message}`);
  });
}

connect();

// Keep process alive
process.on('SIGTERM', () => { LOG('Received SIGTERM, exiting.'); process.exit(0); });
process.on('SIGINT',  () => { LOG('Received SIGINT, exiting.');  process.exit(0); });
