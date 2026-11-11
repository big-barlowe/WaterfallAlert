// The Notifications page: rules ("Alert <channels> when <problems> for
// <tags>"), then the channels, then the problems. A rule is edited as a
// draft and saved with its Save button. Matching itself is in rules.js,
// shared with the server.

import { api, h, svg, fill, toast, confirmDialog } from './util.js';
import { tagPill, matchToggle, matchIcon, tagExprEditor, TAG_MATCH } from './tags.js';
import { parseTagExpr, exprName } from './filter.js';
import { ruleTagTest, ruleProblem, SEVERITIES } from './rules.js';
import { renderNotificationForm } from './forms.js';
import { renderProblemsSection, sevBadge, PROBLEM_KINDS, takeDraftDefinition } from './problems.js';

export { PROBLEM_KINDS };

// Row action icons (24x24, stroked). Not in icons.js's GLYPHS, which are
// monitor icons.
const ACTION_ICONS = {
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13', 'M10 11v5.5M14 11v5.5'],
  close: ['M6 6l12 12M18 6L6 18'],
};
const actionIcon = (name) => svg('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true' },
  ACTION_ICONS[name].map((d) => svg('path', { d })));

// `state` is app.js's polled state (tags, monitors with their tag ids).
export async function renderNotifications(main, { state, editing: addingChannel = false }) {
  const [rules, problems, channels, catalog] = await Promise.all([api('rules'), api('problems'), api('notifications'), api('notification-types')]);
  // The rule being edited (one at a time): { id: a rule id or 'new', draft }.
  // Nothing is saved until Save; `open` is its picker.
  let editing = null;
  let open = null; // { slot: 'channels' | 'problems' | 'tags', expr? }
  const rulesBox = h('div', { class: 'card rule-table', role: 'table', 'aria-label': 'Notification rules' });
  const addRuleBtn = h('button', { class: 'btn primary', onclick: () => addRule() }, '+ Add rule');
  const formBox = h('div');
  const problemsBox = h('div', { class: 'problem-list' });
  const tags = () => state.tags;

  // Close the open picker on a click outside the rules, or on Escape. (Not
  // inside them: repainting under the pointer would swallow the click.)
  const outside = new AbortController();
  const closeOnOutside = (e) => {
    if (!rulesBox.isConnected) return outside.abort();
    if (open && !rulesBox.contains(e.target) && !e.target.closest?.('.modal-back')) setOpen(null);
  };
  document.addEventListener('pointerdown', closeOnOutside, { signal: outside.signal });
  document.addEventListener('keydown', (e) => {
    if (!rulesBox.isConnected) return outside.abort();
    if (e.key === 'Escape' && open) setOpen(null);
  }, { signal: outside.signal });

  function setOpen(next) {
    open = next;
    paintRules();
    if (open?.expr) document.getElementById('rule-expr-input')?.focus();
  }

  const RULE_KEYS = ['channelIds', 'problemIds', 'minSeverity', 'tagIds', 'tagMatch', 'tagExpr', 'downstream'];
  const ruleBody = (r) => Object.fromEntries(RULE_KEYS.map((k) => [k, r[k]]));
  const changed = () => editing.id === 'new'
    || JSON.stringify(ruleBody(editing.draft)) !== JSON.stringify(ruleBody(rules.find((r) => r.id === editing.id)));

  // Changes go into the draft only.
  function change(patch) {
    Object.assign(editing.draft, patch);
    paintRules();
  }

  function startEdit(rule) {
    editing = { id: rule.id, draft: structuredClone(rule) };
    open = null;
    paintRules();
  }

  function addRule() {
    editing = {
      id: 'new',
      draft: { channelIds: channels.length === 1 ? [channels[0].id] : [], problemIds: [], minSeverity: '', tagIds: [], tagMatch: 'any', tagExpr: '', downstream: true },
    };
    open = { slot: channels.length === 1 ? 'tags' : 'channels' };
    paintRules();
    rulesBox.querySelector('.rule-row.editing')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function cancelEdit() {
    editing = null;
    open = null;
    paintRules();
  }

  async function saveEdit() {
    const isNew = editing.id === 'new';
    try {
      const saved = await api(isNew ? 'rules' : `rules/${editing.id}`, { method: isNew ? 'POST' : 'PUT', body: ruleBody(editing.draft) });
      if (isNew) rules.push(saved);
      else Object.assign(rules.find((r) => r.id === saved.id), saved);
      editing = null;
      open = null;
      toast(isNew ? 'Rule added' : 'Rule saved', 'success');
      paintRules();
      paintChannels();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function removeRule(rule) {
    confirmDialog('Delete this rule?', `Its channels stop getting these alerts${rules.length === 1 ? ', and with no rules left nothing is sent' : ''}.`, 'Delete', async () => {
      await api(`rules/${rule.id}`, { method: 'DELETE' });
      rules.splice(rules.indexOf(rule), 1);
      paintRules();
      paintChannels();
    });
  }

  // ---- one rule ---------------------------------------------------------------

  // The three parts of the sentence: what they show, a tooltip with all of it
  // (cells are one line and clip), and whether there's something there yet.
  const channelPart = (rule) => {
    const picked = channels.filter((c) => rule.channelIds.includes(c.id));
    return {
      empty: !picked.length,
      title: picked.map((c) => c.name + (c.active ? '' : ' (inactive)')).join(', '),
      content: picked.length
        ? picked.map((c) => h('span', { class: `rule-chip${c.active ? '' : ' inactive'}` }, c.name))
        : 'choose channels',
    };
  };

  const SEV_ANY = { warning: 'warning or worse', severe: 'any severe problem', info: 'any problem' };
  const problemPart = (rule) => {
    const picked = problems.filter((p) => rule.problemIds.includes(p.id));
    if (picked.length) return { title: picked.map((p) => p.name).join(', '), content: picked.map((p) => h('span', { class: `rule-chip sev-chip sev-${p.severity}` }, p.name)) };
    const any = SEV_ANY[rule.minSeverity] ?? 'any problem';
    return { title: any[0].toUpperCase() + any.slice(1), content: rule.minSeverity && rule.minSeverity !== 'info' ? h('span', { class: `rule-chip sev-chip sev-${rule.minSeverity}` }, any) : any };
  };

  const tagPart = (rule) => {
    if (rule.tagExpr) {
      const bad = parseTagExpr(rule.tagExpr, tags())?.error;
      return { title: bad ?? rule.tagExpr, content: h('code', { class: `rule-expr${bad ? ' bad' : ''}` }, rule.tagExpr) };
    }
    const live = tags().filter((t) => rule.tagIds.includes(t.id));
    if (!rule.tagIds.length) return { title: 'Every monitor', content: 'all monitors' };
    if (!live.length) return { empty: true, title: ruleTagTest(rule, tags()).error, content: 'deleted tags' };
    return {
      title: live.map((t) => t.name).join(rule.tagMatch === 'all' ? ' and ' : ' or '),
      content: [
        live.length > 1 ? h('span', { class: 'filter-match', title: TAG_MATCH[rule.tagMatch].title }, matchIcon(rule.tagMatch)) : null,
        live.map((t) => tagPill(t)),
      ],
    };
  };

  // A table cell: read-only, or a button that opens its picker while editing.
  const part = (name, { content, title, empty = false }, edit, label) => {
    const clip = h('span', { class: 'rule-clip' }, content);
    if (!edit) return h('div', { class: `rule-cell rule-c-${name}${empty ? ' empty' : ''}`, 'data-label': label, title }, clip);
    const isOpen = open?.slot === name;
    return h('div', { class: `rule-cell rule-c-${name}`, 'data-label': label },
      h('button', {
        type: 'button',
        class: `rule-slot${empty ? ' empty' : ''}${isOpen ? ' open' : ''}`,
        'aria-expanded': String(isOpen),
        'aria-label': label,
        title,
        onclick: () => setOpen(isOpen ? null : { slot: name, expr: name === 'tags' && Boolean(editing.draft.tagExpr) }),
      }, clip, h('span', { class: 'rule-caret', 'aria-hidden': 'true' }, '▾')));
  };
  // A toggle in the channel and problem pickers.
  const option = (on, text, onclick, extra) => h('button', {
    type: 'button', class: `rule-opt${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick,
  }, h('span', { class: 'rule-tick', 'aria-hidden': 'true' }, on ? '✓' : ''), text, extra);

  const toggleIn = (list, id) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const matchCount = (test) => {
    const n = state.monitors.filter((m) => test(m.tags)).length;
    return `${n} of ${state.monitors.length} monitor${state.monitors.length === 1 ? '' : 's'}`;
  };

  function picker(rule) {
    const box = h('div', { class: 'rule-pop' });
    if (open.slot === 'channels') {
      fill(box,
        h('div', { class: 'rule-pop-title' }, 'Send to'),
        channels.length
          ? h('div', { class: 'rule-opts' }, channels.map((c) => option(rule.channelIds.includes(c.id), c.name,
            () => change({ channelIds: toggleIn(rule.channelIds, c.id) }),
            [h('span', { class: 'muted small' }, ` · ${catalog[c.type]?.label ?? c.type}`), c.active ? null : h('span', { class: 'muted small' }, ' · inactive')])))
          : h('p', { class: 'muted small' }, 'No channels yet. Add one under Channels first.'));
    } else if (open.slot === 'problems') {
      fill(box,
        h('div', { class: 'rule-pop-title' }, 'When'),
        h('div', { class: 'rule-opts' },
          option(!rule.problemIds.length && !rule.minSeverity, 'Any problem', () => change({ problemIds: [], minSeverity: '' })),
          option(!rule.problemIds.length && rule.minSeverity === 'warning', 'Warning or worse', () => change({ problemIds: [], minSeverity: 'warning' })),
          option(!rule.problemIds.length && rule.minSeverity === 'severe', 'Any severe problem', () => change({ problemIds: [], minSeverity: 'severe' }))),
        h('div', { class: 'rule-pop-title' }, 'Or only problems from'),
        h('div', { class: 'rule-opts' },
          problems.map((p) => option(rule.problemIds.includes(p.id), p.name, () => change({ problemIds: toggleIn(rule.problemIds, p.id), minSeverity: '' }), [' ', sevBadge(p.severity)]))));
    } else if (open.expr) {
      const pillsText = tags().filter((t) => rule.tagIds.includes(t.id)).map((t) => exprName(t.name)).join(rule.tagMatch === 'all' ? ' & ' : ' | ');
      tagExprEditor(box, {
        value: rule.tagExpr || pillsText,
        tags,
        describe: (expr) => (expr ? `${matchCount(expr.test)} match.` : 'Empty: all monitors.'),
        applyLabel: 'Use',
        onApply: (text) => {
          open = null;
          change(text ? { tagExpr: text } : { tagExpr: '', tagIds: [] });
        },
        // Back to the pills, unless the rule is an expression (the pills can't show it).
        onCancel: () => setOpen(rule.tagExpr ? null : { ...open, expr: false }),
        example: 'means the switches at either site.',
        id: 'rule-expr',
      });
    } else {
      const picked = rule.tagIds;
      const any = picked.length > 0;
      const test = ruleTagTest(rule, tags());
      fill(box,
        h('div', { class: 'rule-pop-title' }, 'For monitors tagged'),
        tags().length
          ? h('div', { class: 'tag-filter rule-tags' },
            tags().map((t) => {
              const on = picked.includes(t.id);
              return tagPill(t, {
                cls: on ? 'on' : any ? 'off' : '',
                pressed: String(on),
                title: on ? `Stop alerting for ${t.name}` : `Alert for monitors tagged ${t.name}`,
                onclick: () => change({ tagExpr: '', tagIds: toggleIn(picked.filter((id) => tags().some((x) => x.id === id)), t.id) }),
              });
            }),
            picked.length > 1 ? matchToggle(rule.tagMatch, (mode) => change({ tagMatch: mode })) : null)
          : h('p', { class: 'muted small' }, 'No tags yet. ', h('a', { href: '#/tags' }, 'Make some'), ' to send different alerts to different places.'),
        h('div', { class: 'rule-pop-foot' },
          h('span', { class: 'muted small' }, test.error ? test.error : any ? `${matchCount(test.test)} match.` : 'No tags picked: every monitor.'),
          any ? h('button', { type: 'button', class: 'linkish', onclick: () => change({ tagIds: [], tagExpr: '' }) }, 'All monitors') : null,
          tags().length ? h('button', { type: 'button', class: 'linkish', title: 'Combine tags with and, or and not', onclick: () => setOpen({ ...open, expr: true }) }, 'Advanced') : null));
    }
    return box;
  }

  function ruleRow(saved) {
    const edit = editing && editing.id === (saved?.id ?? 'new');
    const rule = edit ? editing.draft : saved;
    const problem = ruleProblem(rule, { tags: tags(), channels });
    const everyone = !rule.tagExpr && !rule.tagIds.length;
    const busy = Boolean(editing) && !edit; // another rule is being edited
    const noChannel = !rule.channelIds.some((id) => channels.some((c) => c.id === id));
    const later = busy ? 'Save or cancel the rule being edited first' : null;
    const actions = edit
      ? [
        h('button', {
          type: 'button',
          class: 'btn small primary',
          disabled: noChannel || !changed(),
          title: noChannel ? 'Pick a channel first' : changed() ? null : 'Nothing has changed',
          onclick: saveEdit,
        }, editing.id === 'new' ? 'Add' : 'Save'),
        h('button', { type: 'button', class: 'icon-btn rule-icon', title: 'Cancel', 'aria-label': 'Cancel', onclick: cancelEdit }, actionIcon('close')),
      ]
      : [
        h('button', { type: 'button', class: 'icon-btn rule-icon', disabled: busy, title: later ?? 'Edit', 'aria-label': 'Edit rule', onclick: () => startEdit(saved) }, actionIcon('edit')),
        h('button', { type: 'button', class: 'icon-btn rule-icon danger', disabled: busy, title: later ?? 'Delete', 'aria-label': 'Delete rule', onclick: () => removeRule(saved) }, actionIcon('trash')),
      ];
    const upstream = everyone
      ? h('span', { class: 'rule-none', title: 'This rule covers every monitor already' }, '—')
      : h('input', {
        type: 'checkbox',
        class: 'rule-check',
        checked: rule.downstream,
        disabled: !edit,
        'aria-label': 'Also when the fault is upstream of them',
        title: rule.downstream ? 'Also when the fault is upstream of them' : 'Only when one of them is at fault',
        onchange: (e) => change({ downstream: e.target.checked }),
      });
    return h('div', {
      class: `rule-row${edit ? ' editing' : ''}${problem && !edit ? ' broken' : ''}`,
      'data-rule': saved?.id ?? 'new',
      title: problem && !edit ? problem : null,
    },
    part('channels', channelPart(rule), edit, 'Send to'),
    part('problems', problemPart(rule), edit, 'When'),
    part('tags', tagPart(rule), edit, 'For'),
    h('div', { class: 'rule-cell rule-c-up', 'data-label': 'Upstream' }, upstream),
    h('div', { class: 'rule-cell rule-c-act' }, actions),
    edit && open ? picker(rule) : null);
  }

  function paintRules() {
    addRuleBtn.disabled = Boolean(editing);
    addRuleBtn.title = editing ? 'Save or cancel the rule being edited first' : '';
    if (!rules.length && !editing) {
      fill(rulesBox, h('p', { class: 'muted rule-empty' }, channels.length
        ? 'No rules yet, so no alerts are sent. Add one to choose who hears about what.'
        : 'No rules yet. Add a channel below first, then a rule to send alerts to it.'));
      return;
    }
    fill(rulesBox,
      h('div', { class: 'rule-row rule-head', 'aria-hidden': 'true' },
        h('div', null, 'Send to'), h('div', null, 'When'), h('div', null, 'For monitors'),
        h('div', { class: 'rule-c-up', title: 'Also alert when the monitor at fault has none of the tags but takes tagged monitors down with it (and when it brings them back)' }, 'Upstream'),
        h('div')),
      rules.map(ruleRow),
      editing?.id === 'new' ? ruleRow(null) : null);
    requestAnimationFrame(markClipped);
  }

  // Cells are one line: fade out the ones whose content doesn't fit.
  function markClipped() {
    for (const el of rulesBox.querySelectorAll('.rule-clip')) el.classList.toggle('over', el.scrollWidth > el.clientWidth + 1);
  }
  const resized = new ResizeObserver(() => (rulesBox.isConnected ? markClipped() : resized.disconnect()));
  resized.observe(rulesBox);

  // ---- channels -----------------------------------------------------------------

  const channelsBox = h('div');
  function paintChannels() {
    const uses = (c) => rules.filter((r) => r.channelIds.includes(c.id)).length;
    fill(channelsBox, channels.length ? h('div', { class: 'notif-list' }, channels.map((n) => h('div', { class: 'card notif' },
      h('div', null,
        h('h3', null, n.name),
        h('div', { class: 'muted small' }, catalog[n.type]?.label ?? n.type, n.active ? '' : ' · inactive', ' · ',
          uses(n) ? `in ${uses(n)} rule${uses(n) === 1 ? '' : 's'}` : h('span', { class: 'notif-unused' }, 'in no rule'))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => showForm(n) }, 'Edit'),
        h('button', {
          class: 'btn danger ghost',
          onclick: () => confirmDialog(`Delete ${n.name}?`, 'Rules that send to it stop sending to it.', 'Delete', async () => {
            await api(`notifications/${n.id}`, { method: 'DELETE' });
            reload();
          }),
        }, 'Delete'))))) : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No channels yet. Home Assistant notify services work out of the box when running as an add-on.')));
  }

  function showForm(n) {
    renderNotificationForm(formBox, { catalog, existing: n, alertAll: !rules.length, onDone: reload });
    formBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const reload = () => {
    outside.abort();
    return renderNotifications(main, { state });
  };

  // ---- problems -----------------------------------------------------------------

  // a definition started from a value in a monitor's All data
  const draft = takeDraftDefinition();
  const problemsCtl = renderProblemsSection(problemsBox, { state, problems, onChanged: () => reload(), draft });

  fill(main, h('div', { class: 'stack' },
    h('div', { class: 'page-head' },
      h('h1', null, 'Notifications'),
      h('p', { class: 'muted' }, 'Each rule sends a problem to channels, for the monitors with certain tags. An alert goes to every channel whose rule matches the monitor at fault.')),
    h('div', { class: 'page-head section-head' },
      h('h2', null, 'Notification rules'),
      addRuleBtn),
    rulesBox,
    h('div', { class: 'page-head section-head' },
      h('h2', null, 'Channels'),
      h('button', { class: 'btn primary', onclick: () => showForm(null) }, '+ Add channel')),
    formBox,
    channelsBox,
    h('div', { class: 'page-head section-head' },
      h('div', null,
        h('h2', null, 'Problem definitions'),
        h('p', { class: 'muted' }, 'What counts as a problem, for rules to alert on. Besides a monitor going down, a definition can watch an SNMP value on the monitors with certain tags, such as a UPS running on battery. Wherever it holds, that monitor has an open problem.')),
      h('button', { class: 'btn primary', onclick: () => problemsCtl.add() }, '+ Add definition')),
    problemsBox));
  paintRules();
  paintChannels();
  if (addingChannel) showForm(null);
  if (draft) requestAnimationFrame(() => problemsBox.querySelector('.problem-form')?.scrollIntoView({ block: 'start' }));
}
