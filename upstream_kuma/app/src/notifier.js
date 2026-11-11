import { haRequest } from './checkers/homeassistant.js';
import { log } from './config.js';

// An alert passed to every provider:
//   { kind: 'down' | 'up' | 'problem' | 'resolved' | 'test', title, message,
//     monitor, affected, time, problem?: { id, name, severity } }
// `title` is the one-line subject ("Alert: Host 2 is unreachable"); `message`
// is the plain-text body including the tree of affected downstream monitors.

// How loud an alert should be: 'urgent' (a monitor down, a severe problem),
// 'warning', or 'calm' (resolved, info, test).
export function level(a) {
  if (a.kind === 'down') return 'urgent';
  if (a.kind === 'problem') return a.problem?.severity === 'severe' ? 'urgent' : a.problem?.severity === 'warning' ? 'warning' : 'calm';
  return 'calm';
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
}

function required(cfg, ...keys) {
  for (const k of keys) if (!cfg[k]) throw new Error(`Missing "${k}"`);
}

export const providers = {
  homeassistant: {
    label: 'Home Assistant',
    fields: [
      { key: 'service', label: 'Service', placeholder: 'notify.mobile_app_my_phone', help: 'Any notify.* service, or persistent_notification.create' },
    ],
    async send(cfg, a) {
      required(cfg, 'service');
      const [domain, service] = cfg.service.replace(/^\//, '').split('.');
      if (!domain || !service) throw new Error('Service must look like domain.service');
      const body = domain === 'persistent_notification'
        ? { title: a.title, message: a.message, notification_id: `upstream_kuma_${a.monitor?.id ?? 'test'}` }
        : { title: a.title, message: a.message };
      await haRequest(`/api/services/${domain}/${service}`, { method: 'POST', body });
    },
  },

  ntfy: {
    label: 'ntfy',
    fields: [
      { key: 'server', label: 'Server URL', placeholder: 'https://ntfy.sh' },
      { key: 'topic', label: 'Topic' },
      { key: 'token', label: 'Access token (optional)', secret: true },
      { key: 'priority', label: 'Priority for down alerts (1-5)', placeholder: '5' },
    ],
    async send(cfg, a) {
      required(cfg, 'topic');
      const server = (cfg.server || 'https://ntfy.sh').replace(/\/$/, '');
      await post(server, {
        topic: cfg.topic,
        title: a.title,
        message: a.message,
        priority: { urgent: Number(cfg.priority || 5), warning: 4, calm: 3 }[level(a)],
        tags: [{ urgent: 'rotating_light', warning: 'warning', calm: 'droplet' }[level(a)]],
      }, cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {});
    },
  },

  discord: {
    label: 'Discord',
    fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true }],
    async send(cfg, a) {
      required(cfg, 'webhookUrl');
      await post(cfg.webhookUrl, {
        username: 'Upstream Kuma',
        embeds: [{
          title: a.title,
          description: '```\n' + a.message.slice(0, 3900) + '\n```',
          color: { urgent: 0xef4444, warning: 0xfbbf24, calm: 0x22d3ee }[level(a)],
          timestamp: new Date(a.time).toISOString(),
        }],
      });
    },
  },

  slack: {
    label: 'Slack',
    fields: [{ key: 'webhookUrl', label: 'Incoming webhook URL', secret: true }],
    async send(cfg, a) {
      required(cfg, 'webhookUrl');
      await post(cfg.webhookUrl, { text: `*${a.title}*\n\`\`\`${a.message}\`\`\`` });
    },
  },

  telegram: {
    label: 'Telegram',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true },
      { key: 'chatId', label: 'Chat ID' },
    ],
    async send(cfg, a) {
      required(cfg, 'botToken', 'chatId');
      await post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        chat_id: cfg.chatId,
        text: `${a.title}\n\n${a.message}`,
      });
    },
  },

  pushover: {
    label: 'Pushover',
    fields: [
      { key: 'userKey', label: 'User key', secret: true },
      { key: 'appToken', label: 'Application token', secret: true },
    ],
    async send(cfg, a) {
      required(cfg, 'userKey', 'appToken');
      await post('https://api.pushover.net/1/messages.json', {
        token: cfg.appToken,
        user: cfg.userKey,
        title: a.title,
        message: a.message,
        priority: level(a) === 'urgent' ? 1 : 0,
      });
    },
  },

  gotify: {
    label: 'Gotify',
    fields: [
      { key: 'server', label: 'Server URL', placeholder: 'https://gotify.example.com' },
      { key: 'appToken', label: 'Application token', secret: true },
    ],
    async send(cfg, a) {
      required(cfg, 'server', 'appToken');
      await post(`${cfg.server.replace(/\/$/, '')}/message`, {
        title: a.title,
        message: a.message,
        priority: { urgent: 8, warning: 6, calm: 4 }[level(a)],
      }, { 'X-Gotify-Key': cfg.appToken });
    },
  },

  webhook: {
    label: 'Webhook (JSON)',
    fields: [{ key: 'url', label: 'URL' }],
    async send(cfg, a) {
      required(cfg, 'url');
      await post(cfg.url, {
        kind: a.kind,
        title: a.title,
        message: a.message,
        time: new Date(a.time).toISOString(),
        monitor: a.monitor,
        problem: a.problem ?? null,
        affected: a.affected,
      });
    },
  },

  email: {
    label: 'Email (SMTP)',
    fields: [
      { key: 'host', label: 'SMTP host' },
      { key: 'port', label: 'Port', placeholder: '587' },
      { key: 'secure', label: 'Use TLS from the start (port 465)', type: 'checkbox' },
      { key: 'username', label: 'Username' },
      { key: 'password', label: 'Password', secret: true },
      { key: 'from', label: 'From', placeholder: 'Upstream Kuma <alerts@example.com>' },
      { key: 'to', label: 'To (comma separated)' },
    ],
    async send(cfg, a) {
      required(cfg, 'host', 'from', 'to');
      const { default: nodemailer } = await import('nodemailer');
      const transport = nodemailer.createTransport({
        host: cfg.host,
        port: Number(cfg.port || 587),
        secure: Boolean(cfg.secure),
        auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
      });
      await transport.sendMail({ from: cfg.from, to: cfg.to, subject: a.title, text: a.message });
    },
  },
};

// Sends to every channel; never throws. Returns a delivery report per channel.
export async function deliver(channels, alert) {
  return Promise.all(channels.map(async (ch) => {
    const provider = providers[ch.type];
    try {
      if (!provider) throw new Error(`Unknown notification type "${ch.type}"`);
      await provider.send(ch.config, alert);
      log.info(`Sent "${alert.title}" via ${ch.name}`);
      return { id: ch.id, name: ch.name, ok: true };
    } catch (err) {
      log.error(`Notification "${ch.name}" failed:`, err.message);
      return { id: ch.id, name: ch.name, ok: false, error: err.message };
    }
  }));
}

export function providerCatalog() {
  return Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, { label: p.label, fields: p.fields }]));
}
