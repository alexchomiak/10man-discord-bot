'use strict';

require('dotenv').config();

const { Client } = require('discord.js-selfbot-v13');
const { loadConfig, redactToken, TAG } = require('./config');
const { CommandRegistry } = require('./commands');
const { StreamManager } = require('./streamManager');
const { resolveSource } = require('./sources');
const { createWebhookServer } = require('./webhookServer');
const { StreamControl } = require('./control');
const { StreamBrokerClient } = require('./brokerClient');

const config = loadConfig();
const client = new Client({});
const streamManager = new StreamManager(client, config.streamChannelId, config);
const commands = new CommandRegistry({ client, streamManager });
const control = new StreamControl({ streamManager, config, client });
const brokerClient = new StreamBrokerClient({
  url: config.brokerUrl,
  secret: config.brokerSecret,
  workerId: config.workerId,
  control,
  streamManager,
  log
});
const prefix = config.commandPrefix;
const sourcesModule = { resolveSource };
const webhookServer = config.webhookEnabled
  ? createWebhookServer({ config, streamManager, sources: sourcesModule })
  : null;

// TEMPORARY DIAGNOSTIC (NOT part of normal operation) -------------------------
// Gated by VERBOSE=true plus SBOT_DEBUG_RAW=1; NO-OP otherwise.
// Attaches raw/shard-lifecycle tracing plus a shard state snapshot so we can
// tell whether the gateway is CONNECTED+READY and whether outbound voice ops
// are actually reaching the socket. Safe to remove after the investigation.
try {
  const _sbRawEnabled = () => {
    if (!config.verbose) return false;
    const v = String(process.env.SBOT_DEBUG_RAW || '');
    return v === '1' || v === 'true';
  };
  const _sbFmt = (...parts) => {
    const out = parts
      .map(v => {
        try {
          if (v == null) return String(v);
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        } catch { return '<unserializable>'; }
      })
      .join(' ');
    return out.length > 480 ? out.slice(0, 480) + '…(truncated)' : out;
  };
  const _sbLog = (...parts) => {
    if (!_sbRawEnabled()) return;
    try { console.log('[streambot:raw]', ...parts); } catch { /* never throw */ }
  };
  const _sbShardState = () => {
    try {
      const ws = client.ws;
      const s = ws && ws.shards ? ws.shards.first() : null;
      const conn = s && s.connection ? s.connection : null;
      return `_shard=${s ? s.id : 'none'} shardStatus=${s ? s.status : 'n/a'} wsStatus=${ws ? ws.status : 'n/a'} connPresent=${conn ? 'yes' : 'no'} shards=${ws && ws.shards ? ws.shards.size : 'n/a'} sessionId=${s ? (s.sessionId || 'null') : 'n/a'}`;
    } catch { return 'state=unknown'; }
  };
  client.on('shardReady', (id) => { _sbLog('EVENT shardReady id=' + id + ' | ' + _sbShardState()); });
  client.on('shardReconnecting', (id) => { _sbLog('EVENT shardReconnecting id=' + id + ' | ' + _sbShardState()); });
  client.on('shardDisconnect', (ev) => { _sbLog('EVENT shardDisconnect code=' + ((ev && ev.code) ?? 'n/a') + ' reason=' + ((ev && ev.reason) ?? 'n/a') + ' wasClean=' + ((ev && ev.wasClean) ?? 'n/a')); });
  client.on('shardError', (err) => { _sbLog('EVENT shardError ' + _sbFmt(err && (err.message || err.code || String(err)))); });
  // Outbound interceptor: ALWAYS forwards to the original broadcast (zero
  // behavior change); only APPENDS a log line when SBOT_DEBUG_RAW is set.
  // Proves the op-4 null-clear + op-4 join actually leave the socket.
  {
    const origBroadcast = client.ws.broadcast.bind(client.ws);
    client.ws.broadcast = (packet) => {
      if (_sbRawEnabled()) {
        try {
          const op = (packet && packet.op != null) ? packet.op : 'n/a';
          const d = (packet && packet.d) || null;
          let detail = 'n/a';
          if (d && typeof d === 'object') {
            const g = d.guild_id, c = d.channel_id, sv = d.self_video, sm = d.self_mute, sd = d.self_deaf;
            detail = `_g=${g ?? null} ch=${c ?? null} self_video=${sv ?? '-'} self_mute=${sm ?? '-'} self_deaf=${sd ?? '-'}`;
          }
          _sbLog('OUT broadcast op=' + op + ' ' + detail + ' ' + _sbFmt('d=', d));
        } catch { /* never throw */ }
      }
      return origBroadcast(packet);
    };
  }
  client.on('raw', (packet) => {
    if (!_sbRawEnabled()) return;
    try {
      const op = (packet && packet.op != null) ? packet.op : 'n/a';
      const t = (packet && packet.t != null) ? packet.t : '-';
      _sbLog('RAW op=' + op + ' t=' + t + ' ' + _sbFmt('d=', (packet && packet.d) || null));
    } catch { /* never throw */ }
  });
} catch { /* the diagnostic must never break boot */ }
// -----------------------------------------------------------------------------

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
  if (brokerClient.enabled) brokerClient.start();
  else log(`[streambot:${config.workerId}] broker disabled: STREAM_BROKER_SECRET or STREAM_BROKER_URL is missing`);
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

// Gateway-event trace for diagnosing the "bot joins deafened, no video" hang:
// selfbot tokens sometimes lack the go-live stream opcodes, so the library's
// createStream() awaits forever. Off by default; VERBOSE=true and
// SBOT_DEBUG=1 enable it.
const DEBUG_T = new Set(['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE', 'STREAM_CREATE', 'STREAM_SERVER_UPDATE']);
client.on('raw', (d) => {
  if (!config.verbose) return;
  if (process.env.SBOT_DEBUG !== '1' && process.env.SBOT_DEBUG !== 'true') return;
  if (!d || typeof d !== 'object') return;
  const t = d.t != null ? String(d.t) : null;
  if ((d.op != null && t && DEBUG_T.has(t)) || t === 'STREAM_CREATE' || (d.op != null && d.d && typeof d.d.stream_key === 'string')) {
    console.log(`[streambot:debug] ${d.op != null ? d.op : 'raw'} t=${t || (d.d && typeof d.d.stream_key === 'string' ? 'stream_key' : '?')}`);
  }
});

client.on('ready', onReady);
if (config.chatCommands) client.on('messageCreate', onMessage);
client.on('error', (err) => {
  log('client error:', safe(err && err.message));
});
client.on('warn', (msg) => {
  log('client warn:', safe(msg));
});
client.on('shardDisconnect', (event, shardId) => {
  log(`Discord gateway disconnected (shard ${shardId}, code ${event?.code ?? 'unknown'})`);
});
client.on('shardReconnecting', shardId => {
  log(`Discord gateway reconnecting (shard ${shardId})`);
});
client.on('shardResume', (shardId, replayedEvents) => {
  log(`Discord gateway resumed (shard ${shardId}, replayed ${replayedEvents} events)`);
});
client.on('invalidated', () => {
  log('Discord session invalidated; a fresh login is required');
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
  try { brokerClient.close(); } catch (e) {}
  try {
    await streamManager.stop();
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
    if (webhookServer) {
      webhookServer.listen(config.webhookPort, config.webhookHost, () => {
        const secretSet = config.webhookSecret ? 'SET' : 'NOT SET';
        log(`webhook listening on http://${config.webhookHost}:${config.webhookPort}/webhook/stream (secret: ${secretSet})`);
      });
      webhookServer.on('error', (err) => {
        logError(`webhook server error: ${safe(err && err.message)}`);
      });
    }
  } catch (err) {
    log(`login failed: ${safe(err && err.message)}`);
    await shutdown('login-failed').catch(() => {});
    process.exit(1);
  }
})();
