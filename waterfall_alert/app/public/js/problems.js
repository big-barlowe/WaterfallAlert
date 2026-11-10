// Problems: the Problems section of the Notifications page (the built-in
// "Monitor down" and value problems, with ready-made ones to start from),
// and the Unresolved table on the Alerts page. How a value problem is
// evaluated lives in src/problems.js.

import { api, h, fill, toast, modal, confirmDialog, fmtAgo, fmtTime, storage, store } from './util.js';
import { tagPill, matchToggle, matchIcon, tagExprEditor, TAG_MATCH } from './tags.js';
import { parseTagExpr, exprName } from './filter.js';
import { ruleTagTest, SEVERITIES } from './rules.js';

export { SEVERITIES };
const SEV_KEYS = Object.keys(SEVERITIES);

export const sevBadge = (sev) => h('span', { class: `sev-badge sev-${sev}` }, SEVERITIES[sev]?.label ?? sev);

// The highest severity among a monitor's open value problems, for the Falls
// and the list. Only while it's up: otherwise the value is stale, and its
// status already says more.
export function monitorSeverity(m, open) {
  if (m.status !== 'up') return null;
  let best = null;
  for (const x of open) {
    if (x.monitorId !== m.id) continue;
    if (!best || SEVERITIES[x.severity].rank > SEVERITIES[best].rank) best = x.severity;
  }
  return best;
}

// ---- ready-made problems ------------------------------------------------------

const OUTPUT_SOURCE = { 1: 'other', 2: 'none', 3: 'normal', 4: 'bypass', 5: 'battery', 6: 'booster', 7: 'reducer' };
const APC_OUTPUT = { 1: 'unknown', 2: 'onLine', 3: 'onBattery', 4: 'onSmartBoost', 5: 'timedSleeping', 6: 'softwareBypass', 7: 'off', 8: 'rebooting', 9: 'switchedBypass', 10: 'hardwareFailureBypass', 11: 'sleepingUntilPowerReturn', 12: 'onSmartTrim' };
const CP_OUTPUT = { 1: 'unknown', 2: 'onLine', 3: 'onBattery', 4: 'onBoost', 5: 'sleeping', 6: 'onBypass', 7: 'rebooting', 8: 'standBy', 9: 'onBuck' };
const oid = (label, o, values, names) => ({ source: 'oid', label, oid: o, op: 'in', values, names });

// Readings for the same thing on different makes: a device uses the first
// one it answers. The standard UPS-MIB (RFC 1628) covers most UPSes with a
// network card; the vendor ones catch cards that only speak their own MIB.
export const PRESETS = [
  {
    key: 'ups-battery',
    name: 'UPS on battery',
    severity: 'warning',
    tag: 'UPS',
    about: 'Mains power is out and the UPS is running on its battery.',
    config: {
      downstream: true,
      readings: [
        oid('UPS-MIB (standard)', '1.3.6.1.2.1.33.1.4.1.0', [5], OUTPUT_SOURCE),
        oid('APC', '1.3.6.1.4.1.318.1.1.1.4.1.1.0', [3], APC_OUTPUT),
        oid('Eaton', '1.3.6.1.4.1.534.1.4.5.0', [5], OUTPUT_SOURCE),
        oid('CyberPower', '1.3.6.1.4.1.3808.1.1.1.4.1.1.0', [3], CP_OUTPUT),
      ],
    },
  },
  {
    key: 'ups-low',
    name: 'UPS battery low',
    severity: 'severe',
    tag: 'UPS',
    about: 'The battery is low or depleted: what it powers is about to go down.',
    config: {
      downstream: true,
      readings: [
        oid('UPS-MIB (standard)', '1.3.6.1.2.1.33.1.2.1.0', [3, 4], { 1: 'unknown', 2: 'batteryNormal', 3: 'batteryLow', 4: 'batteryDepleted' }),
        oid('APC', '1.3.6.1.4.1.318.1.1.1.2.1.1.0', [3], { 1: 'unknown', 2: 'batteryNormal', 3: 'batteryLow', 4: 'batteryInFaultCondition' }),
        oid('CyberPower', '1.3.6.1.4.1.3808.1.1.1.2.1.1.0', [3], { 1: 'unknown', 2: 'batteryNormal', 3: 'batteryLow', 4: 'batteryNotPresent' }),
      ],
    },
  },
  {
    key: 'ups-bypass',
    name: 'UPS on bypass',
    severity: 'warning',
    tag: 'UPS',
    about: 'Power goes straight through, so the UPS would not cover an outage.',
    config: {
      readings: [
        oid('UPS-MIB (standard)', '1.3.6.1.2.1.33.1.4.1.0', [4], OUTPUT_SOURCE),
        oid('APC', '1.3.6.1.4.1.318.1.1.1.4.1.1.0', [6, 9, 10], APC_OUTPUT),
        oid('Eaton', '1.3.6.1.4.1.534.1.4.5.0', [4], OUTPUT_SOURCE),
        oid('CyberPower', '1.3.6.1.4.1.3808.1.1.1.4.1.1.0', [6], CP_OUTPUT),
      ],
    },
  },
  {
    key: 'cpu',
    name: 'CPU busy',
    severity: 'warning',
    about: 'CPU load stays at 90% or more (from what SNMP monitors already collect).',
    config: { checks: 3, readings: [{ source: 'cpu', op: '>=', value: 90 }] },
  },
  {
    key: 'disk',
    name: 'Disk almost full',
    severity: 'warning',
    about: 'The fullest disk is 90% full or more.',
    config: { readings: [{ source: 'disk', op: '>=', value: 90 }] },
  },
  {
    key: 'memory',
    name: 'Memory almost full',
    severity: 'info',
    about: 'Memory use stays at 95% or more.',
    config: { checks: 3, readings: [{ source: 'memory', op: '>=', value: 95 }] },
  },
  {
    key: 'blank',
    name: '',
    severity: 'warning',
    about: 'Any SNMP value: an OID and what it is when something is wrong.',
    config: { readings: [{ source: 'oid', oid: '', op: 'in', values: [] }] },
  },
];

const SOURCE_LABEL = { oid: 'SNMP value (OID)', cpu: 'CPU load %', memory: 'Memory use %', disk: 'Fullest disk %' };
const OP_LABEL = { in: 'is one of', 'not-in': 'is none of', '>=': 'is at least', '>': 'is above', '<=': 'is at most', '<': 'is below' };

// What the MIB library knows about an OID (name, enums), cached.
const mibInfo = new Map();
function lookupOid(o) {
  if (!mibInfo.has(o)) mibInfo.set(o, api(`mibs/object?oid=${encodeURIComponent(o)}`).catch(() => null));
  return mibInfo.get(o);
}

const valueName = (r, v) => r.names?.[v] ?? null;

// "UPS-MIB (standard): 1.3.6.1.2.1.33.1.4.1.0 is battery (5)"
function readingText(r) {
  const what = r.source === 'oid' ? r.oid : SOURCE_LABEL[r.source];
  const vals = r.op === 'in' || r.op === 'not-in'
    ? r.values.map((v) => (valueName(r, v) ? `${valueName(r, v)} (${v})` : String(v))).join(r.op === 'in' ? ' or ' : ', ')
    : String(r.value);
  return `${r.label ? `${r.label}: ` : ''}${what} ${r.op === 'in' && r.values.length === 1 ? 'is' : OP_LABEL[r.op]} ${vals}`;
}

// ---- picking monitors by tag ---------------------------------------------------

// Tag pills with any/all, or an expression (Advanced). `value` is
// { tagIds, tagMatch, tagExpr }; onChange gets a new one. `count(test)`
// describes how many monitors match.
function tagScope(box, { value, tags, onChange, count, none = 'No tags picked: every monitor.', id }) {
  const paint = (exprMode) => {
    if (exprMode) {
      const pillsText = tags().filter((t) => value.tagIds.includes(t.id)).map((t) => exprName(t.name)).join(value.tagMatch === 'all' ? ' & ' : ' | ');
      const ed = h('div', { class: 'scope-expr' });
      tagExprEditor(ed, {
        value: value.tagExpr || pillsText,
        tags,
        describe: (expr) => (expr ? count(expr.test) : none),
        applyLabel: 'Use',
        onApply: (text) => onChange(text ? { tagIds: [], tagMatch: value.tagMatch, tagExpr: text } : { tagIds: [], tagMatch: value.tagMatch, tagExpr: '' }),
        onCancel: () => (value.tagExpr ? onChange({ ...value }) : paint(false)),
        example: 'means the UPSes at either site.',
        placeholder: 'UPS & (Main | Annex)',
        id,
      });
      return fill(box, ed);
    }
    if (value.tagExpr) {
      const bad = parseTagExpr(value.tagExpr, tags())?.error;
      return fill(box, h('div', { class: 'scope-line' },
        h('code', { class: `rule-expr${bad ? ' bad' : ''}` }, value.tagExpr),
        h('button', { type: 'button', class: 'linkish', onclick: () => paint(true) }, 'Edit'),
        h('button', { type: 'button', class: 'linkish', onclick: () => onChange({ tagIds: [], tagMatch: 'any', tagExpr: '' }) }, 'Clear'),
        h('span', { class: 'muted small' }, bad ?? count(parseTagExpr(value.tagExpr, tags()).test))));
    }
    const picked = value.tagIds;
    const any = picked.length > 0;
    const test = ruleTagTest(value, tags());
    fill(box,
      tags().length
        ? h('div', { class: 'tag-filter scope-tags' },
          tags().map((t) => {
            const on = picked.includes(t.id);
            return tagPill(t, {
              cls: on ? 'on' : any ? 'off' : '',
              pressed: String(on),
              onclick: () => onChange({ ...value, tagExpr: '', tagIds: on ? picked.filter((x) => x !== t.id) : [...picked.filter((x) => tags().some((y) => y.id === x)), t.id] }),
            });
          }),
          picked.length > 1 ? matchToggle(value.tagMatch, (mode) => onChange({ ...value, tagMatch: mode })) : null)
        : h('p', { class: 'muted small' }, 'No tags yet. ', h('a', { href: '#/tags' }, 'Make some'), ' to pick monitors by tag.'),
      h('div', { class: 'scope-line' },
        h('span', { class: 'muted small' }, test.error ? test.error : any ? count(test.test) : none),
        any ? h('button', { type: 'button', class: 'linkish', onclick: () => onChange({ tagIds: [], tagMatch: 'any', tagExpr: '' }) }, 'Clear') : null,
        tags().length ? h('button', { type: 'button', class: 'linkish', title: 'Combine tags with and, or and not', onclick: () => paint(true) }, 'Advanced') : null));
  };
  paint(false);
}

// ---- the Problems section -------------------------------------------------------

export const PROBLEM_KINDS = {
  down: {
    label: 'Built in',
    text: 'A monitor fails its check (after its retries) while everything it depends on is up. One alert names it and lists every monitor cut off below it. Reminders follow if the monitor has a reminder interval.',
  },
  value: { label: 'SNMP value', text: '' },
};

// box: where the cards go; addBtn: the section's "+ Add problem" button.
// onChanged(deleted?) after a save or delete (rules may have changed).
export function renderProblemsSection(box, { state, problems, onChanged }) {
  let editing = null; // { id: problem id | 'new', draft }
  const tags = () => state.tags;
  const name = (id) => state.byId.get(id)?.name ?? `#${id}`;
  const snmpCount = (test) => {
    const list = state.monitors.filter((m) => m.type === 'snmp' && m.active && test(m.tags));
    const others = state.monitors.filter((m) => m.type !== 'snmp' && m.type !== 'group' && test(m.tags)).length;
    return `${list.length} SNMP monitor${list.length === 1 ? '' : 's'} match${others ? `, and ${others} that can't be read (not SNMP)` : ''}.`;
  };

  function scopeView(p) {
    const c = p.config;
    if (c.tagExpr) return h('code', { class: 'rule-expr' }, c.tagExpr);
    if (!c.tagIds.length) return h('span', null, 'every SNMP monitor');
    const live = tags().filter((t) => c.tagIds.includes(t.id));
    if (!live.length) return h('span', { class: 'notif-unused' }, 'deleted tags');
    return [live.length > 1 ? h('span', { class: 'filter-match', title: TAG_MATCH[c.tagMatch].title }, matchIcon(c.tagMatch)) : null, live.map((t) => tagPill(t))];
  }

  function coverageView(p) {
    const cov = p.coverage ?? { monitors: [], waiting: [], notSnmp: [] };
    const by = (s) => cov.monitors.filter((x) => x.state === s);
    const open = by('open');
    const unknown = by('unknown');
    const total = cov.monitors.length + cov.waiting.length;
    const link = (id, extra) => h('a', { href: `#/monitor/${id}`, class: 'problem-mon' }, name(id), extra ? h('span', { class: 'muted' }, ` · ${extra}`) : null);
    if (!total && !cov.notSnmp.length) return h('p', { class: 'small notif-unused' }, 'Watches no monitors yet: no SNMP monitor matches.');
    return h('div', { class: 'problem-cov' },
      h('p', { class: 'small' },
        `Watching ${total} monitor${total === 1 ? '' : 's'}: `,
        h('strong', { class: open.length ? `sev-text-${p.severity}` : '' }, `${open.length} open`),
        ` · ${by('ok').length} OK`,
        unknown.length ? [' · ', h('span', { class: 'problem-unknown' }, `${unknown.length} can't be read`)] : null,
        cov.waiting.length ? ` · ${cov.waiting.length} not checked yet` : null),
      open.length ? h('div', { class: 'problem-mons' }, open.map((x) => link(x.monitorId, x.value))) : null,
      unknown.length || cov.notSnmp.length
        ? h('details', { class: 'problem-gaps' },
          h('summary', null, `${unknown.length + cov.notSnmp.length} tagged monitor${unknown.length + cov.notSnmp.length === 1 ? '' : 's'} can't be checked`),
          unknown.length ? h('p', { class: 'small muted' }, 'These answer none of the readings. Look the value up in the device\'s All data and add it as a reading:') : null,
          unknown.length ? h('div', { class: 'problem-mons' }, unknown.map((x) => h('span', null, link(x.monitorId), ' ', h('a', { class: 'small', href: `#/monitor/${x.monitorId}/snmp` }, 'All data')))) : null,
          cov.notSnmp.length ? h('p', { class: 'small muted' }, 'Not SNMP monitors, so there is no value to read:') : null,
          cov.notSnmp.length ? h('div', { class: 'problem-mons' }, cov.notSnmp.map((id) => link(id))) : null)
        : null);
  }

  function card(p) {
    const kind = PROBLEM_KINDS[p.kind] ?? { label: p.kind, text: '' };
    const busy = Boolean(editing);
    if (p.kind === 'down') {
      return h('div', { class: 'card problem' },
        h('div', { class: 'problem-main' },
          h('h3', null, p.name, ' ', sevBadge('severe'), ' ', h('span', { class: 'problem-kind' }, kind.label)),
          h('p', { class: 'muted small' }, kind.text),
          h('p', { class: 'small' }, p.config.recovery === false ? 'No resolved alert when it comes back up.' : 'A resolved alert follows when it comes back up.')),
        h('div', { class: 'actions' }, h('button', { class: 'btn', disabled: busy, onclick: () => startEdit(p) }, 'Edit')));
    }
    const c = p.config;
    return h('div', { class: 'card problem' },
      h('div', { class: 'problem-main' },
        h('h3', null, p.name, ' ', sevBadge(p.severity), ' ', h('span', { class: 'problem-kind' }, kind.label)),
        h('div', { class: 'problem-scope small' }, h('span', { class: 'muted' }, 'For '), scopeView(p)),
        h('ul', { class: 'problem-readings' }, c.readings.map((r) => h('li', null, readingText(r)))),
        h('p', { class: 'small muted' }, [
          c.checks > 1 ? `Opens after ${c.checks} checks in a row.` : 'Opens on the first check that shows it.',
          c.downstream ? ' Its alert lists everything downstream.' : '',
          c.recovery === false ? ' No resolved alert.' : ' A resolved alert follows when it clears.',
        ].join('')),
        coverageView(p)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', disabled: busy, onclick: () => startEdit(p) }, 'Edit'),
        h('button', { class: 'btn danger ghost', disabled: busy, onclick: () => remove(p) }, 'Delete')));
  }

  function startEdit(p) {
    editing = { id: p.id, draft: structuredClone(p), kind: p.kind };
    paint();
  }

  function startNew(preset) {
    const tag = preset.tag && tags().find((t) => t.name.toLowerCase() === preset.tag.toLowerCase());
    editing = {
      id: 'new',
      kind: 'value',
      draft: {
        name: preset.name,
        severity: preset.severity,
        config: { tagIds: tag ? [tag.id] : [], tagMatch: 'any', tagExpr: '', checks: 1, recovery: true, downstream: false, ...structuredClone(preset.config) },
      },
    };
    paint();
    box.querySelector('.problem-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function chooser() {
    modalChooser((preset) => startNew(preset));
  }

  function remove(p) {
    api('rules').then((rules) => {
      const only = rules.filter((r) => r.problemIds.length === 1 && r.problemIds[0] === p.id).length;
      confirmDialog(`Delete ${p.name}?`,
        `Open ${p.name} problems are dropped without a resolved alert.${only ? ` ${only} rule${only === 1 ? '' : 's'} that only alert${only === 1 ? 's' : ''} about it ${only === 1 ? 'is' : 'are'} deleted too.` : ''}`,
        'Delete', async () => {
          await api(`problems/${p.id}`, { method: 'DELETE' });
          toast('Problem deleted', 'success');
          onChanged();
        });
    });
  }

  async function save() {
    const isNew = editing.id === 'new';
    try {
      const body = { name: editing.draft.name, severity: editing.draft.severity, config: editing.draft.config };
      await api(isNew ? 'problems' : `problems/${editing.id}`, { method: isNew ? 'POST' : 'PUT', body });
      toast(isNew ? 'Problem added' : 'Saved', 'success');
      editing = null;
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function downForm() {
    const d = editing.draft;
    return h('form', {
      class: 'card form problem-form',
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
    },
    h('h3', null, `Edit ${d.name}`),
    h('div', { class: 'field' },
      h('label', { for: 'p-name' }, 'Name'),
      h('input', { id: 'p-name', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: d.config.recovery !== false, onchange: (e) => { d.config.recovery = e.target.checked; } }),
      h('span', null, 'Send a resolved alert when the monitor comes back up')),
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: cancel }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
  }

  function cancel() {
    editing = null;
    paint();
  }

  // One way to read the value.
  function readingRow(r, i, list, repaint) {
    const set = (patch) => {
      Object.assign(r, patch);
      repaint();
    };
    const isList = r.op === 'in' || r.op === 'not-in';
    const enumsBox = h('div', { class: 'reading-values' });
    const paintValues = (enums) => {
      if (!isList) {
        return fill(enumsBox, h('input', {
          type: 'number', class: 'reading-num', value: r.value ?? '', 'aria-label': 'Value',
          oninput: (e) => { r.value = e.target.value === '' ? '' : Number(e.target.value); },
        }), r.source === 'oid' ? null : h('span', { class: 'muted small' }, '%'));
      }
      const names = { ...(enums ?? {}), ...(r.names ?? {}) };
      const all = Object.keys(names).sort((a, b) => Number(a) - Number(b));
      if (all.length) {
        // A long list shows only the picked values until asked.
        const picked = (k) => r.values.some((v) => String(v) === k);
        const keys = all.length > 8 && !enumsBox.showAll && all.some(picked) ? all.filter(picked) : all;
        const more = keys.length < all.length
          ? h('button', { type: 'button', class: 'linkish small', onclick: () => { enumsBox.showAll = true; paintValues(enums); } }, `Show all ${all.length} values`)
          : null;
        return fill(enumsBox, more ? [keys.map(chip), more] : keys.map(chip));
      }
      function chip(k) {
        const on = r.values.some((v) => String(v) === k);
        return h('button', {
          type: 'button',
          class: `rule-opt${on ? ' on' : ''}`,
          'aria-pressed': String(on),
          onclick: () => {
            r.values = on ? r.values.filter((v) => String(v) !== k) : [...r.values, Number.isNaN(Number(k)) ? k : Number(k)];
            if (!r.names?.[k] && enums?.[k]) r.names = { ...(r.names ?? {}), [k]: enums[k] };
            paintValues(enums);
          },
        }, h('span', { class: 'rule-tick', 'aria-hidden': 'true' }, on ? '✓' : ''), names[k], h('span', { class: 'muted small' }, ` ${k}`));
      }
      fill(enumsBox, h('input', {
        class: 'reading-list',
        value: r.values.join(', '),
        placeholder: 'e.g. 3, 5',
        'aria-label': 'Values, separated by commas',
        oninput: (e) => { r.values = e.target.value.split(',').map((v) => v.trim()).filter(Boolean).map((v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)); },
      }));
    };
    const mibLine = h('div', { class: 'reading-mib small muted' });
    const look = () => {
      if (r.source !== 'oid' || !/^\.?\d+(\.\d+)+$/.test(r.oid ?? '')) {
        fill(mibLine);
        return paintValues(null);
      }
      lookupOid(r.oid.replace(/^\./, '')).then((info) => {
        fill(mibLine, info ? `${info.module ? `${info.module}::` : ''}${info.name}${info.units ? ` (${info.units})` : ''}` : r.names ? '' : 'Not in the MIB library: type the values');
        paintValues(info?.enums ?? null);
      });
    };
    let timer;
    const row = h('div', { class: 'reading' },
      h('div', { class: 'reading-head' },
        h('span', { class: 'reading-n' }, i + 1),
        h('select', {
          'aria-label': 'Read',
          onchange: (e) => {
            const source = e.target.value;
            set(source === 'oid' ? { source, op: 'in', values: [], value: undefined } : { source, op: '>=', value: 90, oid: undefined, values: undefined, names: undefined });
          },
        }, Object.entries(SOURCE_LABEL).map(([k, label]) => h('option', { value: k, selected: r.source === k }, label))),
        r.source === 'oid'
          ? h('input', {
            class: 'reading-oid',
            value: r.oid ?? '',
            placeholder: '1.3.6.1.2.1.33.1.4.1.0',
            spellcheck: false,
            'aria-label': 'OID',
            oninput: (e) => {
              r.oid = e.target.value.trim();
              clearTimeout(timer);
              timer = setTimeout(look, 350);
            },
          })
          : h('span', { class: 'reading-oid muted small' }, 'from what the SNMP check collects'),
        h('input', { class: 'reading-label', value: r.label ?? '', placeholder: 'Label (e.g. APC)', 'aria-label': 'Label', oninput: (e) => { r.label = e.target.value; } }),
        h('span', { class: 'reading-tools' },
          i > 0 ? h('button', { type: 'button', class: 'icon-btn', title: 'Try this one earlier', 'aria-label': 'Move up', onclick: () => { list.splice(i - 1, 0, list.splice(i, 1)[0]); repaint(); } }, '↑') : null,
          list.length > 1 ? h('button', { type: 'button', class: 'icon-btn', title: 'Remove', 'aria-label': 'Remove reading', onclick: () => { list.splice(i, 1); repaint(); } }, '×') : null)),
      h('div', { class: 'reading-test' },
        h('span', { class: 'muted small' }, 'Problem when it'),
        h('select', {
          'aria-label': 'Test',
          onchange: (e) => {
            const op = e.target.value;
            const toList = op === 'in' || op === 'not-in';
            set(toList === isList ? { op } : toList ? { op, values: [], value: undefined } : { op, value: '', values: undefined });
          },
        }, Object.entries(OP_LABEL).map(([k, label]) => h('option', { value: k, selected: r.op === k }, label))),
        enumsBox),
      mibLine);
    look();
    return row;
  }

  function valueForm() {
    const d = editing.draft;
    const c = d.config;
    const scopeBox = h('div', { class: 'scope' });
    const readingsBox = h('div', { class: 'readings' });
    const paintScope = () => tagScope(scopeBox, {
      value: { tagIds: c.tagIds, tagMatch: c.tagMatch, tagExpr: c.tagExpr },
      tags,
      count: snmpCount,
      none: 'No tags picked: every SNMP monitor.',
      id: 'problem-expr',
      onChange: (v) => {
        Object.assign(c, v);
        paintScope();
      },
    });
    const paintReadings = () => fill(readingsBox, c.readings.map((r, i) => readingRow(r, i, c.readings, paintReadings)));
    paintScope();
    paintReadings();
    const sevPick = h('div', { class: 'sev-pick', role: 'radiogroup', 'aria-label': 'Severity' });
    const paintSev = () => fill(sevPick, SEV_KEYS.map((k) => h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(d.severity === k),
      class: `sev-opt sev-${k}${d.severity === k ? ' on' : ''}`,
      onclick: () => {
        d.severity = k;
        paintSev();
      },
    }, SEVERITIES[k].label)));
    paintSev();
    const SEV_HELP = { info: 'Listed under Unresolved; nothing changes in the Falls.', warning: 'Its monitor pulses yellow in the Falls.', severe: 'Its monitor pulses red in the Falls.' };
    return h('form', {
      class: 'card form problem-form',
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
    },
    h('h3', null, editing.id === 'new' ? 'New problem' : `Edit ${d.name}`),
    h('div', { class: 'field' },
      h('label', { for: 'p-name' }, 'Name'),
      h('input', { id: 'p-name', value: d.name, placeholder: 'UPS on battery', oninput: (e) => { d.name = e.target.value; } })),
    h('div', { class: 'field' },
      h('label', null, 'Severity'),
      sevPick,
      h('p', { class: 'muted small sev-help' }, SEV_KEYS.map((k) => h('span', null, h('strong', null, `${SEVERITIES[k].label}: `), SEV_HELP[k], ' ')))),
    h('div', { class: 'field' },
      h('label', null, 'For monitors tagged'),
      scopeBox),
    h('div', { class: 'field' },
      h('label', null, 'Readings'),
      h('p', { class: 'muted small' }, 'Different makes report the same thing in different places. Each monitor uses the first reading it answers; one that answers none shows up as "can\'t be read".'),
      readingsBox,
      h('button', { type: 'button', class: 'btn small', onclick: () => { c.readings.push({ source: 'oid', oid: '', op: 'in', values: [] }); paintReadings(); } }, '+ Add reading')),
    h('div', { class: 'field problem-opts' },
      h('label', { class: 'check' },
        h('span', null, 'Open after'),
        h('input', { type: 'number', min: 1, max: 20, value: c.checks ?? 1, class: 'reading-num', 'aria-label': 'Checks in a row', oninput: (e) => { c.checks = Number(e.target.value) || 1; } }),
        h('span', null, 'checks in a row (more rides out short blips, such as a UPS self-test)')),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: c.downstream === true, onchange: (e) => { c.downstream = e.target.checked; } }),
        h('span', null, 'Include downstream monitors in the alert', h('span', { class: 'muted small' }, ' — they keep running, but you can get ready for what\'s behind it'))),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: c.recovery !== false, onchange: (e) => { c.recovery = e.target.checked; } }),
        h('span', null, 'Send a resolved alert when it clears'))),
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: cancel }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, editing.id === 'new' ? 'Add problem' : 'Save')));
  }

  function paint() {
    fill(box,
      editing?.id === 'new' ? valueForm() : null,
      problems.map((p) => (editing?.id === p.id ? (p.kind === 'down' ? downForm() : valueForm()) : card(p))));
  }

  paint();
  return { add: chooser, busy: () => Boolean(editing) };
}

// "+ Add problem": pick a ready-made one (or start blank).
function modalChooser(onPick) {
  let close = () => {};
  const list = h('div', { class: 'preset-list' },
    h('p', { class: 'muted small' }, 'Start from one of these and change anything you like.'),
    PRESETS.map((p) => h('button', {
      type: 'button',
      class: 'preset',
      onclick: () => {
        close();
        onPick(p);
      },
    },
    h('span', { class: 'preset-name' }, p.name || 'Blank SNMP value', p.key === 'blank' ? null : sevBadge(p.severity)),
    h('span', { class: 'muted small' }, p.about),
    p.key !== 'blank' && p.config.readings[0].source === 'oid'
      ? h('span', { class: 'preset-reads small' }, `Reads ${p.config.readings.map((r) => r.label).join(', ')}`)
      : null)));
  close = modal('Add a problem', list, []);
  list.querySelector('.preset')?.focus();
}

// ---- unresolved problems (Alerts page) -------------------------------------------

const filterState = () => {
  const f = storage('openFilter', null) ?? {};
  return {
    sev: Array.isArray(f.sev) ? f.sev.filter((s) => SEVERITIES[s]) : [],
    tagIds: Array.isArray(f.tagIds) ? f.tagIds : [],
    tagMatch: f.tagMatch === 'all' ? 'all' : 'any',
    tagExpr: typeof f.tagExpr === 'string' ? f.tagExpr : '',
  };
};

// The Unresolved table. Call the returned paint() again with fresh state.
export function unresolvedTable(box) {
  let f = filterState();
  let showTags = false;
  const save = () => store('openFilter', f);
  let last = null;

  function paint(state) {
    last = state;
    const problems = new Map((state.problems ?? []).map((p) => [p.id, p]));
    const all = (state.open ?? []).map((x) => ({ ...x, problem: problems.get(x.problemId), monitor: state.byId.get(x.monitorId) })).filter((x) => x.monitor);
    const tagTest = ruleTagTest(f, state.tags);
    const tagged = (x) => !tagTest.error && tagTest.test(x.monitor.tags);
    const sevOk = (x) => !f.sev.length || f.sev.includes(x.severity);
    const rows = all.filter((x) => sevOk(x) && tagged(x))
      .sort((a, b) => SEVERITIES[b.severity].rank - SEVERITIES[a.severity].rank || b.since - a.since);
    const counts = Object.fromEntries(SEV_KEYS.map((k) => [k, all.filter((x) => x.severity === k && tagged(x)).length]));
    const tagOn = f.tagExpr || f.tagIds.length;
    const scopeBox = h('div', { class: 'open-scope' });
    if (showTags) {
      tagScope(scopeBox, {
        value: f,
        tags: () => state.tags,
        count: (test) => {
          const n = all.filter((x) => test(x.monitor.tags)).length;
          return `${n} of ${all.length} unresolved.`;
        },
        none: 'No tags picked: every monitor.',
        id: 'open-expr',
        onChange: (v) => {
          f = { ...f, ...v };
          save();
          paint(last);
        },
      });
    }
    fill(box,
      h('div', { class: 'open-filters' },
        h('span', { class: 'tag-filter-label' }, 'Severity'),
        SEV_KEYS.slice().reverse().map((k) => {
          const on = f.sev.includes(k);
          return h('button', {
            type: 'button',
            class: `sev-opt sev-${k}${on ? ' on' : ''}`,
            'aria-pressed': String(on),
            onclick: () => {
              f.sev = on ? f.sev.filter((s) => s !== k) : [...f.sev, k];
              save();
              paint(last);
            },
          }, SEVERITIES[k].label, h('span', { class: 'sev-count' }, counts[k]));
        }),
        h('span', { class: 'open-sep' }),
        h('button', {
          type: 'button',
          class: `btn small${tagOn ? ' on' : ''}`,
          'aria-expanded': String(showTags),
          onclick: () => {
            showTags = !showTags;
            paint(last);
          },
        }, tagOn ? 'Tags: filtered' : 'Filter by tag', ' ▾'),
        f.sev.length || tagOn
          ? h('button', { type: 'button', class: 'linkish', onclick: () => { f = { sev: [], tagIds: [], tagMatch: 'any', tagExpr: '' }; save(); paint(last); } }, 'Show all')
          : null),
      showTags ? scopeBox : null,
      rows.length
        ? h('div', { class: 'open-wrap' }, h('table', { class: 'open-table' },
          h('thead', null, h('tr', null, ['Severity', 'Problem', 'Monitor', 'Value', 'Since'].map((t) => h('th', null, t)))),
          h('tbody', null, rows.map((x) => h('tr', { class: `sev-row sev-${x.severity}${x.stale ? ' stale' : ''}` },
            h('td', null, sevBadge(x.severity)),
            h('td', null, x.problem?.name ?? 'Problem'),
            h('td', null,
              h('a', { href: `#/monitor/${x.monitorId}` }, x.monitor.name),
              h('span', { class: 'open-tags' }, x.monitor.tags.map((id) => state.tagById.get(id)).filter(Boolean).map((t) => tagPill(t)))),
            h('td', { class: 'open-value' }, x.value || '—', x.stale ? h('span', { class: 'muted small', title: 'The monitor is not up, so this is the last value read' }, ' (last known)') : null),
            h('td', { class: 'nowrap', title: fmtTime(x.since) }, fmtAgo(x.since).replace(' ago', '')))))))
        : h('p', { class: 'muted open-empty' }, all.length ? 'Nothing unresolved matches the filter.' : 'Nothing unresolved. Calm waters.'));
  }
  return paint;
}
