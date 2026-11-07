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
- **Move several at once:** shift-click (or ctrl/⌘-click) monitors in the list to select them, or select them in the Falls. Then drag any selected row in Edit mode, or press **Move…** in the selection box at the top of the list, and they all move together. A selected monitor whose parent is also selected stays under that parent, so whole branches keep their shape. A monitor selected in the list moves away from the parent it was listed under; one selected in the Falls has all of its parents replaced (unless you choose to keep them).
- **Monitor settings → Hierarchy**: the *Parent monitors* and *Dependent monitors* lists. They stay in sync: adding a parent here lists this monitor as that parent's dependent. Any choice that would create a loop is hidden.

## The Falls

The dashboard diagram shows the whole hierarchy as streams: water flows from healthy monitors, runs dry below a monitor that is down, and goes still below blocked or paused ones.

It works like a map:

- **Move around** by dragging. On a touch screen, drag with one finger.
- **Zoom** with <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + scroll, by pinching on a trackpad or touch screen, or with the **−** and **+** buttons in the corner. Click the percentage for actual size, and the corners button to fit everything in again. A plain scroll still scrolls the page.
- The diagram starts out fitted to the space, and fits again when you trace a monitor or change the tag filter. When you leave a traced view, the monitor you traced stays where it is and the rest of the diagram fills in around it. Your zoom and position are otherwise kept, even when you open a monitor and come back.

- **Click a monitor** to trace it: the diagram shows only what it depends on (upstream) and what depends on it (downstream). Click it again, press <kbd>Esc</kbd>, click empty space or use **Show all** to see everything. **Trace in Falls** on a monitor's page does the same.
- **The expand button** (top-right corner of a monitor) opens a details panel with its status, response times, heartbeats and its full upstream and downstream lists. Click a monitor in those lists to trace that one instead.
- **Select monitors** to tag or move several at once: shift-click (or ctrl/⌘-click) them, or hold <kbd>Shift</kbd> and drag a box around them. <kbd>Alt</kbd>/<kbd>⌥</kbd>-drag removes from the selection instead. On a touch screen, tap **Select** first; one finger then draws the box and two fingers move and zoom. The selection is shared with the monitor list. See [Tags](#tags) and [Arranging monitors](#arranging-monitors).

## Tags

Tags are coloured labels for grouping monitors across the hierarchy, for example by site, room or owner. They show as small pills along the bottom of each monitor in the Falls and as coloured dots in the monitor list.

- **Filter:** click tags at the top of the sidebar to show only monitors with those tags, in both the list and the Falls. Monitors above a match stay visible, faded, so you can still see what the matches depend on.
- **Any or all:** with a filter on, the two Venn-diagram buttons next to the tags choose how several tags combine. **Any** (both circles shaded, a union or full outer join) shows monitors with at least one of the tags. **All** (only the overlap shaded, an intersection or inner join) shows only monitors with every one of them. For example, pick *Cabin* and *Camera* with **All** to see just the cameras at the cabin.
- **Tag one monitor:** use the Tags field in its settings, or **+ Add tags** in its details panel in the Falls. When you add a tag to a monitor that has dependents, you can also add it to everything downstream (handy for tagging a whole site).
- **Tag many:** select monitors in the Falls or the list (see above). The selection bar shows every tag: ✓ means all selected monitors have it (click to remove it), `2/5` means some do and `+` means none do (click to add it). Tick **Include downstream** to apply to everything below the selected monitors as well.
- **Manage:** the **Tags** page lets you create, rename, recolour and delete tags. Deleting a tag only removes the label; monitors are not affected.

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

## Import and export (CSV)

**Settings → Import & export monitors** exports every monitor to a CSV file and imports monitors from one. Use it to move to a new install, to edit many monitors at once in a spreadsheet, or to set up a batch of monitors from the blank template or the example file.

- Exports and imports use the same columns, so an export imports as it is. The hierarchy, settings, tags, icons and notification choices come along. Notification channels don't, because they hold secrets: create them on the new install first, with the same names.
- When a name already exists, you choose: add a second monitor, update the existing one, or skip the row.
- Choosing a file only checks it and shows what would change. Nothing is saved until you press **Import**, and a file with any error imports nothing.

The Settings page has a column reference. The [full guide](https://github.com/big-barlowe/WaterfallAlert/blob/main/docs/csv.md) covers every column and value, with examples.

## Data

Everything is stored in SQLite at `/data/waterfall.db` and is included in Home Assistant backups. Heartbeats older than the retention period (Settings, default 90 days) are pruned every 6 hours.
