import { api, h, svg, modal, toast } from './util.js';

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
