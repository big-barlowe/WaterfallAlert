import { api, h, toast, TYPE_LABEL, fill } from './util.js';
import { GLYPHS, iconEl, glyphPreview } from './icons.js';

const TYPE_FIELDS = {
  group: [],
  http: [
    { key: 'url', label: 'URL', placeholder: 'https://example.com/health', required: true },
    { key: 'method', label: 'Method', type: 'select', options: ['GET', 'HEAD', 'POST', 'PUT'], def: 'GET' },
    { key: 'acceptedCodes', label: 'Accepted status codes', placeholder: '200-299', def: '200-299' },
    { key: 'keyword', label: 'Keyword (optional)', help: 'Down unless the response body contains this text' },
    { key: 'invertKeyword', label: 'Invert keyword (down if present)', type: 'checkbox' },
    { key: 'ignoreTls', label: 'Ignore TLS/SSL errors', type: 'checkbox' },
    { key: 'headers', label: 'Headers (JSON, optional)', type: 'textarea', placeholder: '{"Authorization": "Bearer …"}' },
    { key: 'body', label: 'Request body (optional)', type: 'textarea' },
  ],
  tcp: [
    { key: 'host', label: 'Host', placeholder: '192.168.1.10', required: true },
    { key: 'port', label: 'Port', type: 'number', placeholder: '22', required: true },
  ],
  ping: [{ key: 'host', label: 'Host', placeholder: '192.168.1.1', required: true }],
  dns: [
    { key: 'hostname', label: 'Hostname', placeholder: 'example.com', required: true },
    { key: 'recordType', label: 'Record type', type: 'select', options: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'], def: 'A' },
    { key: 'server', label: 'Resolver (optional)', placeholder: '1.1.1.1' },
    { key: 'expected', label: 'Expected value contains (optional)' },
  ],
  ha_entity: [
    { key: 'entityId', label: 'Entity ID', placeholder: 'binary_sensor.nas_online', required: true },
    { key: 'expectedState', label: 'Expected state (optional)', placeholder: 'on, home', help: 'Comma separated. Blank = up unless "unavailable" or "unknown".' },
  ],
  push: [],
};

const TYPE_HELP = {
  group: 'A folder. It has no check of its own and never blocks what is inside it; its status is the worst of its contents.',
  http: 'Requests a URL and checks the status code, optionally a keyword in the body.',
  tcp: 'Opens a TCP connection to a host and port.',
  ping: 'Sends an ICMP ping.',
  dns: 'Resolves a DNS record.',
  ha_entity: 'Watches a Home Assistant entity state.',
  push: 'Passive: something else calls the push URL. Down if no push arrives within the interval.',
};

function field(f, value, onChange) {
  const id = `f-${f.key}`;
  let input;
  if (f.type === 'select') {
    input = h('select', { id, onchange: (e) => onChange(e.target.value) },
      f.options.map((o) => h('option', { value: o, selected: (value ?? f.def) === o }, typeof o === 'string' ? o : o.label)));
  } else if (f.type === 'checkbox') {
    return h('label', { class: 'check' },
      h('input', { type: 'checkbox', id, checked: Boolean(value), onchange: (e) => onChange(e.target.checked) }),
      h('span', null, f.label));
  } else if (f.type === 'textarea') {
    input = h('textarea', { id, rows: 3, placeholder: f.placeholder || '', value: value ?? '', oninput: (e) => onChange(e.target.value) });
  } else {
    input = h('input', {
      id,
      type: f.type === 'number' ? 'number' : f.secret ? 'password' : 'text',
      placeholder: f.placeholder || '',
      required: f.required,
      autocomplete: 'off',
      value: value ?? f.def ?? '',
      oninput: (e) => onChange(e.target.value),
    });
  }
  return h('div', { class: 'field' },
    h('label', { for: id }, f.label),
    input,
    f.help ? h('small', null, f.help) : null);
}

const ICON_MODES = [['auto', 'Automatic'], ['builtin', 'Built-in'], ['emoji', 'Emoji'], ['url', 'Image URL'], ['upload', 'Upload'], ['none', 'None']];
const EMOJI = ['🌐', '📡', '🖥️', '🗄️', '💾', '🐳', '🏠', '🔒', '📷', '💡', '🎬', '🎵', '🖨️', '☁️', '⚡', '🌡️'];

function iconMode(spec) {
  if (spec === 'none' || spec === 'upload') return spec;
  const kind = spec.split(':')[0];
  return ['builtin', 'emoji', 'url'].includes(kind) && spec.includes(':') ? kind : 'auto';
}

// Uploads are shrunk to at most 128px PNG in the browser. SVGs are drawn at
// full size since they scale cleanly.
async function toIconDataUrl(file) {
  const src = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const w0 = img.naturalWidth || 128;
    const h0 = img.naturalHeight || 128;
    const isSvg = file.type === 'image/svg+xml';
    const scale = isSvg ? 128 / Math.max(w0, h0) : Math.min(1, 128 / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(src);
  }
}

// Everything reachable downstream of `start` in the edited graph.
function downstream(childMap, start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    for (const c of childMap.get(queue.shift()) ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return seen;
}

export async function renderMonitorForm(root, { state, id, presetParent, navigate }) {
  const [existing, notifications] = await Promise.all([
    id ? api(`monitors/${id}`) : null,
    api('notifications'),
  ]);
  const self = id ?? 'new';
  const draft = existing
    ? structuredClone(existing)
    : {
      name: '', type: 'http', config: {}, interval: 60, retries: 1, retryInterval: 20, timeout: 10,
      resendInterval: 0, parentMode: 'all', description: '', active: true,
      parentIds: presetParent ? [presetParent] : [], childIds: [],
      notificationIds: notifications.filter((n) => n.isDefault).map((n) => n.id),
    };
  const monitors = state.monitors;
  const nameOf = (mid) => monitors.find((m) => m.id === mid)?.name ?? `#${mid}`;

  const childMapWithDraft = () => {
    const map = new Map(monitors.map((m) => [m.id, new Set(m.children)]));
    map.set(self, new Set(draft.childIds));
    for (const [pid, kids] of map) if (pid !== self) kids.delete(self);
    for (const p of draft.parentIds) map.get(p)?.add(self);
    return map;
  };

  const form = h('form', { class: 'card form', novalidate: true });
  const typeBox = h('div');
  const iconBox = h('div', { class: 'field icon-field' });
  const hierarchyBox = h('div');

  const renderType = () => {
    fill(typeBox, 
      h('p', { class: 'help' }, TYPE_HELP[draft.type]),
      TYPE_FIELDS[draft.type].map((f) => field(f, draft.config[f.key], (v) => { draft.config[f.key] = v; })),
      draft.type === 'push' ? pushInfo() : null);
  };

  // Icon: remember each mode's value so flipping between modes loses nothing.
  draft.icon ??= '';
  const live = id ? state.byId.get(id)?.icon : null; // the icon shown right now
  let mode = iconMode(draft.icon);
  const memo = { builtin: 'server', emoji: '', url: '' };
  if (['builtin', 'emoji', 'url'].includes(mode)) memo[mode] = draft.icon.slice(mode.length + 1);

  const iconSpec = () => (mode === 'auto' ? '' : ['none', 'upload'].includes(mode) ? mode : memo[mode] ? `${mode}:${memo[mode]}` : '');

  const iconPreview = () => {
    if (mode === 'builtin') return iconEl({ kind: 'builtin', name: memo.builtin }, 30);
    if (mode === 'emoji') return memo.emoji ? iconEl({ kind: 'emoji', value: memo.emoji }, 30) : null;
    if (mode === 'url') return memo.url ? iconEl({ kind: 'image', src: memo.url }, 30) : null;
    if (mode === 'upload') {
      if (draft.iconData) return iconEl({ kind: 'image', src: draft.iconData }, 30);
      return existing?.icon === 'upload' ? iconEl(live, 30) : null;
    }
    if (mode === 'auto' && draft.type === 'group') return iconEl({ kind: 'builtin', name: 'folder' }, 30);
    if (mode === 'auto' && draft.type === 'http' && existing?.icon === '' && existing.type === 'http') return iconEl(live, 30);
    return null;
  };

  const renderIcon = () => {
    const previewBox = h('div', { class: 'icon-preview', title: 'Preview' }, iconPreview() ?? h('span', { class: 'muted' }, '—'));
    const refresh = () => fill(previewBox, iconPreview() ?? h('span', { class: 'muted' }, '—'));
    let controls = null;
    let help = null;
    if (mode === 'auto') {
      help = draft.type === 'http'
        ? 'Uses the website’s favicon. Waterfall Alert fetches it after you save, and re-checks it weekly.'
        : draft.type === 'group' ? 'Groups show a folder.' : 'HTTP monitors show the website’s favicon and groups show a folder. Other types have no icon unless you pick one.';
    } else if (mode === 'builtin') {
      controls = h('div', { class: 'glyph-grid', role: 'listbox', 'aria-label': 'Built-in icons' },
        Object.keys(GLYPHS).map((name) => h('button', {
          type: 'button',
          class: `glyph-pick${memo.builtin === name ? ' on' : ''}`,
          title: name,
          role: 'option',
          'aria-selected': String(memo.builtin === name),
          onclick: () => {
            memo.builtin = name;
            renderIcon();
          },
        }, glyphPreview(name, 20))));
    } else if (mode === 'emoji') {
      const input = h('input', {
        id: 'f-icon-emoji',
        class: 'emoji-input',
        maxlength: 16,
        value: memo.emoji,
        placeholder: '🖥️',
        'aria-label': 'Emoji',
        oninput: (e) => {
          memo.emoji = e.target.value.trim();
          refresh();
        },
      });
      controls = h('div', { class: 'emoji-row' }, input,
        EMOJI.map((em) => h('button', {
          type: 'button',
          class: 'emoji-pick',
          onclick: () => {
            memo.emoji = em;
            input.value = em;
            refresh();
          },
        }, em)));
    } else if (mode === 'url') {
      controls = h('input', {
        id: 'f-icon-url',
        type: 'url',
        value: memo.url,
        placeholder: 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/proxmox.svg',
        'aria-label': 'Image URL',
        oninput: (e) => {
          memo.url = e.target.value.trim();
        },
        onchange: refresh,
      });
      help = 'Waterfall Alert downloads and caches the image, so the browser never has to reach that site. The dashboard-icons project has logos for most self-hosted apps.';
    } else if (mode === 'upload') {
      controls = h('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon,.ico',
        'aria-label': 'Icon image',
        onchange: async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            draft.iconData = await toIconDataUrl(file);
            refresh();
          } catch {
            toast('Couldn’t read that image', 'error');
          }
        },
      });
      help = 'PNG, JPEG, GIF, WebP, SVG or ICO. It is shrunk to 128 px.';
    }
    fill(iconBox,
      h('label', { for: 'f-icon-mode' }, 'Icon'),
      h('div', { class: 'icon-row' },
        previewBox,
        h('div', { class: 'icon-controls' },
          h('select', {
            id: 'f-icon-mode',
            onchange: (e) => {
              mode = e.target.value;
              renderIcon();
            },
          }, ICON_MODES.map(([k, label]) => h('option', { value: k, selected: mode === k }, label))),
          controls)),
      help ? h('small', null, help) : null);
  };

  const pushInfo = () => {
    if (!existing?.pushToken) return h('p', { class: 'help' }, 'Save the monitor to get its push URL.');
    const path = `api/push/${existing.pushToken}`;
    return h('div', { class: 'push-info' },
      h('label', null, 'Push URL'),
      h('code', null, `http://<home-assistant-host>:<port>/${path}?status=up&msg=OK&ping=`),
      h('small', null, 'Map the add-on port under Settings → Add-ons → Waterfall Alert → Network to make this reachable. Add ?status=down to report a failure.'));
  };

  const chipList = (ids, onRemove, empty) => ids.length
    ? h('div', { class: 'chips' }, ids.map((mid) => h('span', { class: 'chip' },
      h('span', { class: `dot ${monitors.find((m) => m.id === mid)?.status ?? 'pending'}` }),
      nameOf(mid),
      h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${nameOf(mid)}`, onclick: () => onRemove(mid) }, '×'))))
    : h('p', { class: 'muted small' }, empty);

  const adder = (label, candidates, onAdd) => h('select', {
    class: 'adder',
    onchange: (e) => {
      if (e.target.value) onAdd(Number(e.target.value));
    },
  },
  h('option', { value: '' }, label),
  candidates.map((m) => h('option', { value: m.id }, m.name)));

  const renderHierarchy = () => {
    const map = childMapWithDraft();
    const below = downstream(map, self);
    const parentCandidates = monitors.filter((m) => m.id !== self && !draft.parentIds.includes(m.id) && !below.has(m.id));
    const childCandidates = monitors.filter((m) => m.id !== self && !draft.childIds.includes(m.id) && !downstream(map, m.id).has(self));

    fill(hierarchyBox, 
      h('div', { class: 'rel-grid' },
        h('div', { class: 'rel' },
          h('h4', null, h('span', { class: 'rel-icon up' }, '↑'), 'Parent monitors'),
          h('small', null, 'Upstream. If a parent is down, this monitor is not checked and is listed in the parent’s alert instead.'),
          chipList(draft.parentIds, (mid) => {
            draft.parentIds = draft.parentIds.filter((x) => x !== mid);
            renderHierarchy();
          }, 'None — this is a top-level monitor.'),
          adder('+ Add parent…', parentCandidates, (mid) => {
            draft.parentIds.push(mid);
            renderHierarchy();
          }),
          draft.parentIds.length > 1 ? h('div', { class: 'field mode' },
            h('label', null, 'With more than one parent'),
            ['all', 'any'].map((mode) => h('label', { class: 'check' },
              h('input', { type: 'radio', name: 'parentMode', checked: draft.parentMode === mode, onchange: () => { draft.parentMode = mode; } }),
              h('span', null, mode === 'all'
                ? 'Blocked if any parent is down (depends on all of them)'
                : 'Blocked only if every parent is down (redundant paths)')))) : null),
        h('div', { class: 'rel' },
          h('h4', null, h('span', { class: 'rel-icon down' }, '↓'), 'Dependent monitors'),
          h('small', null, 'Downstream. These are skipped while this monitor is down.'),
          chipList(draft.childIds, (mid) => {
            draft.childIds = draft.childIds.filter((x) => x !== mid);
            renderHierarchy();
          }, 'None.'),
          adder('+ Add dependent…', childCandidates, (mid) => {
            draft.childIds.push(mid);
            renderHierarchy();
          }))),
      h('p', { class: 'help' }, 'These stay in sync: adding a parent here lists this monitor as that parent’s dependent, and vice versa. Monitors that would create a loop are hidden.'));
  };

  const num = (key, label, help, min) => h('div', { class: 'field' },
    h('label', { for: `f-${key}` }, label),
    h('input', { id: `f-${key}`, type: 'number', min, value: draft[key], oninput: (e) => { draft[key] = Number(e.target.value); } }),
    help ? h('small', null, help) : null);

  form.append(
    h('h2', null, existing ? `Edit ${existing.name}` : 'Add monitor'),
    h('section', null,
      h('h3', null, 'General'),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' },
          h('label', { for: 'f-type' }, 'Monitor type'),
          h('select', {
            id: 'f-type',
            onchange: (e) => {
              draft.type = e.target.value;
              draft.config = {};
              renderType();
              renderIcon();
            },
          }, Object.entries(TYPE_LABEL).map(([k, v]) => h('option', { value: k, selected: draft.type === k }, v)))),
        h('div', { class: 'field' },
          h('label', { for: 'f-name' }, 'Friendly name'),
          h('input', { id: 'f-name', required: true, value: draft.name, placeholder: 'Host 2', oninput: (e) => { draft.name = e.target.value; } }))),
      typeBox,
      h('div', { class: 'field' },
        h('label', { for: 'f-desc' }, 'Description (optional)'),
        h('input', { id: 'f-desc', value: draft.description, oninput: (e) => { draft.description = e.target.value; } })),
      iconBox),
    h('section', null,
      h('h3', null, 'Hierarchy'),
      hierarchyBox),
    h('section', { class: 'timing' },
      h('h3', null, 'Timing'),
      h('div', { class: 'grid-3' },
        num('interval', 'Check every (s)', null, 10),
        num('retries', 'Retries before down', 'Failures in a row before it counts as down', 0),
        num('retryInterval', 'Retry every (s)', null, 5),
        num('timeout', 'Timeout (s)', null, 1),
        num('resendInterval', 'Remind every N down checks', '0 = alert once', 0))),
    h('section', null,
      h('h3', null, 'Notifications'),
      notifications.length
        ? h('div', { class: 'checks' }, notifications.map((n) => h('label', { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: draft.notificationIds.includes(n.id),
            onchange: (e) => {
              draft.notificationIds = e.target.checked
                ? [...draft.notificationIds, n.id]
                : draft.notificationIds.filter((x) => x !== n.id);
            },
          }),
          h('span', null, n.name, h('span', { class: 'muted small' }, ` · ${n.type}`)))))
        : h('p', { class: 'muted' }, 'No notification channels yet. ', h('a', { href: '#/notifications' }, 'Add one'), ' to get alerts.'),
      h('p', { class: 'help' }, 'Alerts go to the channels of the monitor that is actually down (the top of the affected branch).')),
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => history.back() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, existing ? 'Save' : 'Create monitor')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const missing = TYPE_FIELDS[draft.type].find((f) => f.required && !String(draft.config[f.key] ?? '').trim());
    if (!draft.name.trim()) return toast('Name is required', 'error');
    if (missing) return toast(`${missing.label} is required`, 'error');
    draft.icon = iconSpec();
    if (mode === 'emoji' && !memo.emoji) return toast('Enter an emoji for the icon, or pick another option', 'error');
    if (mode === 'url' && !memo.url) return toast('Enter an image URL for the icon, or pick another option', 'error');
    if (mode === 'upload' && !draft.iconData && existing?.icon !== 'upload') return toast('Choose an image to upload for the icon', 'error');
    if (mode !== 'upload') delete draft.iconData;
    for (const f of TYPE_FIELDS[draft.type]) if (f.def && draft.config[f.key] == null) draft.config[f.key] = f.def;
    try {
      const saved = await api(existing ? `monitors/${existing.id}` : 'monitors', {
        method: existing ? 'PUT' : 'POST',
        body: draft,
      });
      toast(existing ? 'Saved' : 'Monitor created', 'success');
      navigate(`#/monitor/${saved.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  renderType();
  renderIcon();
  renderHierarchy();
  fill(root, form);
}

export function renderNotificationForm(root, { catalog, existing, onDone }) {
  const draft = existing
    ? structuredClone(existing)
    : { name: '', type: 'homeassistant', config: {}, isDefault: true, active: true, applyToAll: false };
  const fieldsBox = h('div');
  const renderFields = () => fill(fieldsBox, 
    catalog[draft.type].fields.map((f) => field(f, draft.config[f.key], (v) => { draft.config[f.key] = v; })));

  const form = h('form', { class: 'card form' },
    h('h2', null, existing ? `Edit ${existing.name}` : 'Add notification channel'),
    h('div', { class: 'grid-2' },
      h('div', { class: 'field' },
        h('label', { for: 'n-type' }, 'Type'),
        h('select', {
          id: 'n-type',
          onchange: (e) => {
            draft.type = e.target.value;
            draft.config = {};
            renderFields();
          },
        }, Object.entries(catalog).map(([k, v]) => h('option', { value: k, selected: draft.type === k }, v.label)))),
      h('div', { class: 'field' },
        h('label', { for: 'n-name' }, 'Name'),
        h('input', { id: 'n-name', value: draft.name, placeholder: 'My phone', oninput: (e) => { draft.name = e.target.value; } }))),
    fieldsBox,
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: draft.isDefault, onchange: (e) => { draft.isDefault = e.target.checked; } }),
      h('span', null, 'Enabled by default for new monitors')),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: draft.active, onchange: (e) => { draft.active = e.target.checked; } }),
      h('span', null, 'Active')),
    existing ? null : h('label', { class: 'check' },
      h('input', { type: 'checkbox', onchange: (e) => { draft.applyToAll = e.target.checked; } }),
      h('span', null, 'Also apply to all existing monitors')),
    h('div', { class: 'form-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => onDone() }, 'Cancel'),
      h('button', {
        type: 'button',
        class: 'btn',
        onclick: async () => {
          try {
            await api('notifications/test', { method: 'POST', body: draft });
            toast('Test notification sent', 'success');
          } catch (err) {
            toast(`Test failed: ${err.message}`, 'error');
          }
        },
      }, 'Send test'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Save')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(existing ? `notifications/${existing.id}` : 'notifications', { method: existing ? 'PUT' : 'POST', body: draft });
      toast('Saved', 'success');
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  renderFields();
  fill(root, form);
}
