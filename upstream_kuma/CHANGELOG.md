# Changelog

## 0.17.2

- **The Falls flows at every zoom**, however many monitors are on screen. Before, the water stopped once more than 300 streams were in view.
- **A much lighter Falls, stress-tested to over 4,000 monitors.** On 413 monitors the browser does a third to a half of the work it did; with 2,000 it stays at 60 frames a second, panning and zooming, and with 4,000 close to it. What moves (the water and foam, drawn on the GPU, and the ripples and pulses) is drawn on canvases instead of in the diagram, and the diagram is moved as one picture rather than redrawn on every frame of a pan. Streams and cards out of view aren't drawn at all (cards keep an outline, so you can still Tab to them), and the warbling source is drawn on its own.
- **Fit** and bringing a monitor into view glide with everything in step.
- **The list keeps up**: with hundreds of monitors, the update every few seconds rebuilt every row and froze the page for a moment; now only the rows that changed are touched. Formatting thousands of heartbeat tooltips is faster too, and the list's streams only flow where it's scrolled to.
- Browsers without WebGL2 draw the water on a regular canvas, as before.

## 0.17.1

- **On a monitor's full page, clicking another monitor in the list opens its full page** (as before 0.17.0), instead of jumping to the Falls. Elsewhere, a click still traces it in the Falls with its details open.

## 0.17.0

- **Rings is the default layout** of the Falls (the tree is one click away, top-right). A layout you picked before is kept.
- **Trace from the source.** Click the blue pool at the top (or centre) of the Falls: everything stays, and each monitor gets a little smaller with each step away from the source, just like tracing a monitor. Click it again or use **Show all** to go back.
- **The list's lines are streams now**, drawn like the Falls': a soft bed with flowing water and foam, red dashes below a monitor that's down, grey below one that's paused or blocked.
- **A more compact list.** Less indentation and tighter rows, and the list starts 380px wide so the full heartbeats and uptime fit; a width you dragged it to is kept (double-click the handle for the new default). With room, each monitor shows its last 10 heartbeats and its uptime; drag the list narrower and the heartbeats get shorter (7, then 4 beats, with the uptime in their tooltip) and finally become a status dot, so names keep their room.
- **The valve** (left of the search box) turns the list's hierarchy off: closed, it lists every monitor alphabetically, like search results, and the streams stop. Open it again for the hierarchy. Your choice is remembered.
- **Clicking a monitor in the list traces it in the Falls** with its details panel open, instead of opening its page (**Full details →** in the panel still does). Its row stays highlighted.
- **The details panel's buttons** (*Check now*, *Edit*, *Full details*) sit near the top, under the status, so a monitor with a long *Depends on* or *Feeds* list doesn't push them out of reach.
- **Fixed:** in the rings layout, tracing a monitor that branches straight away (a core router with nothing above it, say) could draw one of its children over the source.
- **Moving monitors in the list needs Edit.** Dragging a monitor's icon or name could still move it onto another monitor outside Edit mode; now only Edit mode moves anything, and **Move…** for selected monitors is there too.

## 0.16.1

- **A filter keeps your trace.** Filtering while you trace a monitor no longer jumps elsewhere when that monitor doesn't match: it stays (faded, with the monitors above it) and shows nothing below it, and the bar says how many monitors downstream match the filter. It drops out once you leave the trace, as it would if you'd filtered the whole view.

## 0.16.0

- **New add-on id, image and repository.** Everything that still said *waterfall* now says *upstream-kuma*: the repository is `github.com/big-barlowe/upstream-kuma`, the add-on's id is `upstream_kuma`, and the Docker image is `ghcr.io/big-barlowe/upstream-kuma`.
- **Home Assistant:** this is a new add-on, so it starts empty. To move your monitors, use **Export all monitors (CSV)** on the old one's Settings page, add the repository again with the new address, install *Upstream Kuma* and import the file there. Notification channels and rules aren't in the CSV, so set those up again. Then uninstall the old add-on.
- **Docker:** change the image in your compose file to `ghcr.io/big-barlowe/upstream-kuma`. Keep the same data folder: the database (`waterfall.db`, now `upstream-kuma.db`) is renamed on first start, so nothing is lost.
- Browser preferences (layout, filters, sizes) start over once, since their keys are renamed.

## 0.15.0

- **BlueHole is now Upstream Kuma.** New name and header (with its streams flowing like the Falls', including the ones running between the letters). The sidebar entry in Home Assistant is now *Upstream Kuma*; the logo and the Falls' source are unchanged.
- Updating keeps everything: the add-on's id, the Docker image (`ghcr.io/big-barlowe/waterfall-alert`) and the repository address are unchanged, so it updates in place.

## 0.14.0

- **Waterfall Alert is now BlueHole.** New name, logo (the add-on icon in Home Assistant and the browser tab icon) and header, with the stream in the header flowing like the streams in the Falls. The sidebar entry in Home Assistant is now *BlueHole*.
- **The Falls' source is the blue hole**: the dot everything flows from is now the BlueHole node, whose rim and water warble like the edge of a pool.
- Updating keeps everything: the add-on's id, the Docker image (`ghcr.io/big-barlowe/waterfall-alert`) and the repository address are unchanged, so it updates in place.

## 0.13.0

- **Pick a value from All data.** Every row of a monitor's *All data* has **+ Problem**: choose the values that mean trouble (named from the MIB, with the value it has now underlined) or a number to compare with, and add it as a reading to a problem definition, or start a new definition from it with the monitor's tags filled in.
- A monitor that a definition **can't read** gets **Pick a value** (on the definition's card and the monitor's *Monitored data*), which opens its *All data* with a banner saying what you're looking for, so an unusual UPS is one click away from being covered.
- A reading can be kept to **devices of one model** (`sysObjectID`) or **certain monitors**, for when makes disagree about what a value means.
- **Wording:** what you set up on the Notifications page is now a **problem definition**; a **problem** is one that's happening (open on a monitor). Buttons, headings and the docs follow.

## 0.12.1

- **Monitored data** on a monitor's page: every problem that reads a value from it, with the reading it answered (and the OID's name), the value now, what opens the problem, and whether it's open, OK or can't be read.

## 0.12.0

- **SNMP value problems.** Besides a monitor going down, a problem can now watch a value on the SNMP monitors with certain tags: **+ Add problem** on the Notifications page. Start from a ready-made one (*UPS on battery*, *UPS battery low*, *UPS on bypass*, *CPU busy*, *Disk almost full*, *Memory almost full*) or a blank one. A problem has several **readings**, since makes report the same thing in different places, and each monitor uses the first one it answers. The UPS ones read the standard UPS-MIB and APC's, Eaton's and CyberPower's own values, so one problem covers a mixed fleet tagged *UPS*. Values are listed by name from the MIB library.
- A problem can **open after N checks in a row**, **list everything downstream in its alert** (without marking any of it down), and send a resolved alert when it clears. Its card shows what it watches, what's open, and which tagged monitors **can't be read**.
- **Severity**: problems are *Info*, *Warning* or *Severe* (Monitor down is always severe). A warning makes the monitor's card pulse yellow in the Falls and marks it in the list; severe pulses red. Rules can alert on *warning or worse* or *any severe problem*, and ntfy, Discord, Pushover and Gotify send severe problems at the same priority as a monitor going down.
- **Unresolved** on the Alerts page: every monitor that's down and every open problem, with its value and how long it's been open, filterable by severity and by tag.
- The webhook payload has a `problem` field, and alert kinds `problem` and `resolved`.

## 0.11.0

- **Notification rules.** Alerts are now set up on the **Notifications** page instead of with checkboxes on every monitor. Each rule reads *Alert* [channels] *when* [problems] *for* [tags], and you pick the tags with the same pills (any/all) and **Advanced** expressions as the tag filter. Rules are listed as a table, one row each, with edit and delete icons at the end of every row; edits only apply when you press **Save**. A rule can also fire when the fault is upstream of its tagged monitors, so a *Critical* rule hears about the switch that took a critical server down.
- **Problems.** What a rule alerts about is now an object of its own. There is one for now, the built-in **Monitor down** (alert, reminders and resolved alert), which you can rename and whose resolved alerts you can turn off.
- **Channels** are listed under the rules, each with how many rules send to it. A new channel can start with a rule that sends it everything. *Default for new monitors* is gone, since rules cover new monitors by their tags.
- The monitor form shows where that monitor's alerts go, and updates as you change its tags. Deleting a tag warns when rules use it.
- **Upgrading keeps your alerts going where they went.** A channel every monitor used becomes a rule for all monitors. A channel only some used gets a tag on those monitors (*Alerts: Email*) and a rule for it.
- CSV: the `notifications` column is gone. Importing an older file with it still works; the column is ignored with a warning.

## 0.10.0

- **SNMP values named from MIBs.** About 70 standard MIBs are built in, so **All data** names everything standard and shows values the way the MIB defines them: *up* instead of `1`, *41.5 degrees C*, *8022576 kB*, MAC addresses, dates, and the names of OID values (*hrStorageRam*). Click a name for its description, MIB, type, units and access.
- **MIB library.** Add your devices' own MIBs under **Settings → MIB library**, or with **Add MIB files…** in **All data**. They apply to every SNMP monitor, and the library says when a MIB needs another one it imports. Values on the Falls card and the monitor's page pick up units and names too.
- **Finding a MIB.** All data lists where the values it can't name are, with links to look them up on oidref.com and Observium's MIB browser.

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
