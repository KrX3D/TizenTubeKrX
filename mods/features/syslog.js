import { configRead } from '../config.js';

/**
 * syslog.js — RFC 5424 output, independent of the existing log server.
 *
 * Deliberately kept separate from logServer.js rather than replacing it: the
 * PS1 receiver path is what currently works on-device, so syslog is added
 * alongside it. Either can be on without the other, and a broken syslog
 * target cannot stop the log server from delivering.
 *
 * The page cannot speak syslog itself. Syslog is UDP (or TCP), and this code
 * runs in a browser context — Cobalt blocks raw sockets, and logServer.js
 * already documents that even XHR and WebSocket are unavailable from the
 * HTTPS YouTube page. So the page formats the message and a Node process
 * emits the datagram:
 *
 *   proxy path (page served from localhost:8099)
 *       → POST /tizentube/syslog on the standalone service, which sends UDP
 *
 *   CDP path (page is real youtube.com) and TizenBrew
 *       → window.__ttSyslogQueue, drained over the CDP connection that is
 *         already open, then sent from the service side
 *
 * Format (RFC 5424):
 *   <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID STRUCTURED-DATA MSG
 *
 * The label ("playlist.batch_collect.fetching") maps onto MSGID, which means
 * a syslog server can filter by feature the same way the in-app log
 * categories do.
 */

const SYSLOG_VERSION = 1;
const NILVALUE = '-';

// Keep a datagram comfortably inside the ~1KB that is safe to assume for UDP
// syslog without path MTU discovery. Longer messages are split, with the part
// marker carried in structured data rather than glued into the text so the
// message itself stays parseable.
const MAX_MSG_BYTES = 900;

// RFC 5424 severities. The codebase only ever emits INFO/WARN/ERROR/DEBUG.
const SEVERITY = {
  EMERG: 0, ALERT: 1, CRIT: 2, ERROR: 3, ERR: 3,
  WARN: 4, WARNING: 4, NOTICE: 5, INFO: 6, DEBUG: 7,
};

export function isSyslogEnabled() {
  try { return !!configRead('syslogEnabled') && !!configRead('syslogHost'); } catch { return false; }
}

function severityFor(level) {
  const key = String(level || 'INFO').toUpperCase();
  return SEVERITY[key] === undefined ? SEVERITY.INFO : SEVERITY[key];
}

// PRI = facility * 8 + severity. Facility defaults to 16 (local0), the
// conventional range for application-defined use.
function priority(level) {
  let facility = Number(configRead('syslogFacility'));
  if (!Number.isFinite(facility) || facility < 0 || facility > 23) facility = 16;
  return (facility * 8) + severityFor(level);
}

// PRINTUSASCII, no spaces, no '=', ']' or '"'. Anything else is dropped so a
// malformed field can't break the frame for the receiver.
function sanitize(value, max) {
  const out = String(value == null ? '' : value).replace(/[^\x21-\x7E]/g, '').replace(/[\]="]/g, '');
  if (!out) return NILVALUE;
  return out.slice(0, max);
}

function hostname() {
  try {
    const configured = configRead('syslogHostname');
    if (configured) return sanitize(configured, 255);
  } catch (_) { }
  // No reliable device name is exposed to the page; the host part of the
  // page URL is the closest stable identifier available.
  try { return sanitize(window.location.hostname || 'tizentube', 255); } catch (_) { }
  return 'tizentube';
}

function structuredData(entry, part, totalParts) {
  const pairs = [];
  if (entry.context) pairs.push(`context="${String(entry.context).replace(/["\\\]]/g, '')}"`);
  if (totalParts > 1) pairs.push(`part="${part}" parts="${totalParts}"`);
  if (!pairs.length) return NILVALUE;
  return `[tizentube@0 ${pairs.join(' ')}]`;
}

/**
 * Build one RFC 5424 frame.
 *
 * @param {object} entry  { ts, level, context, label, message }
 * @param {string} message the (possibly chunked) message text
 */
export function formatSyslog(entry, message, part = 1, totalParts = 1) {
  const ts = entry.ts || new Date().toISOString();
  const appName = sanitize(configRead('syslogAppName') || 'TizenTube', 48);
  const msgId = sanitize(entry.label || 'log', 32);
  return `<${priority(entry.level)}>${SYSLOG_VERSION} ${ts} ${hostname()} ${appName} ${NILVALUE} ${msgId} ${structuredData(entry, part, totalParts)} ${message}`;
}

// Mirrors logServer.js's cap so a stuck relay can't grow this without bound.
const MAX_QUEUE = 100;

function queue(frame, host, port) {
  if (!Array.isArray(window.__ttSyslogQueue)) window.__ttSyslogQueue = [];
  if (window.__ttSyslogQueue.length < MAX_QUEUE) {
    window.__ttSyslogQueue.push({ frame, host, port });
  }
}

function deliver(frame) {
  const host = configRead('syslogHost');
  const port = Number(configRead('syslogPort')) || 514;
  if (!host) return false;

  // Same-origin plain HTTP: the standalone service can be reached directly.
  if (window.location.hostname === 'localhost') {
    try {
      fetch('http://localhost:8099/tizentube/syslog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port, frame }),
      }).catch(function () { });
      return true;
    } catch (_) {
      // fall through to the queue
    }
  }

  // HTTPS page: a fetch to http://localhost is cross-origin and mixed
  // content, which Cobalt blocks outright. Queue for the CDP drain instead.
  queue(frame, host, port);
  return true;
}

export function sendSyslog(entry) {
  if (!isSyslogEnabled()) return false;
  try {
    const message = String((entry && entry.message) || '');
    if (message.length <= MAX_MSG_BYTES) return deliver(formatSyslog(entry, message));

    const totalParts = Math.ceil(message.length / MAX_MSG_BYTES);
    let sent = false;
    for (let i = 0; i < totalParts; i++) {
      const chunk = message.slice(i * MAX_MSG_BYTES, (i + 1) * MAX_MSG_BYTES);
      if (deliver(formatSyslog(entry, chunk, i + 1, totalParts))) sent = true;
    }
    return sent;
  } catch (_) {
    return false;
  }
}

/**
 * Send a one-off frame so the user can confirm the receiver is listening,
 * matching the log server's own "Test Connection" button.
 */
export function sendSyslogTest() {
  if (!configRead('syslogEnabled')) return { enabled: false, queued: false };
  if (!configRead('syslogHost')) return { enabled: true, queued: false, noHost: true };
  const queued = sendSyslog({
    ts: new Date().toISOString(),
    level: 'INFO',
    context: 'TizenTube',
    label: 'syslog.test',
    message: 'Manual syslog test frame',
  });
  return { enabled: true, queued };
}
