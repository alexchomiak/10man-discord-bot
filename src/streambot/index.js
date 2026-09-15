'use strict';

require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const { loadConfig, redactToken, TAG } = require('./config');
const { CommandRegistry } = require('./commands');
const { StreamManager } = require('./streamManager');
const { resolveSource } = require('./sources');
const { createWebhookServer } = require('./webhookServer');

const config = loadConfig();
const client = new Client({});
const streamManager = new StreamManager(client, config.streamChannelId, config);
const commands = new CommandRegistry({ client, streamManager });
const prefix = config.commandPrefix;
const sourcesModule = { resolveSource };
const webhookServer = createWebhookServer({ config, streamManager, sources: sourcesModule });

let shuttingDown = false;

function log(...parts) {
  console.log(TAG, ...parts);
}

function logError(...parts) {
  console.error(TAG, ...parts);
}

function safe(str) {
  return redactToken(String(str || ''), config.token);
}

function onReady() {
  const user = client && client.user;
  const name = user && user.username ? user.username : 'self';
  const id = user && user.id ? user.id : 'unknown';
  log(`Logged in as ${name} (${id})`);
}

function onMessage(message) {
  try {
    if (!message || typeof message.content !== 'string') return;
    if (message.author && message.author.bot) return;
    const content = message.content;
    if (!content.startsWith(prefix)) return;
    const rest = content.slice(prefix.length).replace(/^\s+/, '');
    if (!rest) return;
    void commands.dispatch(message, rest).catch((err) => {
      log('dispatch error:', safe(err && err.message));
    });
  } catch (err) {
    log('onMessage error:', safe(err && err.message));
  }
}

client.on('ready', onReady);
client.on('messageCreate', onMessage);
client.on('error', (err) => {
  log('client error:', safe(err && err.message));
});
client.on('warn', (msg) => {
  log('client warn:', safe(msg));
});

function closeWebhook() {
  return new Promise((resolve) => {
    if (!webhookServer) return resolve();
    webhookServer.close(() => resolve());
    setTimeout(resolve, 1000).unref();
  });
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down:', reason || 'signal');
  try {
    await closeWebhook();
  } catch (e) {}
  try {
    streamManager.stop(null);
  } catch (e) {}
  try {
    await client.destroy();
  } catch (e) {}
  process.exit(0);
}

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    void shutdown(sig).catch(() => {});
  });
});

process.on('unhandledRejection', (reason) => {
  log('unhandledRejection:', safe(reason && reason.message));
});

void (async () => {
  try {
    await client.login(config.token);
    log('login issued, awaiting ready…');
    webhookServer.listen(config.webhookPort, config.webhookHost, () => {
      const secretSet = config.webhookSecret ? 'SET' : 'NOT SET';
      log(`webhook listening on http://${config.webhookHost}:${config.webhookPort}/webhook/stream (secret: ${secretSet})`);
    });
    webhookServer.on('error', (err) => {
      logError(`webhook server error: ${safe(err && err.message)}`);
    });
  } catch (err) {
    log(`login failed: ${safe(err && err.message)}`);
    await shutdown('login-failed').catch(() => {});
    process.exit(1);
  }
})();
