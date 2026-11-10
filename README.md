# Waterfall Alert

Hierarchical uptime monitoring for Home Assistant, or on its own with Docker. It's as simple as Uptime Kuma, except it understands that **when the WAN is down, you don't need twenty alerts.**

Monitors form a hierarchy, like folders. Checks run top-down: if `Host 2` is unreachable, nothing beneath it gets checked, and you get **one** alert:

```
Alert: Host 2 is unreachable

Host 2 is unreachable.

Target: 192.168.1.20:22
Reason: Connection to 192.168.1.20:22 timed out
Time: Nov 5, 2026, 3:23:28 PM

Other affected monitors (3):
- Service 2.1
-- Microservice 2.1.1
- Service 2.2
```

![The Falls dashboard](docs/screenshot.png)

## Features

- **Hierarchical, root-cause alerting.** A monitor is only checked when its parents are up. When something fails, its parents are re-checked first, so the alert always names the highest failing monitor.
- **Multiple parents.** A monitor can depend on several parents. Choose whether it's blocked when *any* parent is down (it depends on all of them) or only when *every* parent is down (redundant paths, e.g. two WAN links).
- **Parents and dependents stay in sync.** Add a parent to a monitor and it shows up as that parent's dependent automatically, and the reverse works too.
- **Edit mode.** Drag a monitor onto another to nest it. Hold <kbd>Alt</kbd>/<kbd>⌥</kbd> to add an extra parent instead of moving it. Shift-click several to move them together. On touch screens, use the move (⇅) button. Loops are rejected.
- **Recovery cascades downward.** When a monitor recovers you get a *Resolved* message, and the level beneath it is re-checked immediately, one level at a time.
- **Heartbeat history** like Uptime Kuma: heartbeat bars, a response-time chart (1h–30d), 24h/30d uptime, and an event log. Retention is configurable.
- **Monitor types:** HTTP(S) (status codes, keyword), TCP port, ping, DNS (including SRV), Home Assistant entity state, Minecraft Java server (follows SRV records, shows players), SNMP v1/v2c (interfaces with traffic rates, CPU, memory, disks and custom OIDs, shown when you select the monitor; values named from built-in standard MIBs plus any vendor MIBs you add), push (heartbeat URL), and group (a plain folder).
- **Problems beyond down:** watch an SNMP value on every monitor with a tag, such as *UPS on battery* across a mix of makes (standard UPS-MIB, APC, Eaton, CyberPower), CPU, memory or disk. Problems are info, warning or severe; warnings and severe ones pulse in the Falls, and the Alerts page lists everything unresolved, filterable by severity and tag.
- **Notification rules:** *Alert [channels] when [problems] for [tags]*, with the same tag pills and expressions as the filter, or *any warning or worse*. Channels: Home Assistant notify services, ntfy, Discord, Slack, Telegram, Pushover, Gotify, generic JSON webhook, email (SMTP).
- **Water-themed UI.** A live "falls" diagram where healthy streams flow with a blue glow, streams below a failure run dry, and blocked branches go still. Drag to move around it and zoom like a map, or pop it out to fill the window. Click a monitor to trace just its upstream and downstream, and expand it for a details panel.
- **Icons.** HTTP monitors show their site's favicon automatically. You can also choose a built-in icon, an emoji, an image URL or upload your own.
- **CSV import & export.** Move all your monitors to another install, or edit many at once in a spreadsheet. An export imports as it is. See the [CSV guide](docs/csv.md).
- **Tags.** Coloured tags on each monitor, a tag filter for the list and the falls (matching any or all of the chosen tags, or an expression like `Switch & (Home | Cabin)`), default icons per tag, and bulk tagging: shift-click monitors or shift-drag a box over them, then add or remove tags, optionally including everything downstream.

## Install

Waterfall Alert runs as a Home Assistant add-on, or on its own on any machine with Docker.

### As a Home Assistant add-on

1. In Home Assistant go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
2. Add `https://github.com/big-barlowe/WaterfallAlert`.
3. Install **Waterfall Alert**, start it, and open **Waterfall** from the sidebar.

See [waterfall_alert/DOCS.md](waterfall_alert/DOCS.md) for configuration and usage details.

### With Docker (no Home Assistant needed)

Download [`compose.yaml`](compose.yaml) into an empty folder, set your time zone (`TZ`) in it, and start it:

```sh
mkdir waterfall-alert && cd waterfall-alert
curl -O https://raw.githubusercontent.com/big-barlowe/WaterfallAlert/main/compose.yaml
docker compose up -d
```

Or without Compose:

```sh
docker run -d --name waterfall-alert --restart unless-stopped \
  -p 8099:8099 -v /srv/waterfall-alert:/data -e TZ=America/Chicago \
  ghcr.io/big-barlowe/waterfall-alert:latest
```

Then open `http://<your-server>:8099`. Data is stored in `./data` (or the folder you mounted at `/data`). Every monitor type and notification channel works, except the two that talk to Home Assistant, which need a URL and access token if you want them.

> **There is no login.** Under Home Assistant, HA handles sign-in. Run on its own, anyone who can reach the port can use the app. Keep it on a trusted network, or put it behind a reverse proxy that adds authentication.

The **[Docker guide](docs/docker.md)** covers:
- image tags and pinning a version
- building from source
- configuration (time zone, connecting to Home Assistant)
- backups and updates
- a reverse proxy with a login
- networking (monitoring the Docker host itself, ping capabilities)
- moving between the add-on and Docker

## Development

Requires Node.js ≥ 22.13 (for the built-in `node:sqlite`).

```sh
cd waterfall_alert/app
npm install
npm start            # http://localhost:8099, data in ./data
npm test
```

No local Node? Build and run your working copy with Docker:

```sh
docker build -t waterfall-alert:dev waterfall_alert
docker run --rm -p 8099:8099 -v "$PWD/data:/data" waterfall-alert:dev
```

## License

MIT
