# Changelog

## 0.9.0

- **SNMP monitors (v1/v2c).** Up when the device answers. Every check also collects what it advertises: system name, description, location, contact and uptime; every interface with status, speed, traffic in and out and errors; CPU, memory and disks where offered; and extra values you list as `Label = OID`. It all shows on the monitor's page, with a summary in its details panel in the Falls. SNMPv3 and alerting on these values are still to come.
- **All SNMP data.** A button on the monitor's page reads everything the device reports, live and searchable, with readable names for common objects. Add any value to the page (**+ Page**) or to the monitor's card in the Falls (**+ Card**).
- **Customize.** Hide device facts, interfaces, resources or whole sections you don't need, and pick up to two values for the Falls card, like *CPU 13% · Mem 18%* or an interface's traffic, the way Minecraft cards show players.
- CSV import and export carry the SNMP settings (`snmp_version`, `community`, `snmp_oids`, `snmp_hide`, `snmp_card`).

## 0.8.1

- **Much more compact rings layout.** Rings now centre on the first monitor that branches out (e.g. the core switch), with the chain above it as a short trunk, instead of on the top-level monitor. Devices are stacked a few rows deep around their switch, and each monitor sits only as far out as it needs to. A network with a core switch, 14 closets and about 200 devices went from roughly 13,000 px square to about 3,200 × 2,300, so it fits on screen when zoomed out.
- **Traced monitors stand out.** While tracing a monitor, everything downstream of it gets a little smaller with each step away (down to 65%). In the rings layout the smaller cards also pack tighter.
- **Smooth with hundreds of monitors.** Streams no longer use a blur filter (their soft bed is the glow), and only what's on screen animates. Zoomed out below 30%, monitors show just their icon and name. On the 200-monitor test network the Falls went from about 11 to 60 frames per second.

## 0.8.0

- **Tag icons.** Give a tag a default icon on the **Tags** page (built-in, emoji, image URL or upload). Monitors with that tag that are left on the *Automatic* icon show it, e.g. a switch icon for everything tagged *Switch*. A monitor's own icon still wins.
- **Advanced tag filter.** **Advanced** next to the tag pills takes a filter like `Switch & (Home | Cabin)` or `Camera & !Retired`, with `&`/and, `|`/or, `!`/not and parentheses. Type it, or click the operator buttons and tags to build it. It checks as you type and shows how many monitors match. **+ Filter** next to the Falls title opens the same filter controls as the list (tag pills, with **Advanced** for an expression), and clicking a filter shown there edits it.
- **Rings layout for the Falls.** The buttons in the diagram's top-right corner switch between the tree and a concentric layout: levels on circles around the source, streams winding outward like rivers. Wide, multi-site setups fit on screen far better. The choice is remembered.
- **Resize the Falls.** Drag the gap between the Falls and **Recent events** to make the diagram taller or shorter; double-click it for automatic again.
- **Include downstream** in the Falls selection bar now starts unticked for every new selection, instead of remembering the last choice.

## 0.7.0

- **Resizable monitor list.** Drag the gap between the list and the page to make it wider or narrower (double-click to reset). The width is remembered.
- The monitor list no longer cuts names short. When it is too narrow, it scrolls sideways. The search box, tag filter and selection stay in place above it while it scrolls.
- **Pop out** the monitor list or the Falls to fill the window, with the new button beside **Edit** and beside **Select**. <kbd>Esc</kbd> puts it back.

## 0.6.1

- Leaving a traced view in the Falls (clicking empty space, <kbd>Esc</kbd> or **Show all**) keeps the monitor you traced where it is, at the same zoom, instead of jumping back to the overview. The fit button still shows everything.

## 0.6.0

- **The Falls is now a map.** Drag to move around, and zoom with ctrl/⌘ + scroll, a pinch, or the zoom buttons. It fits itself to the space when you trace a monitor or change the filter, and otherwise keeps your zoom and position.
- Drawing a selection box in the Falls now needs <kbd>Shift</kbd> held (plain dragging moves the map). On touch screens, **Select** mode still draws boxes with one finger.
- **Tag filter: any or all.** With several tags in the filter, Venn-diagram buttons choose between monitors with *any* of them (union) and only those with *all* of them (intersection), e.g. *Cabin* + *Camera* for the cabin's cameras.
- **Move several monitors at once.** Shift-click (or ctrl/⌘-click) monitors in the list to select them, then drag one in Edit mode or use **Move…**. The selection is shared with the Falls, so a box selection there can be moved too. Selected branches move as a whole.

## 0.5.1

- Running without Home Assistant: a ready-made Docker image, `ghcr.io/big-barlowe/waterfall-alert` (amd64 and arm64), a `compose.yaml` and a [Docker guide](https://github.com/big-barlowe/WaterfallAlert/blob/main/docs/docker.md).
- Outside Home Assistant, a push monitor's edit page shows its real push URL instead of the add-on placeholder.

## 0.5.0

- **Import and export monitors as CSV** under **Settings → Import & export monitors**. Exports and imports use the same columns, so an export imports as it is into another install: the hierarchy, settings, tags (with colours), icons (uploaded ones included) and notification choices all come along.
- Import modes for names that already exist: add as new, update (bulk-edit in a spreadsheet and import again) or skip.
- Choosing a file checks it first and shows what would change, with any problems by line number. Imports are all-or-nothing.
- A blank template, an example file, a column reference on the Settings page, and a [full guide](https://github.com/big-barlowe/WaterfallAlert/blob/main/docs/csv.md).
- Tag names can no longer contain `|`, which separates list items in CSV files.

## 0.4.0

- **Tags.** Give monitors coloured tags, shown as small pills along the bottom of each monitor in the Falls, as coloured dots in the monitor list, and on the monitor page. Manage them on the new **Tags** page (rename, recolour, delete).
- Filter the monitor list and the Falls by tag with the tag chips at the top of the sidebar. Monitors above a match stay visible (faded) so the hierarchy still makes sense.
- Select several monitors in the Falls to tag them at once: shift-click (or ctrl/⌘-click), drag a box over empty space, or use the **Select** button on touch screens. The selection bar adds or removes tags, optionally including everything downstream.
- The monitor form has a Tags field, with an option to add new tags to everything downstream too.

## 0.3.0

- New **Minecraft** monitor type (Java Edition). It follows the server's SRV record like the game does and asks the server for its status, so it is only up when the server actually answers, not just when the port is open. Shows players online and the version, and uses the server's own icon automatically.
- DNS monitors can check SRV records.

## 0.2.0

- Monitor icons, shown in the monitor list, the falls diagram and the monitor page. HTTP monitors use the website's favicon automatically and groups show a folder. You can also pick a built-in icon, an emoji, an image URL or upload an image. Images are fetched and cached by the add-on, so the browser never has to reach the site.
- The Falls: click a monitor to trace it, showing only what it depends on and what depends on it. Click it again, press Esc or use **Show all** to go back. The traced view is in the URL, so it can be bookmarked.
- The Falls: the expand button on a monitor opens a details panel with its status, response times, heartbeats and its full upstream and downstream lists.
- Monitor page: **Trace in Falls** button.
- Fixed straight vertical streams in the falls diagram losing their glow.

## 0.1.0

- First release: hierarchical monitors with multiple parents, root-cause alerting with downstream summaries, recovery cascade, drag-and-drop hierarchy editing, heartbeat history and charts, HTTP/TCP/ping/DNS/HA entity/push/group monitors, and nine notification providers.
