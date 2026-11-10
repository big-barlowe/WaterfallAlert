import { api, h, svg, modal, toast, fill } from './util.js';
import { parseTagExpr, exprName } from './filter.js';

// Preset tag colours. Any #rrggbb works; these just read well on the dark
// background and stay clear of the status colours.
export const TAG_COLORS = ['#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#f472b6', '#fb923c', '#facc15', '#a3e635', '#22d3ee', '#94a3b8'];

export const nextTagColor = (tags) => TAG_COLORS.find((c) => !tags.some((t) => t.color === c)) ?? TAG_COLORS[tags.length % TAG_COLORS.length];

// What to draw for a tag's default icon (null if it has none), in the form
// iconEl()/iconSvg() take.
export function tagIconView(tag) {
  const spec = tag?.icon;
  if (!spec) return null;
  if (spec === 'upload') return { kind: 'image', src: `api/tags/${tag.id}/icon?v=${tag.iconV}` };
  const i = spec.indexOf(':');
  const value = spec.slice(i + 1);
  return { builtin: { kind: 'builtin', name: value }, emoji: { kind: 'emoji', value }, url: { kind: 'image', src: value } }[spec.slice(0, i)] ?? null;
}

// A small coloured pill. With `onclick` it is a button.
export function tagPill(tag, { onclick, title, extra, pressed, cls = '' } = {}) {
  return h(onclick ? 'button' : 'span', {
    type: onclick ? 'button' : null,
    class: `tag-pill${cls ? ` ${cls}` : ''}`,
    style: { '--tag': tag.color },
    title,
    'aria-pressed': pressed,
    onclick,
  }, h('span', { class: 'tag-name' }, tag.name), extra);
}

// How a filter with several tags combines them: 'any' (union, like a full
// outer join) or 'all' (intersection, like an inner join).
export const TAG_MATCH = {
  any: { label: 'Any', title: 'Any tag: monitors with at least one of the selected tags (union / full outer join)' },
  all: { label: 'All', title: 'All tags: only monitors with every selected tag (intersection / inner join)' },
};

// Two overlapping circles with the matching part shaded.
export function matchIcon(mode) {
  const circles = 'M13.5 7a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0ZM19.5 7a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0Z';
  const lens = 'M11 2.39A5.5 5.5 0 0 1 11 11.61A5.5 5.5 0 0 1 11 2.39Z';
  return svg('svg', { class: `venn ${mode}`, viewBox: '0 0 22 14', width: 22, height: 14, 'aria-hidden': 'true' },
    svg('path', { class: 'venn-fill', d: mode === 'all' ? lens : circles }),
    svg('path', { class: 'venn-line', d: circles }));
}

// Swatches plus a custom colour input.
export function colorPicker(value, onPick, label = 'Tag colour') {
  const custom = h('input', {
    type: 'color',
    class: 'swatch-custom',
    value,
    title: 'Custom colour',
    'aria-label': 'Custom colour',
    onchange: (e) => onPick(e.target.value.toLowerCase()),
  });
  return h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': label },
    TAG_COLORS.map((c) => h('button', {
      type: 'button',
      class: `swatch${c === value ? ' on' : ''}`,
      style: { '--tag': c },
      role: 'radio',
      'aria-checked': String(c === value),
      'aria-label': c,
      onclick: () => onPick(c),
    })),
    custom);
}

// Modal that creates a tag; resolves `onCreated(tag)` once saved.
export function newTagDialog(tags, onCreated) {
  let color = nextTagColor(tags);
  const name = h('input', { id: 'tag-new-name', maxlength: 32, placeholder: 'Site A', autocomplete: 'off' });
  const preview = h('div', { class: 'tag-preview' });
  const pickerBox = h('div');
  const paint = () => {
    preview.replaceChildren(tagPill({ name: name.value.trim() || 'New tag', color }));
    pickerBox.replaceChildren(colorPicker(color, (c) => {
      color = c;
      paint();
    }));
  };
  name.addEventListener('input', paint);
  paint();
  const create = async () => {
    try {
      const tag = await api('tags', { method: 'POST', body: { name: name.value, color } });
      await onCreated(tag);
    } catch (err) {
      toast(err.message, 'error');
      return false;
    }
  };
  name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.target.closest('.modal')?.querySelector('.modal-actions .primary')?.click();
  });
  modal('New tag', h('div', { class: 'stack-sm' },
    h('div', { class: 'field' }, h('label', { for: 'tag-new-name' }, 'Name'), name),
    h('div', { class: 'field' }, h('label', null, 'Colour'), pickerBox),
    preview), [{ label: 'Create tag', onClick: create }]);
  name.focus();
}

// Any of the tags (union) or all of them (intersection).
export function matchToggle(current, onPick) {
  return h('span', { class: 'match-toggle', role: 'radiogroup', 'aria-label': 'Monitors must have' },
    Object.entries(TAG_MATCH).map(([mode, { label, title }]) => h('button', {
      type: 'button',
      class: `match-btn${current === mode ? ' on' : ''}`,
      role: 'radio',
      'aria-checked': String(current === mode),
      'aria-label': label,
      title,
      onclick: () => onPick(mode),
    }, matchIcon(mode))));
}

// Operators the expression editor offers as buttons: [text, label, title].
const EXPR_OPS = [
  ['&', 'and', 'And: both sides must match'],
  ['|', 'or', 'Or: either side may match'],
  ['!', 'not', 'Not: everything except what follows'],
  ['(', '(', 'Open a group (closed for you if you leave it open)'],
  [')', ')', 'Close the group'],
];

// A tag expression (filter.js) in one line of text, checked as you type.
// Clicking a tag or an operator inserts it at the cursor, so one can be
// built without typing. Used by the tag filter and by notification rules.
//   value       starting text
//   tags()      the current tags
//   describe(expr)  status line for a valid expression (expr is null if empty)
//   onApply(text)   with any open brackets closed ('' = cleared)
//   onCancel()
//   id          prefix of the input's and status line's element ids
// Sets box.exprCheck to re-run the check.
export function tagExprEditor(box, { value, tags, describe, applyLabel = 'Apply', onApply, onCancel, example = '', placeholder = 'Switch & (Home | Cabin)', id = 'expr' }) {
  const input = h('input', {
    id: `${id}-input`,
    class: 'expr-input',
    value,
    placeholder,
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Tag expression',
    'aria-describedby': `${id}-status`,
    oninput: () => check(),
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    },
  });
  const status = h('div', { id: `${id}-status`, class: 'expr-status', 'aria-live': 'polite' });
  const applyBtn = h('button', { type: 'button', class: 'btn small primary', onclick: () => apply() }, applyLabel);
  const check = () => {
    const expr = parseTagExpr(input.value, tags());
    applyBtn.disabled = Boolean(expr?.error);
    if (expr?.error) return fill(status, h('span', { class: 'expr-error' }, expr.error));
    fill(status, h('span', { class: 'muted' }, describe(expr)));
  };
  const apply = () => {
    const expr = parseTagExpr(input.value, tags());
    if (expr?.error) return;
    onApply(expr ? input.value.trimEnd() + ')'.repeat(expr.unclosed) : '');
  };
  box.exprCheck = () => check();
  // Spaces around & and |, none inside brackets or after !.
  const insert = (token, op) => {
    const { selectionStart, selectionEnd, value: text } = input;
    let before = text.slice(0, selectionStart);
    let add = op ? token : exprName(token);
    if (op === ')') before = before.trimEnd();
    else if (before && !/\s$/.test(before) && (op === '&' || op === '|' || !/[(!]$/.test(before))) add = ` ${add}`;
    if (op === '&' || op === '|') add += ' ';
    input.value = before + add + text.slice(selectionEnd);
    const at = before.length + add.length;
    input.focus();
    input.setSelectionRange(at, at);
    check();
  };
  fill(box,
    h('div', { class: 'expr-editor' },
      input,
      h('div', { class: 'expr-row' }, status, applyBtn,
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => onCancel() }, 'Cancel')),
      h('div', { class: 'expr-ops', role: 'group', 'aria-label': 'Insert an operator' }, EXPR_OPS.map(([op, label, title]) => h('button', {
        type: 'button',
        class: 'expr-op',
        title,
        'aria-label': title,
        onclick: () => insert(op, op),
      }, op === label ? op : [h('b', null, op), ` ${label}`]))),
      h('div', { class: 'expr-tags' }, tags().map((t) => tagPill(t, {
        title: `Insert ${t.name}`,
        onclick: () => insert(t.name),
      }))),
      h('p', { class: 'expr-help' },
        'Click operators and tags to build an expression, or type it. ',
        'E.g. ', h('code', null, 'Switch & (Home | Cabin)'), ` ${example}`)));
  check();
}
