# Waterfall Alert

Hierarchical uptime monitoring: monitors are arranged like folders, checked top-down, and a failure sends **one alert for the root cause** that lists everything downstream of it.

- HTTP(S), TCP, ping, DNS, Home Assistant entity, push and group monitors
- Multiple parents per monitor, drag-and-drop editing
- Uptime Kuma-style heartbeat history and response-time charts
- Notifications via Home Assistant, ntfy, Discord, Slack, Telegram, Pushover, Gotify, webhook or email
