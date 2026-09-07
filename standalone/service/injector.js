// The TizenBrew-way of TizenTube. Uses CDP and SDB to inject the userscript.

const adbhost = require('adbhost');
const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');


var isConnecting = false;
const isTizen3 = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version').startsWith('3.0');
const standaloneVersion = tizen.application.getAppInfo().version;

// Confirmed on-device: TizenBrew — a completely separate app/service, not
// sharing any code path with this one — hits the exact same "closes itself,
// needs several relaunches before it works" pattern. That rules out
// anything specific to this app's own code as the sole cause; it points at
// something systemic in how the SDB debug daemon / Cobalt's CDP session
// handling behaves across successive debug-session requests. TizenBrew's
// own debugger.js retries internally (up to 15 attempts) without the user
// needing to do anything — the difference is index.html here calls
// tizen.application.getCurrentApplication().exit() immediately after
// *triggering* the debugger, with no confirmation it actually succeeded; if
// that attempt then fails, there's nothing left alive to retry from, so the
// user has to manually relaunch the whole app every time (what they were
// doing by reopening ~5 times). This makes the service retry automatically
// instead, the way TizenBrew does.
let _activeSessionId = 0;
const MAX_RETRY_ATTEMPTS = 10;
const RETRY_DELAY_MS = 750;

// On this path the page is real https://youtube.com, so a page-initiated
// fetch to http://localhost:8099 (logServer.js's normal standalone relay) is
// cross-origin *and* HTTPS-page-to-HTTP-target — Cobalt blocks that as mixed
// content, silently. logServer.js instead queues log entries into
// window.__ttLogQueue for this path; drain it over the same CDP connection
// already open for injection (same technique TizenBrew's own service uses
// for the equivalent problem) so delivery doesn't depend on page-side
// networking at all.
// Set by index.js. Kept as a module-level hook rather than threaded through
// startDebugger's argument list, so adding syslog does not change the
// signature of the injection path — that path is fragile enough already.
let _relaySyslog = null;
function setSyslogRelay(fn) { _relaySyslog = typeof fn === 'function' ? fn : null; }

function pollLogQueue(client, relayLog) {
    if (typeof relayLog !== 'function') return;

    // The interval below has no lifecycle tied to the CDP connection it
    // depends on. Confirmed on-device: once that connection closes (page
    // navigation, app exit, etc.), every subsequent tick threw an unhandled
    // "WebSocket.send... not opened" rejection on the exact same
    // Chrome.send/enqueueCommand path the real userscript-injection
    // evaluate() call uses — noisy at best, and plausibly contributing
    // instability right when injection is trying to happen. Stop on
    // disconnect, and as a defensive fallback in case that event doesn't
    // fire reliably, also stop after a few consecutive failures.
    // Runs in-page, on the same thread as YouTube's own rendering/JS —
    // confirmed on-device: with only the visual console on (no remote
    // relay), logging is fast with no hangs; with remote relay on, page
    // navigation (e.g. Settings -> Library) hangs. The difference is this
    // poll: it now drains more volume than before (console.* output is
    // unified into the same queue, not just the sparser file-only stream),
    // and JSON.stringify-ing a queue of entries once a second, in-page,
    // competes for CPU right when navigation is also doing real work.
    // Lower frequency (2s) and a smaller worst-case payload (logServer.js's
    // MAX_QUEUE) both reduce that per-poll cost.
    let consecutiveFailures = 0;
    const interval = setInterval(() => {
        client.Runtime.evaluate({
            // Both queues are drained in the same round-trip: syslog adds no
            // extra evaluate() and so no extra in-page cost, which matters
            // because this poll already competes with YouTube's own rendering.
            expression: '(function(){ var q = window.__ttLogQueue || []; window.__ttLogQueue = []; var s = window.__ttSyslogQueue || []; window.__ttSyslogQueue = []; return JSON.stringify({ logs: q, syslog: s }); })()',
            returnByValue: true
        }).then(result => {
            consecutiveFailures = 0;
            const value = result && result.result && result.result.value;
            if (!value) return;
            let drained;
            try { drained = JSON.parse(value); } catch (e) { return; }
            // Older injected bundles returned a bare array of log entries.
            const entries = Array.isArray(drained) ? drained : (drained.logs || []);
            for (const entry of entries) {
                relayLog(entry, entry.__ttLogHost, entry.__ttLogPort);
            }
            if (_relaySyslog) {
                for (const item of (Array.isArray(drained) ? [] : (drained.syslog || []))) {
                    _relaySyslog(item.frame, item.host, item.port);
                }
            }
        }).catch(() => {
            consecutiveFailures++;
            if (consecutiveFailures >= 3) clearInterval(interval);
        });
    }, 2000);

    client.on('disconnect', () => clearInterval(interval));
}

function retryOrGiveUp(sessionId, attempt, args, relayLog, reason) {
    if (sessionId !== _activeSessionId) return; // superseded by a newer attempt, abort silently
    if (attempt >= MAX_RETRY_ATTEMPTS) {
        isConnecting = false;
        if (typeof relayLog === 'function') {
            relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `Giving up after ${MAX_RETRY_ATTEMPTS} attempts (${reason})` });
        }
        return;
    }
    if (typeof relayLog === 'function') {
        relayLog({ ts: new Date().toISOString(), level: 'INFO', context: 'Injector', message: `Retrying (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}) after: ${reason}` });
    }
    setTimeout(() => startDebugger(args, relayLog, sessionId, attempt + 1), RETRY_DELAY_MS);
}

const CONNECT_PROBE_MAX_ATTEMPTS = 20;
const CONNECT_PROBE_RETRY_DELAY_MS = 100;

function connectToDebugger(host, port, args, relayLog, sessionId, attempt, probeAttempt) {
    if (probeAttempt === undefined) probeAttempt = 0;
    fetch(`http://${host}:${port}`).then(_ => {
        CDP({ host, port, local: true }, client => {
            if (sessionId !== _activeSessionId) {
                // A newer top-level call superseded this one while we were
                // still connecting — close this stale client, don't inject.
                try { client.close(); } catch (e) { }
                return;
            }
            // isConnecting deliberately NOT reset here — see the comment on
            // the isConnecting=true assignment in startDebugger for why it
            // now stays true for the whole session (all retries), not just
            // until a CDP socket opens.
            let injected = false;

            // Explicitly close the client on any failure path before
            // retrying, rather than only relying on the natural 'disconnect'
            // event — an evaluate() call can reject without the underlying
            // connection actually dropping, which would otherwise leave this
            // CDP client (and whatever device-side debug session it holds
            // open) dangling while a retry spins up an entirely new one.
            // Suspected of being why TizenBrew — a separate app entirely —
            // also needed several relaunches during the same broken window:
            // if debug sessions are a limited, shared, per-device resource,
            // leaked ones here would starve everyone, not just this app.
            function failAndRetry(reason) {
                try { client.close(); } catch (e) { }
                retryOrGiveUp(sessionId, attempt, args, relayLog, reason);
            }

            client.Runtime.enable();
            // Page.enable() deliberately NOT called — nothing here listens
            // for any Page.* events, and Page.navigate()/setBypassCSP() are
            // commands that don't require the domain enabled to issue.
            // TizenBrew's own debugger.js (same CDP-injection job, doesn't
            // hang after long sessions) never enables it either. Enabling a
            // domain you don't need means CDP tracks its events for the
            // entire session for nothing.

            client.on('disconnect', () => {
                if (!injected) {
                    retryOrGiveUp(sessionId, attempt, args, relayLog, 'CDP disconnected before injection succeeded');
                } else if (sessionId === _activeSessionId) {
                    // The session's CDP connection has now genuinely ended
                    // (the injected youtube.com/tv session is over) — only
                    // now is it safe to clear isConnecting. See the comment
                    // below on why it must NOT clear the moment injection
                    // succeeds.
                    isConnecting = false;
                }
            });

            function logNonFatal(label) {
                return e => {
                    if (typeof relayLog === 'function') {
                        relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `${label} FAILED (non-fatal): ${e && e.stack || e}` });
                    }
                };
            }

            // Confirmed on-device (earlier investigation): standalone
            // reliably worked exactly once after any cache clear, then
            // broke on every subsequent launch until cache/data was cleared
            // again — believed at the time to be genuinely stale
            // cache/cookies/storage, so this cleared all of it (including
            // cookies and localStorage, where the login session lives)
            // before every single navigation.
            //
            // Now believed to have actually been the isConnecting/self-
            // relaunch races fixed elsewhere in this file: confirmed
            // on-device that the app was relaunching itself every ~3-4s
            // continuously (48 "index.html script started" cycles logged
            // for what looked like a handful of app opens), which called
            // this cleanup — and wiped cookies — every single cycle, not
            // just once per real app open. That's why login never
            // persisted. With the self-relaunch loop fixed, clearing the
            // actual login session on every launch is no longer worth the
            // cost of forcing re-login every time. Only the HTTP resource
            // cache is cleared now — cookies/localStorage/IndexedDB (where
            // the login session lives) are left alone. If stale-cache
            // symptoms reappear on retest, that'll need its own targeted
            // fix rather than reinstating a full wipe.
            // Network.enable() is only needed transiently, to issue the two
            // calls below — it's disabled again immediately after, not left
            // on for the rest of the session. Confirmed by comparison with
            // TizenBrew's own debugger.js (same CDP-injection job, same mod,
            // does not hang on long sessions): it never enables the Network
            // domain at all. Left enabled, CDP tracks every single network
            // request for the whole session — every video segment fetch
            // during playback — which plausibly explains a standalone-only
            // hang after ~15 minutes of video that doesn't happen under
            // TizenBrew with the identical mod version.
            const preNavigateCleanup = client.Network.enable()
                .then(() => client.Network.setCacheDisabled({ cacheDisabled: true }).catch(logNonFatal('Network.setCacheDisabled')))
                .then(() => client.Network.clearBrowserCache().catch(logNonFatal('Network.clearBrowserCache')))
                .then(() => client.Network.disable().catch(logNonFatal('Network.disable')))
                .catch(logNonFatal('pre-navigate cleanup chain'));

            // Only start log-polling after injection has actually succeeded
            // once, not immediately alongside Page.navigate() — keeps it
            // fully out of the way of the critical early injection window.
            let logPollStarted = false;
            // Bounds the "Cannot find context" tolerance below — if this
            // connection never lands a single successful injection after
            // several tries, fall back to a real retry instead of waiting
            // forever with isConnecting stuck true and no mod ever injected.
            let contextRaceMisses = 0;
            const MAX_CONTEXT_RACE_MISSES = 5;

            // Fetched once per session and reused for every
            // executionContextCreated event, not re-fetched from the CDN
            // each time. YouTube's own page can create several execution
            // contexts in quick succession while it settles (login
            // redirects, SPA transitions) — re-fetching the whole userscript
            // over the network for each one meant the injection attempt was
            // frequently still fetching by the time that particular context
            // was already replaced ("Cannot find context with specified
            // id"), losing the race — worse on slower hardware (5.5).
            // Started immediately (not lazily on first context) so it's
            // already in flight/cached by the time any context appears.
            const modFilePromise = fetch('https://cdn.jsdelivr.net/npm/@krx3d/tizentube2/dist/userScript.js').then(res => res.text());

            client.on('Runtime.executionContextCreated', m => {
                // Matches TizenBrew's own debugger.js: only inject into the
                // main-frame/default context, not workers, iframes, or
                // isolated worlds. Previously every context creation
                // triggered a full injection attempt regardless of type —
                // plausibly contributing to the "Cannot find context" races
                // (non-default contexts tend to be shorter-lived) and to
                // wasted work over a long session as more of them appear.
                const auxData = (m.context && m.context.auxData) || {};
                if (!auxData.isDefault) return;
                modFilePromise.then(modFile => {
                    // Marker so the userscript can tell it's running under this
                    // standalone app even though this path loads real youtube.com
                    // directly (window.location.hostname isn't 'localhost' here,
                    // unlike the proxy path).
                    return client.Runtime.evaluate({ expression: `window.__ttStandalone = true;\nwindow.__tizenTubeStandaloneVersion = ${JSON.stringify(standaloneVersion)};\n` + modFile, contextId: m.context.id });
                }).then(() => {
                    injected = true;
                    // isConnecting deliberately stays true here, not false —
                    // confirmed on-device: the debug-launched app instance's
                    // OWN index.html script keeps running in the background
                    // even after Page.navigate() has already moved the
                    // visible page to youtube.com/tv (its pending
                    // launchAppControl success callback fires regardless).
                    // That stale callback calls useInjectorOrProxy() again,
                    // and previously — since isConnecting had just gone
                    // false right here — it would see "no session in
                    // progress" and start a whole NEW debug-launch cycle,
                    // tearing down the session that had just started working.
                    // Confirmed on-device: 48 "index.html script started"
                    // cycles logged for what looked like a handful of app
                    // opens, continuously wiping cookies (preNavigateCleanup
                    // runs every cycle) and occasionally losing the injection
                    // race against YouTube's own login-flow navigations.
                    // isConnecting now only clears once the CDP connection
                    // for this successful session actually disconnects (see
                    // the 'disconnect' handler above) — i.e. once the
                    // injected session has genuinely ended.
                    if (typeof relayLog === 'function') {
                        relayLog({ ts: new Date().toISOString(), level: 'INFO', context: 'Injector', message: `Injection evaluate() succeeded for contextId=${m.context.id}` });
                    }
                    if (!logPollStarted) {
                        logPollStarted = true;
                        pollLogQueue(client, relayLog);
                    }
                }).catch(e => {
                    const msg = e && e.message || String(e);
                    if (typeof relayLog === 'function') {
                        relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `Injection evaluate() FAILED for contextId=${m.context.id}: ${e && e.stack || e}` });
                    }
                    // "Cannot find context with specified id" means the page
                    // itself already moved on (e.g. YouTube's own SPA
                    // creating/replacing contexts during its own bootstrap)
                    // before our evaluate() call landed — a transient race,
                    // not a real connection failure. Page.navigate() already
                    // succeeded independently of this, so the page is often
                    // already loading/working fine. Confirmed on-device:
                    // treating this like every other failure and calling
                    // failAndRetry issued a brand new shell:0 debug command
                    // against an app that was already running — which,
                    // observed repeatedly, gets no response at all (Tizen
                    // silently ignores a redundant debug-launch on an
                    // already-debugging app) — burning the full 20s
                    // safety-net timeout on every one of the 10 retry
                    // attempts for nothing, while YouTube sat there already
                    // loaded. The 'Runtime.executionContextCreated' listener
                    // above is persistent, not one-shot, so it already gets
                    // another shot at the next context on this same
                    // connection without needing a whole new session.
                    if (msg.indexOf('Cannot find context') !== -1) {
                        contextRaceMisses++;
                        if (contextRaceMisses < MAX_CONTEXT_RACE_MISSES) return;
                    }
                    failAndRetry(`injection evaluate() failed: ${msg}`);
                });
            });

            // Wait for the cleanup attempts above so the clear actually takes
            // effect before this navigation, rather than racing it.
            preNavigateCleanup.then(() => {
                return client.Page.navigate({ url: `https://youtube.com/tv?additionalDataUrl=http%3A%2F%2Flocalhost%3A8085%2Fdial%2Fapps%2FYouTube${args ? `&${args}` : ''}` });
            }).catch(e => {
                if (typeof relayLog === 'function') {
                    relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `Page.navigate FAILED: ${e && e.stack || e}` });
                }
                failAndRetry(`Page.navigate failed: ${e && e.message || e}`);
            });

            // Confirmed on-device (Tizen 5.5): Cobalt's CDP implementation
            // doesn't support this method at all ('Page.setBypassCSP' wasn't
            // found) — an unhandled rejection right alongside Page.navigate().
            // Injection here is via Runtime.evaluate() of the userscript text
            // directly, not a page-loaded <script src> that CSP would block,
            // so this call was never actually load-bearing for injection to
            // work; catch it so an unsupported protocol method can't produce
            // an unhandled rejection here regardless of whether it's also
            // contributing to the connection instability seen on both TVs.
            client.Page.setBypassCSP({ enabled: true }).catch(e => {
                if (typeof relayLog === 'function') {
                    relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `Page.setBypassCSP FAILED (non-fatal, not required for eval-based injection): ${e && e.stack || e}` });
                }
            });
        })
    }).catch(e => {
        if (sessionId !== _activeSessionId) return; // superseded, stop waiting
        // Confirmed: safetyTimeout is already cleared right before
        // connectToDebugger is called (once the debug shell responded), so
        // this was the one remaining unbounded retry loop in this file —
        // if the CDP port never actually comes up, this spun a fetch every
        // 100ms forever with zero logging and no other safety net covering
        // it. Bounded locally (2s total) before falling back to the
        // existing session-level retry/give-up machinery, which re-issues
        // a fresh shell:0 debug rather than continuing to probe a port
        // that may never open.
        if (probeAttempt >= CONNECT_PROBE_MAX_ATTEMPTS) {
            if (typeof relayLog === 'function') {
                relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `CDP port ${port} never came up after ${CONNECT_PROBE_MAX_ATTEMPTS} probes: ${e && e.message || e}` });
            }
            return retryOrGiveUp(sessionId, attempt, args, relayLog, `CDP port never opened: ${e && e.message || e}`);
        }
        return setTimeout(() => connectToDebugger(host, port, args, relayLog, sessionId, attempt, probeAttempt + 1), CONNECT_PROBE_RETRY_DELAY_MS);
    })
}

const CAN_CONNECT_MAX_ATTEMPTS = 10;
const CAN_CONNECT_RETRY_DELAY_MS = 500;

// getState (index.js) polls this every ~1s during normal operation, so it
// must always resolve quickly — never reject, never hang indefinitely.
// Previously any failure (network hiccup, JSON parse error, anything) just
// called canConnectToDaemon() again immediately, recursively, with no
// delay, no attempt limit, and no logging — a silent, unbounded tight loop
// if the local Tizen debug-info endpoint ever started failing. Confirmed
// on-device: a session got stuck with isConnecting true for minutes, with
// zero [Injector] log lines the entire time — consistent with being stuck
// somewhere before the ADB-connect stage (which does have its own
// timeout/logging), and this was the one remaining unbounded, unlogged
// retry in that path. Bounded here with backoff and (when a relayLog is
// given, i.e. only the startDebugger call site, not every getState poll)
// logging on each failure — after exhausting attempts, resolves with
// canConnectToDaemon:false rather than hanging forever.
function canConnectToDaemon(relayLog, attempt) {
    if (attempt === undefined) attempt = 0;
    return fetch('http://127.0.0.1:8001/api/v2/').then(res => res.json())
        .then(json => {
            return { canConnectToDaemon: (json.device.developerIP === '127.0.0.1' || json.device.developerIP === '1.0.0.127') && json.device.developerMode === '1', ip: json.device.ip, isConnecting }
        }).catch(e => {
            if (attempt >= CAN_CONNECT_MAX_ATTEMPTS) {
                if (typeof relayLog === 'function') {
                    relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `canConnectToDaemon giving up after ${CAN_CONNECT_MAX_ATTEMPTS} attempts: ${e && e.message || e}` });
                }
                return { canConnectToDaemon: false, ip: null, isConnecting };
            }
            if (typeof relayLog === 'function') {
                relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `canConnectToDaemon attempt ${attempt + 1}/${CAN_CONNECT_MAX_ATTEMPTS} failed, retrying: ${e && e.message || e}` });
            }
            return new Promise(resolve => setTimeout(resolve, CAN_CONNECT_RETRY_DELAY_MS))
                .then(() => canConnectToDaemon(relayLog, attempt + 1));
        });
}

function startDebugger(args, relayLog, sessionId, attempt) {
    if (sessionId === undefined) {
        // Fresh top-level call (not a retry) — starts a new session,
        // superseding any retry loop still in flight from a previous one.
        _activeSessionId++;
        sessionId = _activeSessionId;
        // Set for the ENTIRE session up front, not just once an ADB/CDP
        // socket happens to be open. Confirmed on-device: every retry-path
        // handler below used to reset this back to false right before
        // scheduling its retry, leaving a real window (the 750ms
        // RETRY_DELAY_MS gap, or longer) where a freshly (re)launched
        // index.html could poll getState, see isConnecting:false, and
        // conclude "ready" — triggering its OWN brand-new top-level
        // /tizentube/debugger call. That call resets _activeSessionId's
        // attempt counter back to 0, which silently defeats
        // MAX_RETRY_ATTEMPTS forever: every hijack is itself a real
        // shell:0 debug launch (it steals the foreground, matching "closes
        // itself / reopens itself even from another app"), and each one
        // re-arms a fresh 10-attempt budget instead of ever reaching it.
        // Only a TV reboot (wiping this module's in-memory state) broke
        // the cycle. isConnecting now only goes false at the two true
        // terminal points: a successful injection, or actually giving up
        // after MAX_RETRY_ATTEMPTS.
        isConnecting = true;
    } else if (sessionId !== _activeSessionId) {
        return Promise.resolve(false); // superseded, abort silently
    }
    if (attempt === undefined) attempt = 0;

    return canConnectToDaemon(relayLog).then(res => {
        if (!res.canConnectToDaemon) {
            // Previously a silent `return false` here — isConnecting was
            // already set true for this session and nothing on this path
            // ever reset it, so a genuine (not just transiently-failing)
            // canConnectToDaemon:false result left the session stuck
            // forever with zero logging. Route it through the same
            // retry/give-up machinery as every other failure path instead.
            retryOrGiveUp(sessionId, attempt, args, relayLog, 'canConnectToDaemon returned false (developer mode / Host PC IP not set to 127.0.0.1?)');
            return false;
        }
        if (sessionId !== _activeSessionId) return false; // superseded while checking
        const client = adbhost.createConnection({ host: '127.0.0.1', port: 26101 });

        // No 'error' listener previously existed on this stream at all — in
        // Node, an EventEmitter that emits 'error' with zero listeners
        // throws, which can crash the whole service process uncaught. That
        // would explain a service that silently disappears mid-attempt with
        // no log line at all (relayLog itself needs the process alive).
        client._stream.on('error', (err) => {
            if (sessionId !== _activeSessionId) return;
            if (typeof relayLog === 'function') {
                relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `ADB stream error before shell command: ${err && err.stack || err}` });
            }
            retryOrGiveUp(sessionId, attempt, args, relayLog, `ADB stream error: ${err && err.message || err}`);
        });

        // 'connect' never firing at all (daemon busy/unreachable) was
        // previously an indefinite, silent hang — nothing else in this
        // function would ever run, and no timeout existed to notice.
        const connectTimeout = setTimeout(() => {
            if (sessionId !== _activeSessionId) return;
            if (typeof relayLog === 'function') {
                relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: 'ADB stream never connected within 5s' });
            }
            try { client._stream.end(); } catch (e) { }
            retryOrGiveUp(sessionId, attempt, args, relayLog, 'ADB stream connect timeout');
        }, 5000);

        client._stream.on('connect', () => {
            clearTimeout(connectTimeout);
            if (sessionId !== _activeSessionId) {
                try { client._stream.end(); } catch (e) { }
                return;
            }
            const packageId = tizen.application.getAppInfo().packageId;
            if (typeof relayLog === 'function') {
                relayLog({ ts: new Date().toISOString(), level: 'INFO', context: 'Injector', message: `ADB connected, requesting shell:0 debug ${packageId}.TizenTubeStandalone` });
            }

            // Safety net: without this, a stuck attempt (no debug shell
            // response, no CDP connection) would hang until something else
            // intervened. Confirmed on-device: because the service is
            // long-running in the background, that stuck state persisted
            // across every subsequent app launch until a full TV reboot
            // killed the service process. Re-armed on every retry attempt
            // (not just the first) so the whole retry budget (up to
            // MAX_RETRY_ATTEMPTS) is covered, not just one attempt's worth —
            // harmless no-op if a connection already succeeded by the time
            // this fires. Does NOT touch isConnecting — see the comment on
            // isConnecting=true in startDebugger for why it stays true
            // across every retry in this session, only going false at the
            // two true terminal points (success, or actually giving up).
            const safetyTimeout = setTimeout(() => {
                if (sessionId !== _activeSessionId) return;
                if (typeof relayLog === 'function') {
                    relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: 'Safety-net timeout: no debug shell response or CDP connection within 20s' });
                }
                retryOrGiveUp(sessionId, attempt, args, relayLog, 'safety-net 20s timeout');
            }, 20000);

            // Always end this ADB stream, whether or not the debug line
            // ever appears — previously only happened inside the
            // dataString.includes('debug') branch, leaving the stream open
            // indefinitely on any attempt where that never matched. An ADB
            // host connection never released is exactly the kind of leak
            // that could starve later debug-session attempts, from this
            // app or (if it's a shared, per-device resource) any other.
            let streamEnded = false;
            const endStreamOnce = () => {
                if (streamEnded) return;
                streamEnded = true;
                try { client._stream.end(); } catch (e) { }
            };
            const streamEndFallback = setTimeout(endStreamOnce, 5000);

            const shellCmd = client.createStream(`shell:0 debug ${packageId}.TizenTubeStandalone${isTizen3 ? ' 0' : ''}`);
            shellCmd.on('error', (err) => {
                if (typeof relayLog === 'function') {
                    relayLog({ ts: new Date().toISOString(), level: 'ERROR', context: 'Injector', message: `shell:0 debug stream error: ${err && err.stack || err}` });
                }
                clearTimeout(safetyTimeout);
                endStreamOnce();
                retryOrGiveUp(sessionId, attempt, args, relayLog, `shell stream error: ${err && err.message || err}`);
            });
            shellCmd.on('data', (data) => {
                const dataString = data.toString();
                // Always log the raw response — previously only logged (and
                // acted on) when it contained 'debug'; anything else (an
                // error from the device's wascmd dispatcher, an empty/
                // unexpected reply, a package-id mismatch after a reinstall)
                // was silently dropped, with no way to ever see it.
                if (typeof relayLog === 'function') {
                    relayLog({ ts: new Date().toISOString(), level: 'INFO', context: 'Injector', message: `shell:0 debug raw response: ${JSON.stringify(dataString.slice(0, 500))}` });
                }
                if (dataString.includes('debug')) {
                    const port = Number(dataString.substr(dataString.indexOf(':') + 1, 6).replace(' ', ''));
                    clearTimeout(safetyTimeout);
                    connectToDebugger(res.ip, port, args, relayLog, sessionId, attempt);
                    clearTimeout(streamEndFallback);
                    setTimeout(endStreamOnce, 1000);
                }
            });
        });

        return true;
    });
}

module.exports = {
    setSyslogRelay,
    startDebugger,
    canConnectToDaemon
};