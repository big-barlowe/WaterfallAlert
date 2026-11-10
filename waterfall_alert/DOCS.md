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
3. The down monitor sends **one alert** to the channels its notification rules pick (see [Notifications](#notifications)). The subject is `Alert: <name> is unreachable` (ping/TCP/DNS) or `Alert: <name> is down`, and the body lists every monitor that is now blocked beneath it.
4. When it recovers you get `Resolved: <name> is back up`, and the monitors directly beneath it are re-checked immediately. Each of those then re-checks its own children, so recovery flows down one level at a time.

After a restart, monitors that were already down don't alert again.

### Multiple parents

A monitor can have several parents. With more than one parent, choose one of:

- **Blocked if any parent is down** (default): it depends on all of them, e.g. an app that needs both its host and its database.
- **Blocked only if every parent is down**: redundant paths, e.g. a service reachable over either of two WAN links.

### Groups

A *group* is a plain folder. It has no check of its own and never blocks what's inside it. It shows the worst status of its contents.

## Arranging monitors

The monitor list is on the left. To give it more room:

- **Resize it** by dragging the gap between the list and the rest of the page. Double-click the gap to reset the width; with the gap focused, the arrow keys resize it too. The width is remembered.
- **Scroll sideways** when names don't fit: names are never cut short, so a narrow list scrolls horizontally.
- **Pop it out** with the button next to **Edit** to fill the window. The button again, or <kbd>Esc</kbd>, puts it back. Opening a monitor also puts it back.

- **Edit button** (above the monitor list): drag a monitor onto another to move it underneath. Hold <kbd>Alt</kbd>/<kbd>⌥</kbd> while dropping to **add** that monitor as an extra parent instead of moving. Drop it on *Drop here to move to the top level* to make it top level. The row buttons are: **+** (add a monitor beneath), **⇅** (move, which also works on touch screens), **✎** (settings) and **⨯** (detach from this parent).
- **Move several at once:** shift-click (or ctrl/⌘-click) monitors in the list to select them, or select them in the Falls. Then drag any selected row in Edit mode, or press **Move…** in the selection box at the top of the list, and they all move together. A selected monitor whose parent is also selected stays under that parent, so whole branches keep their shape. A monitor selected in the list moves away from the parent it was listed under; one selected in the Falls has all of its parents replaced (unless you choose to keep them).
- **Monitor settings → Hierarchy**: the *Parent monitors* and *Dependent monitors* lists. They stay in sync: adding a parent here lists this monitor as that parent's dependent. Any choice that would create a loop is hidden.

## The Falls

The dashboard diagram shows the whole hierarchy as streams: water flows from healthy monitors, runs dry below a monitor that is down, and goes still below blocked or paused ones.

It works like a map:

- **Move around** by dragging. On a touch screen, drag with one finger.
- **Pop it out** with the button next to **Select** to fill the window with the diagram. The button again, or <kbd>Esc</kbd> once nothing is traced or selected, puts it back.
- **Make it taller or shorter** by dragging the gap between the Falls and **Recent events**. Double-click the gap to go back to sizing it automatically. The height is remembered.
- **Tree or rings:** the two buttons in the top-right corner switch the layout. **Tree** is a waterfall from top to bottom. **Rings** puts the first monitor that branches out (a core switch, say) in the middle, with the chain above it (WAN, firewall…) feeding in from the top, and spreads everything else around it with the streams winding outward. Several sites or closets each get their own wedge instead of sharing one very wide row, and devices with nothing below them are stacked a few rows deep around their switch. Distances are flexible, so the shape stays compact rather than perfectly round. A small diagram, such as a traced monitor, opens downward as a fan. Your choice is remembered.
- **Zoom** with <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + scroll, by pinching on a trackpad or touch screen, or with the **−** and **+** buttons in the corner. Click the percentage for actual size, and the corners button to fit everything in again. A plain scroll still scrolls the page. Zoomed out below 30%, each monitor shows just its icon and name; the status line and tags come back as you zoom in.
- The diagram starts out fitted to the space, and fits again when you trace a monitor or change the tag filter. When you leave a traced view, the monitor you traced stays where it is and the rest of the diagram fills in around it. Your zoom and position are otherwise kept, even when you open a monitor and come back.

- **Click a monitor** to trace it: the diagram shows only what it depends on (upstream) and what depends on it (downstream). Downstream monitors get a little smaller with each step away from it, so the nearest stand out. Click it again, press <kbd>Esc</kbd>, click empty space or use **Show all** to see everything. **Trace in Falls** on a monitor's page does the same.
- **The expand button** (top-right corner of a monitor) opens a details panel with its status, response times, heartbeats and its full upstream and downstream lists. Click a monitor in those lists to trace that one instead.
- **Select monitors** to tag or move several at once: shift-click (or ctrl/⌘-click) them, or hold <kbd>Shift</kbd> and drag a box around them. <kbd>Alt</kbd>/<kbd>⌥</kbd>-drag removes from the selection instead. On a touch screen, tap **Select** first; one finger then draws the box and two fingers move and zoom. The selection is shared with the monitor list. See [Tags](#tags) and [Arranging monitors](#arranging-monitors).

## Tags

Tags are coloured labels for grouping monitors across the hierarchy, for example by site, room or owner. They show as small pills along the bottom of each monitor in the Falls and as coloured dots in the monitor list.

- **Filter:** click tags at the top of the sidebar to show only monitors with those tags, in both the list and the Falls. Monitors above a match stay visible, faded, so you can still see what the matches depend on.
- **Any or all:** with a filter on, the two Venn-diagram buttons next to the tags choose how several tags combine. **Any** (both circles shaded, a union or full outer join) shows monitors with at least one of the tags. **All** (only the overlap shaded, an intersection or inner join) shows only monitors with every one of them. For example, pick *Cabin* and *Camera* with **All** to see just the cameras at the cabin.
- **Advanced filter:** for anything the pills can't express, click **Advanced** and build a filter, by clicking the operator buttons and tags under the box or by typing:

  | | |
  |---|---|
  | `Switch & Home` | both tags (`and` works too) |
  | `Home \| Cabin` | either tag (`or` or `,` work too) |
  | `!Retired` | not that tag (`not` works too) |
  | `Switch & (Home \| Cabin)` | parentheses group; `&` comes before `\|`, so this is the same as `Switch & Home \| Switch & Cabin` |

  Tag names aren't case-sensitive and can contain spaces (`Server room & Camera`). Put a name in double quotes if it contains one of the symbols, or is one of the words *and*, *or* or *not*. Clicking a tag or an operator inserts it at the cursor, so clicking *Wifi*, **&**, **(**, *Cabin*, **\|**, *Home* gives `Wifi & (Cabin | Home`; a bracket left open at the end is closed for you. The box says how many monitors match as you type, and **Filter** (or <kbd>Enter</kbd>) applies it. While it is on, the filter replaces the tag pills; click it to edit it, or × to clear it.
- **From the Falls:** any filter in use also shows next to **The Falls** title, with how many monitors match. Click it (or **+ Filter** when there is none) for the same controls as the list: the tag pills with **Any**/**All**, and **Advanced** for a filter expression.
- **Tag one monitor:** use the Tags field in its settings, or **+ Add tags** in its details panel in the Falls. When you add a tag to a monitor that has dependents, you can also add it to everything downstream (handy for tagging a whole site).
- **Tag many:** select monitors in the Falls or the list (see above). The selection bar shows every tag: ✓ means all selected monitors have it (click to remove it), `2/5` means some do and `+` means none do (click to add it). Tick **Include downstream** to apply to everything below the selected monitors as well. It starts unticked for every new selection.
- **Manage:** the **Tags** page lets you create, rename, recolour and delete tags. Deleting a tag only removes the label; monitors are not affected.
- **Default icon:** on the **Tags** page, **+ Icon** gives a tag an icon (built-in, emoji, image URL or upload). Every monitor with that tag whose icon is set to *Automatic* shows it, e.g. a switch icon for everything tagged *Switch*. See [Icons](#icons).

## Icons

Choose a monitor's icon under **Settings → General → Icon**:

| Option | |
|---|---|
| Automatic (default) | The icon of the monitor's tags, if one of them has one (the first in alphabetical order). Otherwise HTTP monitors use the website's favicon and Minecraft monitors the server icon, groups show a folder, and other types have no icon. |
| Built-in | A set of simple icons for routers, servers, NAS boxes, databases, containers and more. |
| Emoji | Any emoji. |
| Image URL | Any image, e.g. from the [dashboard-icons](https://github.com/homarr-labs/dashboard-icons) project. |
| Upload | PNG, JPEG, GIF, WebP, SVG or ICO, shrunk to 128 px. |
| None | No icon. |

Favicons and image URLs are downloaded by the add-on and stored in its database, so the browser never has to reach the site (useful when Home Assistant is served over HTTPS and the site is plain HTTP, or only reachable from the add-on). The add-on checks for a favicon in the page's `<link rel="icon">` tags, then the site's home page, then `/favicon.ico`. Icons are refreshed weekly; saving the monitor fetches its icon again straight away.

## Notifications

The **Notifications** page has three parts: rules, channels and problems.

**Notification rules** decide who hears about what. They're listed as a table, one rule per row, which reads like a sentence: *Alert* [channels] *when* [problems] *for* [tags]. A cell too long for its column fades out at the edge; hover it to see everything. **+ Add rule** starts a new one, and the pencil at the end of a row opens that rule (the bin deletes it): click a cell to change it, then **Save** (or **Add**, for a new rule). Nothing changes until you save, and **×** drops the edits.

- **Channels**: one or more of your channels.
- **Problems**: *any problem*, or the ones you pick. For now there is one, *Monitor down* (see below).
- **Tags**: *all monitors*, or the monitors with any (or all) of the tag pills you pick, just like the tag filter. **Advanced** takes an expression such as `Camera & !Cabin`, and renaming a tag updates the rules that use it.
- **Upstream** (the checkbox column): a rule for some tags normally fires when a tagged monitor is the one at fault. With this ticked it also fires when an untagged monitor takes tagged ones down with it (say, the switch in front of your *Critical* NAS), and sends that alert, which lists them. It's on for new rules.

An alert goes to every channel of every rule that matches it, once per channel. Alerts are still raised only for the **monitor that is actually down**, the top of the affected branch. A monitor's edit form shows where its alerts currently go. A rule that can't send anything (no channel, or its tags were deleted) gets a red edge; hover it to see why. With no rules, nothing is sent.

**Channels** are where alerts are delivered:

- **Home Assistant**: any `notify.*` service (e.g. `notify.mobile_app_pixel`), or `persistent_notification.create`. This works with no setup when running as an add-on.
- **ntfy, Discord, Slack, Telegram, Pushover, Gotify, Webhook, Email (SMTP)**: fill in the fields and use **Send test**.

The webhook channel POSTs JSON: `{ kind, title, message, time, monitor, affected: [{ id, name, depth }] }`.

**Problems** are what a rule can alert about. There is one so far, built in:

- **Monitor down**: a monitor fails its check (after its retries) while everything it depends on is up. One alert names it and lists every monitor cut off beneath it, reminders follow if the monitor has a reminder interval, and a resolved alert is sent when it comes back up. You can rename it, and turn the resolved alerts off.

The **Alerts** page lists every alert that was sent and which channels delivered it.

**Upgrading from 0.10 or earlier**, where each monitor had channel checkboxes, turns those choices into rules so the same alerts keep going to the same places. A channel every monitor used gets a rule for all monitors. A channel only some monitors used gets a tag on those monitors, named like *Alerts: Email*, and a rule for that tag. Tidy them up as you like.

## Monitor types

| Type | Checks |
|---|---|
| HTTP(S) | Status code in the accepted list (default `200-299`), optionally a keyword in the body. Follows redirects. |
| TCP port | A TCP connection opens. |
| Ping | ICMP echo reply. |
| DNS | A record resolves (optionally against a specific resolver / expected value). SRV records read as `target:port`. |
| HA entity | The entity isn't `unavailable`/`unknown`, or matches the expected state(s). |
| Minecraft | A Java Edition server answers a status request (the one the multiplayer server list uses). Enter the address you'd type into the game: its `_minecraft._tcp` SRV record is followed, or set a port to skip that. Shows players online and the version. Bedrock isn't supported. |
| SNMP | A device answers an SNMP request for its system information (v1 or v2c, with its read-only community; v3 isn't supported yet). Every check also collects what it advertises, shown on the monitor's page and in its details panel in the Falls: name, description, location, contact and uptime; every interface with its status, speed, traffic in and out (worked out between checks) and errors; CPU, memory and disks where the device reports them (servers and NAS boxes usually do, switches often don't); and any extra values you list as `Label = OID`. **All data** on the monitor's page reads everything the device reports, searchable and named from MIBs (see [SNMP MIBs](#snmp-mibs)), so values read as *up*, *41.5 degrees C* or *00:1a:2b:3c:4d:05* instead of bare numbers; **+ Page** adds a value to the monitor's page and **+ Card** to its card in the Falls. **Customize** hides what you don't need from the page and picks up to two values for the Falls card, e.g. *CPU 13% · Mem 18%* (by default the card shows the device name and how many links are up). Only whether it answers decides up or down for now. |
| Push | Something calls `/api/push/<token>` at least once per interval. Add `?status=down&msg=…` to report a failure, `&ping=123` to record a time. |
| Group | Nothing; it's a folder. |

### SNMP MIBs

SNMP itself only sends numbers: an OID and a value. What an OID is called, its units, and what a number like `2` means (*down*) come from MIB files. About 70 standard MIBs are built in: interfaces, IP, TCP/UDP, host resources (CPU, memory, disks, processes), bridges and VLANs, LLDP neighbours, entity (hardware and sensors), PoE, UPS, printers, and net-snmp's own. So anything standard has a name.

A device's own values (under `1.3.6.1.4.1.<vendor>`) need the maker's MIB. When **All data** finds values it can't name, it lists where they are, with links to look them up on [oidref.com](https://oidref.com) (which shows the MIB that defines them, with downloads) and [Observium's MIB browser](https://mibs.observium.org). Download the MIB from the maker or the lookup site and add it with **Add MIB files…** (there, or under **Settings → MIB library**). It applies to every SNMP monitor.

A vendor MIB usually imports others from the same vendor (often `<VENDOR>-SMI` or `<VENDOR>-TC`). The library says what is still needed, e.g. *Needs CISCO-SMI*; add those too. Uploading a MIB with the same name as a built-in one replaces it. Lookups only happen when you click a link; the add-on never sends anything to these sites itself.

## Add-on options

| Option | Default | |
|---|---|---|
| `log_level` | `info` | `debug`, `info`, `warning` or `error`. |
| `allow_direct_access` | `false` | Allow the web UI on the add-on's mapped port without going through Home Assistant. Leave this off unless you have your own authentication in front of it: the UI itself has no login. |

### Push monitors and the network port

The UI is served through Home Assistant ingress (sidebar → **Waterfall**), which handles authentication. Push monitors need to be reachable by whatever sends the push, so map a host port under **Network**. With `allow_direct_access: false` (the default), only `/api/push/…` is reachable on that port.

## Import and export (CSV)

**Settings → Import & export monitors** exports every monitor to a CSV file and imports monitors from one. Use it to move to a new install, to edit many monitors at once in a spreadsheet, or to set up a batch of monitors from the blank template or the example file.

- Exports and imports use the same columns, so an export imports as it is. The hierarchy, settings, tags and icons come along. Notification channels and rules don't (channels hold secrets): set them up on the new install. Rules pick monitors by tag, so they work again once they exist.
- When a name already exists, you choose: add a second monitor, update the existing one, or skip the row.
- Choosing a file only checks it and shows what would change. Nothing is saved until you press **Import**, and a file with any error imports nothing.

The Settings page has a column reference. The [full guide](https://github.com/big-barlowe/WaterfallAlert/blob/main/docs/csv.md) covers every column and value, with examples.

## Data

Everything is stored in SQLite at `/data/waterfall.db` and is included in Home Assistant backups. Heartbeats older than the retention period (Settings, default 90 days) are pruned every 6 hours.
