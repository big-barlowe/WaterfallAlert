# Waterfall Alert

## How checking works

Every monitor runs on its own interval, but it only touches the network when its **parents are up**.

| Status | Meaning |
|---|---|
| **Up** | The last check passed. |
| **Pending** | A check failed and it is retrying (see *Retries before down*), or a parent is itself still retrying. |
| **Down** | Failures confirmed and the parents are up, so this is the root cause. An alert is sent. |
| **Blocked upstream** | Not checked, because something above it is down. Listed in that monitor's alert instead of alerting itself. |
| **Paused** | Not checked. A paused monitor never blocks the monitors beneath it. |

When a monitor fails:

1. It retries `Retries before down` times, `Retry every` seconds apart.
2. It then **re-checks its parents** before blaming itself. If a parent turns out to be down, the alert is raised on the parent instead.
3. The down monitor sends **one alert** to its notification channels. The subject is `Alert: <name> is unreachable` (ping/TCP/DNS) or `Alert: <name> is down`, and the body lists every monitor that is now blocked beneath it.
4. When it recovers you get `Resolved: <name> is back up`, and the monitors directly beneath it are re-checked immediately. Each of those then re-checks its own children, so recovery flows down one level at a time.

After a restart, monitors that were already down don't alert again.

### Multiple parents

A monitor can have several parents. With more than one parent, choose one of:

- **Blocked if any parent is down** (default): it depends on all of them, e.g. an app that needs both its host and its database.
- **Blocked only if every parent is down**: redundant paths, e.g. a service reachable over either of two WAN links.

### Groups

A *group* is a plain folder. It has no check of its own and never blocks what's inside it. It shows the worst status of its contents.

## Arranging monitors

- **Edit button** (above the monitor list): drag a monitor onto another to move it underneath. Hold <kbd>Alt</kbd>/<kbd>⌥</kbd> while dropping to **add** that monitor as an extra parent instead of moving. Drop it on *Drop here to move to the top level* to make it top level. The row buttons are: **+** (add a monitor beneath), **⇅** (move, which also works on touch screens), **✎** (settings) and **⨯** (detach from this parent).
- **Monitor settings → Hierarchy**: the *Parent monitors* and *Dependent monitors* lists. They stay in sync: adding a parent here lists this monitor as that parent's dependent. Any choice that would create a loop is hidden.

## The Falls

The dashboard diagram shows the whole hierarchy as streams: water flows from healthy monitors, runs dry below a monitor that is down, and goes still below blocked or paused ones.

- **Click a monitor** to trace it: the diagram shows only what it depends on (upstream) and what depends on it (downstream). Click it again, press <kbd>Esc</kbd>, click empty space or use **Show all** to see everything. **Trace in Falls** on a monitor's page does the same.
- **The expand button** (top-right corner of a monitor) opens a details panel with its status, response times, heartbeats and its full upstream and downstream lists. Click a monitor in those lists to trace that one instead.

## Icons

Choose a monitor's icon under **Settings → General → Icon**:

| Option | |
|---|---|
| Automatic (default) | HTTP monitors use the website's favicon and Minecraft monitors the server icon. Groups show a folder. Other types have no icon. |
| Built-in | A set of simple icons for routers, servers, NAS boxes, databases, containers and more. |
| Emoji | Any emoji. |
| Image URL | Any image, e.g. from the [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) project. |
| Upload | PNG, JPEG, GIF, WebP, SVG or ICO, shrunk to 128 px. |
| None | No icon. |

Favicons and image URLs are downloaded by the add-on and stored in its database, so the browser never has to reach the site (useful when Home Assistant is served over HTTPS and the site is plain HTTP, or only reachable from the add-on). The add-on checks for a favicon in the page's `<link rel="icon">` tags, then the site's home page, then `/favicon.ico`. Icons are refreshed weekly; saving the monitor fetches its icon again straight away.

## Notifications

Add channels under **Notifications**. Each monitor chooses which channels it uses. Channels marked *default* are pre-selected for new monitors. Alerts go to the channels of the **monitor that is actually down**, i.e. the top of the affected branch.

- **Home Assistant**: any `notify.*` service (e.g. `notify.mobile_app_pixel`), or `persistent_notification.create`. This works with no setup when running as an add-on.
- **ntfy, Discord, Slack, Telegram, Pushover, Gotify, Webhook, Email (SMTP)**: fill in the fields and use **Send test**.

The webhook channel POSTs JSON: `{ kind, title, message, time, monitor, affected: [{ id, name, depth }] }`.

The **Alerts** page lists every alert that was sent and which channels delivered it.

## Monitor types

| Type | Checks |
|---|---|
| HTTP(S) | Status code in the accepted list (default `200-299`), optionally a keyword in the body. Follows redirects. |
| TCP port | A TCP connection opens. |
| Ping | ICMP echo reply. |
| DNS | A record resolves (optionally against a specific resolver / expected value). SRV records read as `target:port`. |
| HA entity | The entity isn't `unavailable`/`unknown`, or matches the expected state(s). |
| Minecraft | A Java Edition server answers a status request (the one the multiplayer server list uses). Enter the address you'd type into the game: its `_minecraft._tcp` SRV record is followed, or set a port to skip that. Shows players online and the version. Bedrock isn't supported. |
| Push | Something calls `/api/push/<token>` at least once per interval. Add `?status=down&msg=…` to report a failure, `&ping=123` to record a time. |
| Group | Nothing; it's a folder. |

## Add-on options

| Option | Default | |
|---|---|---|
| `log_level` | `info` | `debug`, `info`, `warning` or `error`. |
| `allow_direct_access` | `false` | Allow the web UI on the add-on's mapped port without going through Home Assistant. Leave this off unless you have your own authentication in front of it: the UI itself has no login. |

### Push monitors and the network port

The UI is served through Home Assistant ingress (sidebar → **Waterfall**), which handles authentication. Push monitors need to be reachable by whatever sends the push, so map a host port under **Network**. With `allow_direct_access: false` (the default), only `/api/push/…` is reachable on that port.

## Data

Everything is stored in SQLite at `/data/waterfall.db` and is included in Home Assistant backups. Heartbeats older than the retention period (Settings, default 90 days) are pruned every 6 hours.
