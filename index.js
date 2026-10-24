import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'touchpad-sense';
export const inject = ['tools', 'agents', 'timer', 'webServer'];

const collectorPath = join(dirname(fileURLToPath(import.meta.url)), 'collector', 'bin', 'Release', 'net8.0', 'TouchpadCollector.exe');
const MAX_EVENTS = 128;
const EVENT_TTL_MS = 60_000;
const CONTEXT_TTL_MS = 12_000;
const WAKE_EVENT_TTL_MS = 15_000;
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const wakeConfigPath = join(dshHome, 'touchpad-sense-config.json');
const workspacePath = join(dshHome, 'storages', 'workspace.json');
const projectionPath = join(dshHome, 'storages', 'session_projcache', 'sessions');
const deviceFilter = process.env.DSH_TOUCHPAD_DEVICE_FILTER?.trim() || 'BLTP785';

function sessionKey(value) {
  return String(value || '').replace(/^session-/, '');
}

function loadWakeConfig() {
  try {
    const value = JSON.parse(readFileSync(wakeConfigPath, 'utf8'));
    return {
      captureEnabled: value.captureEnabled === true,
      enabled: value.enabled !== false,
      targetSessionId: typeof value.targetSessionId === 'string' ? value.targetSessionId : '',
      cooldownSeconds: Math.max(5, Math.min(300, Number(value.cooldownSeconds) || 30)),
    };
  } catch { return { captureEnabled: false, enabled: true, targetSessionId: '', cooldownSeconds: 30 }; }
}

function defaultWorkspace() {
  try {
    const data = JSON.parse(readFileSync(workspacePath, 'utf8'));
    const workspace = data.tables?.workspaces?.[data.global?.defaultWorkspaceId];
    return {
      ids: new Set((workspace?.sessionIds || []).map(sessionKey)),
      archived: new Set((data.global?.archivedSessionIds || []).map(sessionKey)),
    };
  } catch { return { ids: new Set(), archived: new Set() }; }
}

function lastPromptAt(sessionId) {
  try {
    const id = String(sessionId || '');
    const filename = id.startsWith('session-') ? id + '.json' : 'session-' + id + '.json';
    const data = JSON.parse(readFileSync(join(projectionPath, filename), 'utf8'));
    return Number(data.record?.rows?.sessionListMetadata?.val?.lastPromptAt) || 0;
  } catch { return 0; }
}

export function apply(ctx) {
  let child = null;
  let ready = false;
  let lastError = '';
  let totalSamples = 0;
  let nextId = 1;
  let contact = null;
  let lastActivityAt = 0;
  let wakeConfig = loadWakeConfig();
  let pendingWake = null;
  let wakeBusy = false;
  let lastWakeAt = 0;
  let lastWakeError = '';
  let wakeCount = 0;
  const events = [];
  const mounted = new Map();

  function saveConfig() {
    writeFileSync(wakeConfigPath, JSON.stringify(wakeConfig, null, 2) + '\n');
  }

  function append(type, detail = {}, at = Date.now()) {
    const item = { id: nextId++, at, type, ...detail };
    events.push(item);
    while (events.length > MAX_EVENTS || (events.length && at - events[0].at > EVENT_TTL_MS)) events.shift();
    if (child && wakeConfig.enabled && ['touch', 'digitizer_activity', 'tap', 'long_press'].includes(type)
      && at - lastWakeAt >= wakeConfig.cooldownSeconds * 1000) pendingWake = item;
    return item;
  }

  function eligibleAgents() {
    const workspace = defaultWorkspace();
    return (ctx.agents.list() || []).filter((agent) => {
      const id = agent?.session?.id || agent?.session?.sessionId;
      const key = sessionKey(id);
      return workspace.ids.has(key) && !workspace.archived.has(key)
        && typeof agent.followup === 'function';
    });
  }

  function pickWakeAgent() {
    const candidates = eligibleAgents();
    const target = sessionKey(wakeConfig.targetSessionId);
    const chosen = target
      ? candidates.find((agent) => sessionKey(agent.session?.id || agent.session?.sessionId) === target)
      : candidates.sort((a, b) =>
        lastPromptAt(b.session?.id || b.session?.sessionId) - lastPromptAt(a.session?.id || a.session?.sessionId))[0];
    return chosen && (chosen.status === undefined || chosen.status === 'idle') ? chosen : null;
  }

  async function maybeWake() {
    if (wakeBusy || !child || !ready || !wakeConfig.enabled || !pendingWake) return;
    if (Date.now() - pendingWake.at > WAKE_EVENT_TTL_MS) { pendingWake = null; return; }
    if (Date.now() - lastWakeAt < wakeConfig.cooldownSeconds * 1000) { pendingWake = null; return; }
    const agent = pickWakeAgent();
    if (!agent) { lastWakeError = 'No idle agent in the selected DSH desktop session'; return; }
    wakeBusy = true;
    const event = pendingWake;
    pendingWake = null;
    const gesture = event.type === 'digitizer_activity' ? '触控板数字化仪活动'
      : event.type === 'long_press' ? '长按'
      : event.type === 'touch' ? '触点接触' : '轻触';
    const message = {
      id: randomUUID(), role: 'user', source: { kind: 'touchpad-sense' },
      content: [{ type: 'text', text: `（本机触控板事件，不是用户输入的文字。）刚检测到一次${gesture}。请在当前会话里用一句简短、自然的话回应这个动作；不要声称自己拥有真实触觉、压力感或逐指信息。` }],
    };
    try {
      await agent.followup(message);
      lastWakeAt = Date.now();
      wakeCount++;
      lastWakeError = '';
    } catch (error) { lastWakeError = String(error?.message || error).slice(0, 300); }
    finally { wakeBusy = false; }
  }

  function finishContact(at, confirmed = true) {
    if (!contact) return;
    const durationMs = Math.max(0, at - contact.start);
    append(confirmed ? (durationMs >= 500 ? 'long_press' : 'tap') : 'contact_lost', {
      durationMs, maxContactCount: contact.maxCount,
    }, at);
    contact = null;
  }

  function onInput(sample) {
    if (sample.type === 'ready') { ready = true; return; }
    if (sample.type !== 'contact' && sample.type !== 'digitizer_activity') return;
    totalSamples++;
    const at = Number(sample.at) || Date.now();
    if (sample.type === 'digitizer_activity') {
      if (at - lastActivityAt > 300) append('digitizer_activity', {}, at);
      lastActivityAt = at;
      return;
    }
    const count = Number(sample.contactCount);
    if (!Number.isFinite(count) || count < 0 || count > 10) return;
    if (count === 0) { finishContact(at); return; }
    if (!contact) {
      contact = { start: at, last: at, maxCount: count };
      append('touch', { contactCount: count,
        ...(Number.isFinite(sample.x) && Number.isFinite(sample.y) ? { x: sample.x, y: sample.y } : {}),
      }, at);
    } else {
      contact.last = at;
      contact.maxCount = Math.max(contact.maxCount, count);
    }
  }

  function start(save = true) {
    if (child) {
      if (save) { wakeConfig.captureEnabled = true; saveConfig(); }
      return { ok: true, ...status() };
    }
    lastError = '';
    ready = false;
    if (!existsSync(collectorPath)) {
      lastError = `Collector executable missing: ${collectorPath}`;
      return { ok: false, ...status() };
    }
    child = spawn(collectorPath, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const running = child;
    const lines = createInterface({ input: running.stdout });
    lines.on('line', (line) => {
      if (child !== running) return;
      try { onInput(JSON.parse(line)); } catch { /* discard malformed collector output */ }
    });
    running.stderr.setEncoding('utf8');
    running.stderr.on('data', (message) => { lastError = String(message).trim().slice(0, 300); });
    running.on('error', (error) => { lastError = error.message; });
    running.on('exit', (code) => {
      if (child === running) child = null;
      ready = false;
      finishContact(Date.now(), false);
      if (code && !lastError) lastError = `Collector exited with code ${code}`;
    });
    if (save) { wakeConfig.captureEnabled = true; saveConfig(); }
    return { ok: true, ...status() };
  }

  function stop(save = true) {
    if (child) { child.kill(); child = null; }
    ready = false;
    contact = null;
    lastActivityAt = 0;
    pendingWake = null;
    events.length = 0;
    if (save) { wakeConfig.captureEnabled = false; saveConfig(); }
    return { ok: true, ...status() };
  }

  function status() {
    return {
      enabled: Boolean(child), requested: wakeConfig.captureEnabled, ready,
      source: `Windows Raw Input / ${deviceFilter} HID digitizer 0x0D/0x05`,
      capabilities: ['digitizer_report_activity', 'contact_count_if_exposed', 'coordinates_if_exposed'],
      unsupported: ['reliable_per_finger_tracking', 'pressure', 'programmable_haptics'],
      totalSamples, bufferedEvents: events.length, lastError,
      wake: {
        ...wakeConfig, pending: Boolean(pendingWake), lastWakeAt, wakeCount, lastWakeError,
      },
    };
  }

  function recent(limit = 20) {
    const now = Date.now();
    while (events.length && now - events[0].at > EVENT_TTL_MS) events.shift();
    return events.slice(-Math.min(50, Math.max(1, limit)));
  }

  const output = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };
  const parameters = (properties = {}) => ({ type: 'object', properties, additionalProperties: false });
  const register = (spec) => ctx.tools.register({ ...spec, output });

  register({
    name: 'touchpad_start',
    description: 'Start local touchpad sensing through the configured HID digitizer collection. Capture stays in memory and does not intercept mouse input.',
    parameters: parameters(), execute: () => start(),
  });
  register({
    name: 'touchpad_stop',
    description: 'Stop touchpad sensing immediately and clear buffered touch events.',
    parameters: parameters(), execute: () => stop(),
  });
  register({
    name: 'touchpad_status',
    description: 'Show touchpad capture state, available signals, sample count and collector errors.',
    parameters: parameters(), execute: () => status(),
  });
  register({
    name: 'touchpad_events',
    description: 'Read recent touchpad digitizer events from the past minute. Contact details appear only when the HID report exposes them. Events are local and expire automatically.',
    parameters: parameters({ limit: { type: 'number', description: 'Maximum events, from 1 to 50.' } }),
    execute: (args) => ({ ok: true, ...status(), events: recent(args?.limit) }),
  });
  register({
    name: 'touchpad_wake_config',
    description: 'Configure automatic AI replies to meaningful touchpad gestures. Capture must also be started. The target defaults to the most recently active agent in the default desktop workspace and waits briefly if it is busy.',
    parameters: parameters({
      enabled: { type: 'boolean', description: 'Enable or disable automatic wake and reply.' },
      targetSessionId: { type: 'string', description: 'Optional desktop session ID. Empty string uses the most recently active desktop session.' },
      cooldownSeconds: { type: 'number', description: 'Minimum seconds between replies, 5 to 300.' },
    }),
    execute: (args) => {
      if (typeof args?.enabled === 'boolean') wakeConfig.enabled = args.enabled;
      if (typeof args?.targetSessionId === 'string') wakeConfig.targetSessionId = args.targetSessionId.trim();
      if (Number.isFinite(args?.cooldownSeconds)) wakeConfig.cooldownSeconds = Math.max(5, Math.min(300, Math.round(args.cooldownSeconds)));
      if (!wakeConfig.enabled) pendingWake = null;
      saveConfig();
      return { ok: true, wake: status().wake };
    },
  });
  register({
    name: 'touchpad_wake_sessions',
    description: 'List active sessions in the default DSH desktop workspace that can receive touchpad wake replies.',
    parameters: parameters(),
    execute: () => ({ ok: true, sessions: eligibleAgents().map((agent) => ({
      id: agent.session?.id || agent.session?.sessionId,
      status: agent.status || 'unknown',
      lastPromptAt: lastPromptAt(agent.session?.id || agent.session?.sessionId),
    })) }),
  });

  const sendJson = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 4096) raw = raw.slice(0, 4096); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-touchpad-sense/state',
    handler: (_req, res) => sendJson(res, 200, { ok: true, ...status(), systemPointerBlocked: false }),
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/dsh-touchpad-sense/config',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' });
      const body = await readBody(req);
      try {
        if (typeof body.captureEnabled === 'boolean') {
          if (body.captureEnabled) start(); else stop();
        }
        if (typeof body.wakeEnabled === 'boolean') {
          wakeConfig.enabled = body.wakeEnabled;
          if (!wakeConfig.enabled) pendingWake = null;
          saveConfig();
        }
        return sendJson(res, 200, { ok: true, ...status(), systemPointerBlocked: false });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message || error) });
      }
    },
  }));

  function tick() {
    if (contact && Date.now() - contact.last > 750) finishContact(Date.now(), false);
    const workspace = defaultWorkspace();
    for (const agent of ctx.agents.list() || []) {
      const session = agent?.session;
      const sessionId = session?.id || session?.sessionId;
      if (!sessionId || !workspace.ids.has(sessionKey(sessionId)) || workspace.archived.has(sessionKey(sessionId)) || mounted.has(sessionId)) continue;
      try {
        const off = agent.ctx.systemPrompt.context({
          name: 'touchpad-sense', order: 950,
          text: () => {
            if (!child || !ready) return '';
            const latest = recent(3).filter((event) => Date.now() - event.at <= CONTEXT_TTL_MS);
            if (!latest.length) return '';
            return 'Recent local touchpad signals (machine observation, not emotion or user intent): '
              + latest.map((event) => `${event.type}${event.direction ? ':' + event.direction : ''}`).join(', ')
              + '. Treat these as optional context. Do not infer pressure or finger count.';
          },
        });
        mounted.set(sessionId, off);
      } catch { /* this agent has no context hook */ }
    }
    for (const [sessionId, off] of mounted) {
      if (workspace.ids.has(sessionKey(sessionId)) && !workspace.archived.has(sessionKey(sessionId))
        && (ctx.agents.list() || []).some((agent) => (agent?.session?.id || agent?.session?.sessionId) === sessionId)) continue;
      try { off?.(); } catch {}
      mounted.delete(sessionId);
    }
    void maybeWake().catch((error) => { lastWakeError = String(error?.message || error).slice(0, 300); });
  }

  if (wakeConfig.captureEnabled) start(false);
  tick();
  ctx.effect(() => ctx.interval(tick, 1000));
  ctx.effect(() => () => {
    stop(false);
    for (const off of mounted.values()) { try { off?.(); } catch {} }
    mounted.clear();
  });
}
