# Waterfall Alert

Hierarchical uptime monitoring: monitors are arranged like folders, checked top-down, and a failure sends **one alert for the root cause** that lists everything downstream of it.

- HTTP(S), TCP, ping, DNS, Home Assistant entity, Minecraft, push and group monitors
- Multiple parents per monitor, drag-and-drop editing
- Click a monitor in the falls diagram to trace its upstream and downstream
- Monitor icons: automatic favicons, built-in icons, emoji, image URL or upload
- Coloured tags with filtering, and bulk tagging by selecting monitors in the falls diagram
- Uptime Kuma-style heartbeat history and response-time charts
- Notifications via Home Assistant, ntfy, Discord, Slack, Telegram, Pushover, Gotify, webhook or email
