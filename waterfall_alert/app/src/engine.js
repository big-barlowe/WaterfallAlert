import { Graph } from './graph.js';
import { DOWN, UP, PENDING, BLOCKED, STATUS_NAMES } from './status.js';
import { log } from './config.js';
import { matchRules, SEVERITIES } from '../public/js/rules.js';
import { evaluate, inScope, probeOids } from './problems.js';

const BEAT_BUFFER = 60;
// When a child fails we re-probe its parents, unless they were checked
// very recently (keeps a burst of child failures from hammering the parent).
const PROBE_FRESHNESS_MS = 5000;
const UPTIME_CACHE_MS = 30000;
const UNREACHABLE_TYPES = new Set(['ping', 'tcp', 'dns']);

export function describeTarget(m) {
  const c = m.config || {};
  switch (m.type) {
    case 'http': return c.url || '';
    case 'tcp': return c.host ? `${c.host}:${c.port}` : '';
    case 'ping': return c.host || '';
    case 'dns': return c.hostname ? `${c.hostname} (${c.recordType || 'A'})` : '';
    case 'ha_entity': return c.entityId || '';
    case 'minecraft': return c.host ? `${c.host}${c.port ? `:${c.port}` : ''}` : '';
    case 'snmp': return c.host ? `${c.host}${c.port && Number(c.port) !== 161 ? `:${c.port}` : ''}` : '';
    case 'push': return 'push';
    default: return '';
  }
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Scheduling and hierarchy logic.
 *
 * Every monitor runs on its own interval, but a check only touches the
 * network when the monitor's parents are up ("the gate is open"). When a
 * monitor fails we first re-check its parents, so the alert is always raised
 * on the highest failing monitor, and everything beneath it is marked
 * BLOCKED and listed in that single alert instead of alerting separately.
 */
export class Engine {
  constructor({ store, checkers, notify, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    this.store = store;
    this.checkers = checkers;
    this.notify = notify;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.monitors = new Map();
    this.runtime = new Map();
    this.graph = new Graph([], []);
    this.version = 1;
    this.pending = new Set();
    this.uptimeCache = null;
    this.pruneTimer = null;
    // Value problems: `${problemId}:${monitorId}` -> { problemId, monitorId,
    // state: 'open' | 'ok' | 'unknown', since, value, hits }. Loaded once.
    this.pstate = null;
  }

  // ---- lifecycle ----------------------------------------------------------

  async start() {
    this.reload();
    // Initial sweep, top of the hierarchy first, one level at a time.
    const levels = this.graph.levels();
    const byLevel = [];
    for (const [id, l] of levels) (byLevel[l] ||= []).push(id);
    for (const ids of byLevel) {
      if (ids) await Promise.all(ids.map((id) => this.check(id)));
    }
    this.#prune();
  }

  stop() {
    for (const rt of this.runtime.values()) this.cancel(rt.timer);
    this.cancel(this.pruneTimer);
  }

  // Wait for fire-and-forget work (cascades, notifications). Used by tests.
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  #track(promise) {
    const p = Promise.resolve(promise).catch((err) => log.error('Background task failed:', err));
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
    return p;
  }

  // Re-read monitors and edges after any configuration change. `changed`
  // monitors are re-evaluated straight away (their gate may have moved).
  reload(changed = []) {
    const list = this.store.listMonitors();
    const fresh = new Map(list.map((m) => [m.id, m]));
    for (const [id, rt] of this.runtime) {
      if (!fresh.has(id)) {
        this.cancel(rt.timer);
        this.runtime.delete(id);
      }
    }
    for (const m of list) {
      if (this.runtime.has(m.id)) continue;
      const beats = this.store.recentHeartbeats(m.id, BEAT_BUFFER);
      const last = beats[beats.length - 1];
      this.runtime.set(m.id, {
        status: last ? last.status : null,
        msg: last?.msg ?? '',
        ping: last?.ping ?? null,
        lastCheck: last?.time ?? 0,
        lastProbe: 0,
        retries: 0,
        downSince: last?.status === DOWN ? last.time : null,
        downBeats: 0,
        timer: null,
        inflight: null,
        push: null,
        beats: beats.map((b) => [b.time, b.status, b.ping]),
      });
    }
    this.monitors = fresh;
    if (!this.pstate) this.pstate = new Map(this.store.listProblemState().map((x) => [`${x.problemId}:${x.monitorId}`, { ...x, hits: 0 }]));
    for (const [key, x] of this.pstate) if (!fresh.has(x.monitorId)) this.pstate.delete(key);
    this.graph = new Graph(list.map((m) => m.id), this.store.listEdges());
    for (const m of list) if (!m.active || m.type === 'group') this.cancel(this.runtime.get(m.id).timer);
    this.version++;
    for (const id of changed) this.#track(this.refresh(id));
  }

  // Mark UI-visible state as changed without touching any monitor (e.g. an
  // icon finished downloading).
  touch() {
    this.version++;
  }

  // Re-evaluate a monitor now. Groups and paused monitors have no check of
  // their own, so refresh whatever sits underneath them instead.
  async refresh(id, seen = new Set()) {
    if (seen.has(id)) return;
    seen.add(id);
    const m = this.monitors.get(id);
    if (!m) return;
    if (this.#isPassThrough(m)) {
      await Promise.all(this.graph.childrenOf(id).map((c) => this.refresh(c, seen)));
    } else {
      await this.check(id);
    }
  }

  // ---- gating -------------------------------------------------------------

  #isPassThrough(m) {
    return m.type === 'group' || !m.active;
  }

  // How a parent looks to its children: 'up' | 'pending' | 'down'.
  // Groups and paused monitors are transparent and inherit their own gate.
  parentState(id) {
    const m = this.monitors.get(id);
    if (!m) return 'up';
    if (this.#isPassThrough(m)) return this.gateState(id);
    const s = this.runtime.get(id).status;
    if (s === DOWN || s === BLOCKED) return 'down';
    if (s === PENDING) return 'pending';
    return 'up';
  }

  // Whether a monitor's parents allow it to be checked. parentMode 'all'
  // (default) needs every parent up; 'any' needs at least one (redundant
  // paths, e.g. two WAN links).
  gateState(id) {
    const parents = this.graph.parentsOf(id);
    if (!parents.length) return 'up';
    const states = parents.map((p) => this.parentState(p));
    const m = this.monitors.get(id);
    if (m?.parentMode === 'any') {
      if (states.includes('up')) return 'up';
      if (states.includes('pending')) return 'pending';
      return 'down';
    }
    if (states.includes('down')) return 'down';
    if (states.includes('pending')) return 'pending';
    return 'up';
  }

  gateOpen(id) {
    return this.gateState(id) !== 'down';
  }

  // The highest DOWN monitors upstream of `id` – the real reason it's blocked.
  rootCauses(id) {
    return this.graph.ancestors(id).filter((a) => {
      const m = this.monitors.get(a);
      return m && !this.#isPassThrough(m) && this.runtime.get(a).status === DOWN && this.gateOpen(a);
    });
  }

  // Real (checkable) parents to re-probe, looking through groups/paused.
  #probeTargets(id, out = new Set()) {
    for (const p of this.graph.parentsOf(id)) {
      const m = this.monitors.get(p);
      if (!m) continue;
      if (this.#isPassThrough(m)) {
        this.#probeTargets(p, out);
        continue;
      }
      const rt = this.runtime.get(p);
      if (rt.status === DOWN || rt.status === BLOCKED) continue;
      if (this.now() - Math.max(rt.lastCheck, rt.lastProbe) < PROBE_FRESHNESS_MS) continue;
      out.add(p);
    }
    return out;
  }

  // Before declaring `id` down, re-check its parents. Returns the resulting
  // gate state: 'down' means something upstream is the real problem.
  async #verifyUpstream(id) {
    const targets = [...this.#probeTargets(id)];
    for (const p of targets) this.runtime.get(p).lastProbe = this.now();
    await Promise.all(targets.map((p) => this.check(p)));
    return this.gateState(id);
  }

  // ---- checking -----------------------------------------------------------

  check(id) {
    const rt = this.runtime.get(id);
    if (!rt) return Promise.resolve();
    if (!rt.inflight) {
      rt.inflight = this.#doCheck(id).finally(() => {
        rt.inflight = null;
      });
    }
    return rt.inflight;
  }

  async #doCheck(id) {
    const m = this.monitors.get(id);
    if (!m || this.#isPassThrough(m)) return;
    const rt = this.runtime.get(id);
    this.cancel(rt.timer);
    try {
      if (!this.gateOpen(id)) {
        this.#setBlocked(id);
        return;
      }
      const watching = this.#watching(m);
      const result = await this.#runChecker(m, probeOids(watching));
      if (!this.monitors.has(id) || !this.monitors.get(id).active) return;
      // What the check collected (SNMP), kept as the monitor's latest snapshot;
      // a failed check leaves the last one in place.
      if (result.data) this.store.setMonitorData(id, result.data, this.now());
      // A parent may have gone down while we were waiting on the network.
      if (!this.gateOpen(id)) {
        this.#setBlocked(id);
        return;
      }
      if (result.ok) {
        this.#onUp(m, result);
        this.#evaluateProblems(m, result, watching);
      } else await this.#onFailure(m, result);
    } catch (err) {
      log.error(`Check of "${m.name}" crashed:`, err);
    } finally {
      this.#scheduleNext(id);
    }
  }

  async #runChecker(m, probe = []) {
    if (m.type === 'push') {
      const push = this.runtime.get(m.id).push;
      if (push && this.now() - push.time <= m.interval * 1000) return push.result;
      return { ok: false, msg: `No push received in the last ${m.interval}s` };
    }
    const fn = this.checkers[m.type];
    if (!fn) return { ok: false, msg: `Unknown monitor type "${m.type}"` };
    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, msg: `Timed out after ${m.timeout}s` }), (m.timeout + 5) * 1000);
    });
    try {
      const previous = this.store.getMonitorData?.(m.id)?.data ?? null;
      return await Promise.race([Promise.resolve().then(() => fn(m, { previous, probe })), guard]);
    } catch (err) {
      return { ok: false, msg: err.message || String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  #scheduleNext(id) {
    const m = this.monitors.get(id);
    const rt = this.runtime.get(id);
    if (!m || !rt || this.#isPassThrough(m)) return;
    this.cancel(rt.timer);
    const delay = rt.status === PENDING ? m.retryInterval : m.interval;
    rt.timer = this.schedule(() => this.check(id), delay * 1000);
  }

  #record(m, status, result, important) {
    const rt = this.runtime.get(m.id);
    const time = this.now();
    const ping = status === UP ? result.ping ?? null : null;
    this.store.addHeartbeat({ monitorId: m.id, status, time, ping, msg: result.msg ?? '', important });
    rt.status = status;
    rt.msg = result.msg ?? '';
    rt.ping = ping;
    rt.lastCheck = time;
    rt.beats.push([time, status, ping]);
    if (rt.beats.length > BEAT_BUFFER) rt.beats.splice(0, rt.beats.length - BEAT_BUFFER);
    this.version++;
  }

  #onUp(m, result) {
    const rt = this.runtime.get(m.id);
    const prev = rt.status;
    rt.retries = 0;
    rt.downBeats = 0;
    this.#record(m, UP, result, prev !== UP);
    if (prev === DOWN) {
      const downFor = rt.downSince ? this.now() - rt.downSince : 0;
      rt.downSince = null;
      this.#track(this.#sendRecovery(m, downFor));
    }
    if (prev === DOWN || prev === BLOCKED || prev === null) this.#cascade(m.id);
  }

  // A monitor just came back: check the next level down now rather than
  // waiting for their intervals. Each of those cascades further when it
  // comes up, so recovery flows down the hierarchy one level at a time.
  #cascade(id) {
    for (const c of this.graph.childrenOf(id)) {
      const m = this.monitors.get(c);
      if (!m) continue;
      if (this.#isPassThrough(m)) {
        this.#cascade(c);
        continue;
      }
      const s = this.runtime.get(c).status;
      if (s === BLOCKED || s === null) this.#track(this.check(c));
    }
  }

  async #onFailure(m, result) {
    const rt = this.runtime.get(m.id);
    if (rt.status !== DOWN && rt.retries < m.retries) {
      rt.retries++;
      this.#record(m, PENDING, { msg: `${result.msg} (retry ${rt.retries}/${m.retries})` }, false);
      return;
    }

    if (rt.status !== DOWN) {
      const upstream = await this.#verifyUpstream(m.id);
      if (upstream === 'down') {
        this.#setBlocked(m.id);
        return;
      }
      if (upstream === 'pending') {
        // A parent is failing but not confirmed yet; hold off so we alert
        // on the parent rather than this monitor.
        this.#record(m, PENDING, { msg: `${result.msg} (waiting on upstream)` }, false);
        return;
      }
    }

    if (rt.status === DOWN) {
      this.#record(m, DOWN, result, false);
      rt.downBeats++;
      if (m.resendInterval > 0 && rt.downBeats % m.resendInterval === 0) {
        this.#track(this.#sendDown(m, result, this.#affectedBy(m.id), true));
      }
      return;
    }

    rt.retries = 0;
    rt.downBeats = 0;
    rt.downSince = this.now();
    this.#record(m, DOWN, result, true);
    this.#blockDescendants(m.id);
    this.#track(this.#sendDown(m, result, this.#affectedBy(m.id), false));
  }

  #setBlocked(id) {
    const m = this.monitors.get(id);
    const rt = this.runtime.get(id);
    if (!m || !rt) return;
    const wasBlocked = rt.status === BLOCKED;
    const causes = this.rootCauses(id).map((c) => this.monitors.get(c).name);
    rt.retries = 0;
    rt.downSince = null;
    this.#record(m, BLOCKED, { msg: causes.length ? `Upstream down: ${causes.join(', ')}` : 'Upstream down' }, !wasBlocked);
    if (!wasBlocked) this.#blockDescendants(id);
  }

  // Mark everything downstream whose gate is now closed as BLOCKED, without
  // checking it. Ordered by level so each node sees its parents' new state.
  #blockDescendants(id) {
    const levels = this.graph.levels();
    const desc = this.graph.descendants(id).sort((a, b) => levels.get(a) - levels.get(b));
    for (const d of desc) {
      const m = this.monitors.get(d);
      if (!m || this.#isPassThrough(m)) continue;
      const rt = this.runtime.get(d);
      if (rt.status === BLOCKED || this.gateOpen(d)) continue;
      const causes = this.rootCauses(d).map((c) => this.monitors.get(c).name);
      rt.retries = 0;
      rt.downSince = null;
      this.#record(m, BLOCKED, { msg: `Upstream down: ${causes.join(', ') || 'unknown'}` }, true);
    }
  }

  // Downstream monitors that are cut off by `id` being down.
  #affectedBy(id) {
    return this.graph
      .subtree(id, (d) => {
        const m = this.monitors.get(d);
        return m && m.active && !this.gateOpen(d);
      }, (d) => this.monitors.get(d)?.name ?? '')
      .map(({ id: d, depth }) => ({ id: d, name: this.monitors.get(d).name, depth }));
  }

  // ---- value problems -----------------------------------------------------

  // The value problems that watch `m`: by its tags, and only SNMP monitors
  // can be read.
  #watching(m) {
    if (m.type !== 'snmp') return [];
    const problems = this.store.listProblems().filter((p) => p.kind === 'value');
    if (!problems.length) return [];
    const tags = this.store.listTags();
    const mine = this.store.monitorTagMap().get(m.id) ?? [];
    return problems.filter((p) => inScope(p, mine, tags));
  }

  #saveState(x) {
    this.store.setProblemState(x);
    this.version++;
  }

  // After a successful check: open, update or clear each problem watching `m`.
  // A problem opens after `checks` hits in a row; a value the device stops
  // answering leaves an open problem open (we can't tell it cleared).
  #evaluateProblems(m, result, watching) {
    const now = this.now();
    const ids = new Set(watching.map((p) => p.id));
    for (const [key, x] of this.pstate) {
      if (x.monitorId !== m.id || ids.has(x.problemId)) continue;
      this.pstate.delete(key); // not watched any more: forget it quietly
      this.store.deleteProblemState(x.problemId, m.id);
      this.version++;
    }
    for (const p of watching) {
      // the probe itself failed: no news either way
      if (!result.probe && p.config.readings.some((r) => r.source === 'oid')) continue;
      const r = evaluate(p, result);
      const key = `${p.id}:${m.id}`;
      let x = this.pstate.get(key);
      if (!x) {
        x = { problemId: p.id, monitorId: m.id, state: null, since: now, value: '', hits: 0 };
        this.pstate.set(key, x);
      }
      x.reading = r.reading ?? null; // which reading answered (memory only)
      const was = x.state;
      if (r.state === 'open') {
        x.hits++;
        if (was === 'open') {
          if (x.value !== r.value) this.#saveState(Object.assign(x, { value: r.value }));
        } else if (x.hits >= (p.config.checks ?? 1)) {
          this.#saveState(Object.assign(x, { state: 'open', since: now, value: r.value }));
          this.#track(this.#sendProblem(m, p, x, true));
        } else if (was !== 'ok' || x.value !== r.value) {
          // not yet: still ok as far as anyone is told
          this.#saveState(Object.assign(x, { state: 'ok', since: was === 'ok' ? x.since : now, value: r.value }));
        }
        continue;
      }
      x.hits = 0;
      if (was === 'open' && r.state === 'unknown') continue;
      if (was === 'open') {
        const openFor = now - x.since;
        this.#saveState(Object.assign(x, { state: 'ok', since: now, value: r.value }));
        this.#track(this.#sendProblem(m, p, x, false, openFor));
      } else if (was !== r.state || x.value !== r.value) {
        this.#saveState(Object.assign(x, { state: r.state, since: was === r.state ? x.since : now, value: r.value }));
      }
    }
  }

  // Forget a deleted problem's state (the store cascades on its own).
  forgetProblem(problemId) {
    for (const [key, x] of this.pstate ?? []) if (x.problemId === problemId) this.pstate.delete(key);
    this.version++;
  }

  // State per watched monitor, for the Problems page: [{ problemId, monitorId, state, since, value }].
  problemState() {
    return [...(this.pstate?.values() ?? [])].map(({ hits, ...x }) => x);
  }

  // Everything unresolved: monitors that are down (the root causes; blocked
  // ones are listed in those alerts) and open value problems. `stale` means
  // the monitor isn't up, so the value is the last one read.
  openProblems() {
    const problems = this.store.listProblems();
    const byId = new Map(problems.map((p) => [p.id, p]));
    const down = problems.find((p) => p.kind === 'down');
    const tags = this.store.listTags();
    const tagMap = this.store.monitorTagMap();
    const out = [];
    for (const m of this.monitors.values()) {
      const rt = this.runtime.get(m.id);
      if (!m.active || m.type === 'group' || rt.status !== DOWN || !down) continue;
      out.push({ problemId: down.id, monitorId: m.id, severity: 'severe', since: rt.downSince ?? rt.lastCheck, value: rt.msg });
    }
    for (const x of this.pstate?.values() ?? []) {
      const p = byId.get(x.problemId);
      const m = this.monitors.get(x.monitorId);
      if (x.state !== 'open' || !p || !m?.active || !inScope(p, tagMap.get(m.id) ?? [], tags)) continue;
      out.push({ problemId: p.id, monitorId: m.id, severity: p.severity, since: x.since, value: x.value, stale: this.runtime.get(m.id).status !== UP });
    }
    return out;
  }

  // Everything below `id` (active), for a problem that lists its downstream.
  #downstreamOf(id) {
    return this.graph
      .subtree(id, (d) => this.monitors.get(d)?.active, (d) => this.monitors.get(d)?.name ?? '')
      .map(({ id: d, depth }) => ({ id: d, name: this.monitors.get(d).name, depth }));
  }

  composeProblem(m, p, x, opened, openFor = 0, affected = []) {
    const title = opened ? `${SEVERITIES[p.severity].label}: ${m.name} – ${p.name}` : `Resolved: ${m.name} – ${p.name}`;
    const lines = opened
      ? [`${p.name} on ${m.name}.`, '', `Value: ${x.value || 'unknown'}`]
      : [`${p.name} cleared on ${m.name} after ${formatDuration(openFor)}.`, '', `Value: ${x.value || 'unknown'}`];
    const target = describeTarget(m);
    if (target) lines.push(`Target: ${target}`);
    lines.push(`Time: ${this.#formatTime(this.now())}`);
    if (affected.length) {
      lines.push('', `${opened ? 'Downstream monitors' : 'Downstream monitors it covered'} (${affected.length}):`);
      for (const a of affected) lines.push(`${'-'.repeat(a.depth)} ${a.name}`);
    }
    return { title, message: lines.join('\n') };
  }

  async #sendProblem(m, p, x, opened, openFor) {
    const affected = p.config.downstream ? this.#downstreamOf(m.id) : [];
    const { title, message } = this.composeProblem(m, p, x, opened, openFor, affected);
    (opened && p.severity !== 'info' ? log.warn : log.info)(title);
    await this.#dispatch(m, opened ? 'problem' : 'resolved', title, message, affected, p);
  }

  // ---- push monitors ------------------------------------------------------

  async receivePush(token, { status, msg, ping } = {}) {
    const stored = this.store.getMonitorByPushToken(token);
    const m = stored && this.monitors.get(stored.id);
    if (!m || m.type !== 'push') return { found: false };
    if (!m.active) return { found: true, ok: false, msg: 'Monitor is paused' };
    const ok = status !== 'down';
    this.runtime.get(m.id).push = {
      time: this.now(),
      result: { ok, msg: msg || (ok ? 'Push received' : 'Push reported down'), ping: ping != null ? Number(ping) : null },
    };
    await this.check(m.id);
    return { found: true, ok: true };
  }

  // ---- alerts -------------------------------------------------------------

  // The channels the notification rules pick for this alert. Down, its
  // reminders and up belong to the built-in "down" problem; a resolved alert
  // goes out unless its problem has them off.
  #channelsFor(m, kind, affected, problem) {
    problem ??= this.store.listProblems().find((p) => p.kind === 'down');
    if (!problem || ((kind === 'up' || kind === 'resolved') && problem.config.recovery === false)) return [];
    const tagMap = this.store.monitorTagMap();
    const { channelIds } = matchRules(
      { rules: this.store.listRules(), tags: this.store.listTags(), tagsOf: (id) => tagMap.get(id) ?? [] },
      { problemId: problem.id, severity: problem.severity, monitorId: m.id, affectedIds: affected.map((a) => a.id) },
    );
    return this.store.listNotifications().filter((n) => n.active && channelIds.has(n.id));
  }

  #formatTime(t) {
    return new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' });
  }

  composeDown(m, result, affected, reminder = false) {
    const verb = UNREACHABLE_TYPES.has(m.type) ? 'is unreachable' : 'is down';
    const title = `${reminder ? 'Reminder' : 'Alert'}: ${m.name} ${verb}`;
    const lines = [`${m.name} ${verb}.`, ''];
    const target = describeTarget(m);
    if (target && target !== 'push') lines.push(`Target: ${target}`);
    lines.push(`Reason: ${result.msg || 'unknown'}`);
    lines.push(`Time: ${this.#formatTime(this.now())}`);
    if (affected.length) {
      lines.push('', `Other affected monitors (${affected.length}):`);
      for (const a of affected) lines.push(`${'-'.repeat(a.depth)} ${a.name}`);
    }
    return { title, message: lines.join('\n') };
  }

  composeUp(m, downFor, resuming) {
    const title = `Resolved: ${m.name} is back up`;
    const lines = [`${m.name} is up again after ${formatDuration(downFor)} down.`, `Time: ${this.#formatTime(this.now())}`];
    if (resuming.length) {
      lines.push('', `Re-checking downstream monitors (${resuming.length}):`);
      for (const a of resuming) lines.push(`${'-'.repeat(a.depth)} ${a.name}`);
    }
    return { title, message: lines.join('\n') };
  }

  async #sendDown(m, result, affected, reminder) {
    const { title, message } = this.composeDown(m, result, affected, reminder);
    log.warn(title, affected.length ? `(+${affected.length} downstream)` : '');
    await this.#dispatch(m, 'down', title, message, affected);
  }

  async #sendRecovery(m, downFor) {
    const resuming = this.graph
      .subtree(m.id, (d) => this.runtime.get(d)?.status === BLOCKED, (d) => this.monitors.get(d)?.name ?? '')
      .map(({ id, depth }) => ({ id, name: this.monitors.get(id).name, depth }));
    const { title, message } = this.composeUp(m, downFor, resuming);
    log.info(title);
    await this.#dispatch(m, 'up', title, message, resuming);
  }

  async #dispatch(m, kind, title, message, affected, problem = null) {
    const time = this.now();
    const channels = this.#channelsFor(m, kind, affected, problem);
    const alert = {
      kind,
      title,
      message,
      time,
      monitor: { id: m.id, name: m.name, type: m.type, target: describeTarget(m) },
      affected: affected.map(({ id, name, depth }) => ({ id, name, depth })),
    };
    if (problem) alert.problem = { id: problem.id, name: problem.name, severity: problem.severity };
    const delivered = channels.length ? await this.notify(channels, alert) : [];
    this.store.logAlert({
      time, monitorId: m.id, kind, title, message, affected: alert.affected, delivered,
      problemId: problem?.id ?? null, severity: problem?.severity ?? (kind === 'down' ? 'severe' : null),
    });
    this.version++;
  }

  // ---- state for the UI ---------------------------------------------------

  displayStatus(id, memo = new Map()) {
    if (memo.has(id)) return memo.get(id);
    const m = this.monitors.get(id);
    let s;
    if (!m.active) s = 'paused';
    else if (m.type === 'group') {
      if (!this.gateOpen(id)) s = 'blocked';
      else {
        const kids = this.graph.childrenOf(id).map((c) => this.displayStatus(c, memo));
        s = ['down', 'pending', 'up', 'blocked'].find((x) => kids.includes(x)) || (kids.length ? 'paused' : 'up');
      }
    } else {
      s = STATUS_NAMES[this.runtime.get(id).status] ?? 'pending';
    }
    memo.set(id, s);
    return s;
  }

  #uptime() {
    const now = this.now();
    if (!this.uptimeCache || now - this.uptimeCache.at > UPTIME_CACHE_MS) {
      this.uptimeCache = { at: now, day: this.store.uptimeSince(now - 86400000) };
    }
    return this.uptimeCache.day;
  }

  snapshot() {
    const memo = new Map();
    const uptime = this.#uptime();
    const monitors = [...this.monitors.values()].map((m) => {
      const rt = this.runtime.get(m.id);
      const u = uptime.get(m.id);
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        active: m.active,
        description: m.description,
        parentMode: m.parentMode,
        interval: m.interval,
        target: describeTarget(m),
        parents: this.graph.parentsOf(m.id),
        children: this.graph.childrenOf(m.id),
        status: this.displayStatus(m.id, memo),
        msg: rt.msg,
        ping: rt.ping,
        lastCheck: rt.lastCheck,
        beats: m.type === 'group' ? [] : rt.beats.slice(-40),
        uptime24: u?.uptime ?? null,
        avgPing24: u?.avgPing ?? null,
      };
    });
    return { version: this.version, monitors, open: this.openProblems() };
  }

  #prune() {
    const run = () => {
      const { retentionDays } = this.store.getSettings();
      const before = this.now() - Number(retentionDays) * 86400000;
      const n = this.store.pruneHeartbeats(before);
      this.store.pruneAlerts(before);
      if (n) log.info(`Pruned ${n} heartbeats older than ${retentionDays} days`);
      this.pruneTimer = this.schedule(run, 6 * 3600 * 1000);
    };
    run();
  }
}
