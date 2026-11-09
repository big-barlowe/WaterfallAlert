# CLAUDE.md

Waterfall Alert is a Home Assistant add-on for hierarchical uptime monitoring (Uptime Kuma-style, but monitors form a DAG and a failure sends one root-cause alert listing everything downstream).

## Layout

```
repository.yaml              HA add-on repository manifest (this repo is the repository)
compose.yaml                 standalone deployment using the ghcr.io image; guide in docs/docker.md
waterfall_alert/             the add-on (Supervisor build context)
  config.yaml                add-on manifest: version, ingress, options/schema
  Dockerfile                 node:22-alpine, copies app/
  DOCS.md / CHANGELOG.md     shown in the HA add-on UI
  app/
    src/server.js            node:http server, static files, ingress access control
    src/api.js               all REST routes + edge/cycle checks
    src/validate.js          HttpError, normalizeMonitor/normalizeTag (shared by api.js and transfer.js)
    src/transfer.js          CSV export/import of monitors (CSV_COLUMNS is the single column definition)
    src/csv.js               RFC 4180 parse/write
    src/snmp.js              SNMP v1/v2c client (BER, GET, GETBULK/GETNEXT walks over UDP); no dependency
    src/engine.js            scheduler + hierarchy logic (the core; read this first)
    src/graph.js             DAG helpers: ancestors/descendants, levels, cycles, subtree
    src/db.js                node:sqlite Store, migrations (PRAGMA user_version)
    src/checkers/            one function per monitor type -> { ok, ping?, msg, data? }; snmp.js collects interfaces/resources
    src/notifier.js          notification providers + their form field definitions
    src/icons.js             icon specs, favicon discovery, IconCache (cached images in the `icons` table)
    src/status.js            heartbeat status codes
    public/                  vanilla-JS SPA, no build step
      js/app.js              router, polling, sidebar tree (drag/drop), views
      js/flow.js             SVG "falls" diagram, focus/lineage view, FLIP animation
      js/icons.js            built-in glyphs, iconEl() (HTML) / iconSvg() (inside the diagram)
      js/tags.js             tag pill, colour picker, "new tag" dialog, tagIconView()
      js/snmp.js             SNMP snapshot cache, Falls summary, monitor-page sections (customize mode), All data browser
      js/snmp-names.js       readable names and groups for common OIDs (browser only)
      js/filter.js           tag filter expressions (parseTagExpr); no imports, so test/filter.test.js loads it under Node
      js/chart.js            heartbeat bar + response-time chart
      js/forms.js            monitor + notification forms
      js/util.js             api(), h()/svg()/fill() DOM helpers, formatters
    test/engine.test.js      node:test scenarios for the hierarchy logic
    test/filter.test.js      tag filter expressions: precedence, not, quoting, error messages
    test/icons.test.js       favicon discovery and icon cache, with a fake `request`
    test/minecraft.test.js   Server List Ping against a fake server, SRV resolution
    test/snmp.test.js        BER round trip, checker against a fake agent (v1/v2c, tooBig, community), rates, engine data
    test/move.test.js        bulk move route: ride-along subtrees, from-parent semantics, rollback
    test/tags.test.js        tag routes through createApi(), with a real Store and Engine
    test/transfer.test.js    CSV round trip into a fresh store, import modes, rollback on errors
docs/csv.md                  user guide for the CSV format (linked from the Settings page)
docs/docker.md               running without Home Assistant (Compose, backups, reverse proxy, networking)
```

## Commands

Run everything from `waterfall_alert/app`. Node may not be installed locally; Docker always works:

```sh
# tests
docker run --rm -v "$PWD":/app -w /app node:22-alpine sh -c 'npm install --no-audit --no-fund && npm test'

# run the real add-on image locally
docker build -t waterfall-alert:dev ..   # from waterfall_alert/app, context = waterfall_alert/
docker run -d --name wfa-dev -p 8099:8099 -e DATA_DIR=/tmp/data waterfall-alert:dev
docker cp public/. wfa-dev:/app/public/  # hot-swap frontend without losing data (static files are read per request)
```

With local Node ≥ 22.13: `npm install && npm start` / `npm test`.

To look at the UI: headless Chrome screenshots work (`--headless=new --virtual-time-budget=4000 --screenshot=…`). Its viewport never goes below 500px wide, so a `--window-size=400,…` shot is cropped, not reflowed.

## Hierarchy semantics (engine.js)

- Statuses: `DOWN=0, UP=1, PENDING=2, BLOCKED=4` (`status.js`). BLOCKED means "not checked because upstream is down".
- **Gate**: `gateState(id)` looks at the parents. `parentMode: 'all'` (default) is blocked if any parent is down; `'any'` is blocked only if all parents are down. Groups and paused monitors are *pass-through*: they inherit their own gate and never block on their own.
- **Check flow** (`#doCheck`): gate closed → record BLOCKED, no network call. Otherwise run the checker → retries (PENDING) → on confirmed failure, `#verifyUpstream` force-checks the parents first. If a parent is down the monitor becomes BLOCKED, if a parent is still retrying it stays PENDING, and only otherwise does it go DOWN, block its descendants, and send one alert listing them.
- **Recovery**: an UP after DOWN/BLOCKED triggers `#cascade`, which immediately checks the BLOCKED children; they cascade further, one level at a time.
- Alerts are dispatched to the **root-cause monitor's** channels only and logged in the `alerts` table.
- `check(id)` dedupes concurrent checks via `rt.inflight`. Fire-and-forget work goes through `#track()` so tests can `await engine.idle()`.
- The engine takes injectable `checkers`, `notify`, `now`, `schedule` and `cancel`, so tests use fake checkers, a fake clock and no timers.
- After any config change the API calls `engine.reload(changedIds)`, which rebuilds the graph and re-evaluates those monitors.

Edges are stored once (`monitor_edges(parent_id, child_id)`). "Dependents" are just the reverse view, which is why adding a parent automatically lists the monitor as that parent's dependent. Cycles are rejected in `api.js` (`applyEdges` → `Graph.hasCycle`), and the form hides options that would create one.

Moving goes through `moveMonitors()` in api.js (`POST api/monitors/move {moves: [{id, fromParentId}], toParentId, link}`; the single `api/monitors/:id/move` route uses it too). A missing `fromParentId` (picked in the Falls) replaces all parents; a monitor whose from-parent is also being moved is left alone ("along"), so subtrees keep their shape. All in one `store.tx`.

## Collected data (SNMP)

- A checker is called as `fn(monitor, { previous })` and may return `data` with its result. The engine stores it (`store.setMonitorData`, table `monitor_data`, one JSON row per monitor) after any check that returned it, and passes it back as `previous` next time; a failed check leaves the last snapshot. `PUT api/monitors/:id` clears it when the type or config changes.
- **Display settings** are config keys `oids`, `hide` (e.g. `fact:contact`, `if:<name>`, `res:<name>`, `section:<name>`) and `card` (≤ `CARD_MAX` keys: `name`, `uptime`, `ifs`, `cpu`, `memory`, `disk:<name>`, `if:<name>`, `value:<oid>`). They are `DISPLAY_KEYS`: changing them never clears the snapshot. `PUT api/monitors/:id/snmp-display` saves them and reloads the monitor, because the card text is the check's `msg` (`cardText()` in checkers/snmp.js), which `subline()` in flow.js shows for SNMP cards. `GET api/monitors/:id/snmp/walk?start=` returns a page of a live walk of the whole tree for the browser (`#/monitor/:id/snmp`).
- `GET api/monitors/:id/data` → `{ at, data, display }`. It is not in `/api/state` (too big); the frontend fetches it through `snmpSnapshot(id, lastCheck, onLoad)` in `public/js/snmp.js`, which refetches only when the monitor's `lastCheck` changes.
- The SNMP checker's uptime test is the system-group GET (half the timeout per try, one retry). Everything else (IF-MIB ifTable/ifXTable columns, HOST-RESOURCES CPU and storage, UCD ssCpuIdle as a CPU fallback, the `oids` config) is best effort within a deadline; failures go into `data.notes`. Rates come from `previous` (32-bit wrap handled, reboots and 64-bit resets skipped).

## Icons

- A monitor's `icon` column holds a spec: `''` automatic (favicon for HTTP, the status-reply icon for Minecraft, folder for groups), `none`, `builtin:<name>`, `emoji:<text>`, `url:<url>`, `upload`. Parsing and validation are in `src/icons.js`.
- `IconCache.sync(monitors, forceIds)` runs after every monitor create/update/delete and every 6h. It drops images nothing wants and fetches missing or stale ones in the background, then calls `engine.touch()` so the UI polls them in.
- `/api/state` replaces each monitor's spec with a render descriptor from `icons.describe()`: `{kind:'image', src}`, `{kind:'builtin', name}`, `{kind:'emoji', value}` or `null`. `GET api/monitors/:id` still returns the raw spec, which is what the form edits.
- Images are served from `api/monitors/:id/icon` with a sandboxing CSP, because SVGs come from arbitrary sites and the add-on shares Home Assistant's origin. Keep those headers. Types are sniffed from bytes (`sniffImage`), never from Content-Type.
- Built-in glyph keys are stored in the database, so never rename one in `public/js/icons.js`. Adding one is fine.
- **Tag icons**: `tags.icon` holds the same kind of spec (`''` = no default, never `none`); an uploaded one lives in `tags.icon_data` and is served from `api/tags/:id/icon`. A monitor whose own spec is `''` takes the first tag (name order) with an icon, ahead of favicons: `tagIconSpecs()` builds that map in `IconCache.sync()`, and `#spec(m)` is what `wanted()`/`describe()` use. A tag image URL is cached per monitor like any URL; a tag upload becomes the internal spec `tag:<id>@<version>`. So **anything that changes tag icons or which monitors carry a tag must call `iconsChanged()`** in api.js. The form's icon picker is `iconChooser()` in forms.js, shared with the tag icon dialog. Tag icons are not part of the CSV.

## Tags

- `tags(id, name, color)` (names unique, case-insensitive) and `monitor_tags`. Tags have nothing to do with checking; they are display and filtering only, so tag changes call `engine.touch()`, not `reload()`.
- `/api/state` carries `tags` (all of them) and each monitor's `tags` (ids). `POST api/tags/:id/apply {monitorIds, downstream, remove}` is the bulk path; monitor POST/PUT take `tagIds` and `tagsDownstream` (adds only the *newly added* tags to every descendant).
- Tag filter (`ui.tagFilter` and `ui.tagMatch` = `any`|`all`, or instead an expression in `ui.tagExpr`, all in localStorage; setting one clears the other): `filterView()` in app.js returns `match` (monitors with any/all of the selected tags) and `show` (match + all ancestors). Ancestors that don't match get `.context` and are drawn faded, in both the tree and the Falls.
- Tag colours are set per element with the `--tag` custom property and mixed with `color-mix()` in CSS. `h()` routes `--*` style keys through `style.setProperty`.

## CSV import & export (transfer.js)

- `CSV_COLUMNS` drives the export, the import, the template, and the column reference on the Settings page (`GET api/csv/columns`). Adding a monitor type or config field means adding its column there **and** to `docs/csv.md`.
- Export and import must stay symmetric: export → import into an empty store must reproduce the monitors (the round-trip test checks this). References use `key` (blank = name); exports fill `key` in only for shared names or names containing `|`.
- `importCsv` runs everything inside `store.tx` and throws a private `Rollback` on any error or for `dryRun`, so the preview is exactly what an import would do. Icon uploads are returned (`uploads`) and saved by the route only after commit, because `IconCache` keeps in-memory metadata.
- Missing column = keep (update) / default (new). Present but blank = default. Except: `parents`/`tags` blank = none, and `notifications` blank = default channels, `none` = none.
- `POST /api/csv/import` gets a 32 MB body limit (in server.js), since uploaded icons travel as data URLs.

## Falls diagram (flow.js)

- Two layouts, `treeLayout` and `ringLayout`, built on the same `structure()` (levels, primary parents, leaf slots). Both take `scaleOf(id)` (tracing: downstream monitors shrink by `SHRINK.step` per hop, down to `SHRINK.min`) and return per-card boxes `{x, y, w, h, s}` in `pos`, plus `{source, width, height, stream(from, to, seed)}`, plus `centre` for rings. A node draws at full size inside an outer `g` with `scale(s)`, so the FLIP deltas in `#animate` are divided by `k * s` and animate the size ratio too. Rings centre on the first node that branches (the chain above it is a vertical trunk), give leaves stacked staggered rows within their parent's wedge, map slots to angles (a downward fan until there are enough to fill a circle) and place nodes level by level, each just beyond its parent and pushed out along its ray until it clears everything placed (no global ring radii); `river()` draws streams in polar space with a meander, trimmed at the card edges. `setLayout()` / the corner toggle switch it, app.js keeps it in `ui.fallsLayout` (localStorage), and the mode is part of both the topology key and the fit key.
- `render(monitors, focusId, {selected, selectMode})`: with a focus, only `lineage()` (ancestors + descendants) is laid out. The structure is rebuilt only when the topology key changes (ids, names, edges, icons, tags, focus); `#paint` updates status, selection and `.context` classes in place so animations don't restart.
- Monitors passed in carry `tagList` (`[{name, color}]`) and `context`. When any shown node has tags, every node grows to `TAGGED_H` for a row of pills (widths measured on a canvas; overflow becomes `+N`).
- It is a map: the svg fills `.flow-map` and everything sits in `g.viewport`, positioned with a CSS transform from `view = {k, x, y, h, key, auto}`. app.js owns that object (`ui.flowView`) so zoom/position survive navigation. While `auto`, `#fit()` sizes the box and fits the diagram; it re-fits whenever `key` (focus + shown ids) changes, except when leaving a trace: then the previously focused node (`view.focus`) keeps its screen position and zoom. Pan/zoom set `auto = false`. Pointer coordinates go through `#point()` (manual inverse of the view), and the FLIP deltas are divided by `k`.
- Gestures (`#down/#move/#up`): one pointer pans, or with shift/ctrl/⌘/alt or in select mode draws a marquee (alt removes) → `onMarquee(ids)`; two pointers pinch. Wheel zooms only with ctrl/⌘ (trackpad pinch sends ctrlKey), otherwise the page scrolls and a hint shows. `touch-action: none` on the svg. A drag that started on a node still pans; the click that ends any drag is swallowed via `#swallowClick()`, which `#down` resets.
- Selection (`ui.selected`) is owned by app.js and shared with the sidebar tree (shift/ctrl/⌘-click rows). `ui.selFrom` remembers the parent of the tree row a monitor was picked under, for moves. `pruneSelection()` drops monitors that are gone or filtered out.
- The selection bar sits *below* the diagram and is sticky, so showing it never moves the nodes (it used to be above, and the jump made box-selecting a second time miss).
- On a rebuild, surviving nodes FLIP from their old screen position. They are positioned via the outer `g`'s `transform` attribute and animated via CSS transforms on the inner `.node-inner`, because a CSS transform on the outer one would override the attribute.
- Focus state lives in `ui.focus`/`ui.info` in app.js and is mirrored into the hash with `history.replaceState`. A real hash change would re-route and rebuild the diagram without the animation.
- **Performance** (it has to cope with hundreds of monitors): streams have no filter (a blur per animated stream, over the whole diagram, was most of every frame; the wide `.bed` stroke is the glow), and `#glow-box` is only for single elements. `#apply()` sets `lod-far` below `LOD.details` zoom (hides the subline, tags, sparkles; names and animation stay). `#cull()` (throttled) marks streams and nodes outside the view `.offscreen` so they don't animate (`#paint` must keep that class), and sets `.calm` (no animation) when more than `LOD.animate` streams are on screen. Measured on 200 monitors, animation at every zoom and while panning holds 60 fps once the filter is gone, so don't bring back zoom-based animation cut-offs or pausing during moves without measuring.

## Conventions

- **Layout.** `.layout` is a 3-column grid: list (`--side-w`, set by the `#side-resize` handle and kept in localStorage), handle, main. `.side`/`.main` have explicit `grid-column`s so nothing reflows when one is popped out. Pop-out (`setPopout('side'|'falls')` in app.js) adds `popout-*` body classes that make the panel `position: fixed`; it needs `align-self: stretch`, because Chrome applies `.side`'s `align-self: start` to fixed boxes and would size it to its content. `FlowView.setExpanded()` makes the map fill its box instead of setting its own height. `route()` closes any pop-out. The `.falls-resize` handle between the Falls and Recent events sets `FlowView.setHeight()` (`ui.fallsHeight`, localStorage; null = automatic).
- **Two run modes.** As an HA add-on (`isAddon`: `SUPERVISOR_TOKEN` is set), ingress handles auth and `allowed()` in server.js limits direct port access. Standalone (Docker, `compose.yaml`) there is no auth at all, and HA features need `HA_URL`/`HA_TOKEN`. UI text about HA-specific things should check `api/info` → `addon`.
- **No build step, no framework.** Frontend is ES modules served as-is. Keep it that way.
- **All frontend URLs are relative** (`api/...`, `css/...`, hash routes). HA ingress serves the app under `/api/hassio_ingress/<token>/`, so a leading `/` breaks it.
- Live updates are **polling** (`api/state?v=<version>` every 3s; the server returns `{unchanged: true}` when nothing changed). `engine.version` must be bumped on any state change visible to the UI.
- DOM: build with `h()`/`svg()`. Use `fill(el, …)` instead of `el.replaceChildren(…)`, because it flattens arrays and drops `null`/`false` (`replaceChildren` stringifies them into "[object HTMLDivElement]" / "null").
- CSS class names are global. Generic names collide (a heartbeat pill once used `.empty`, which picked up the dashboard empty-state padding). Prefer specific names.
- The UI is dark-only, with CSS custom properties in `:root` of `public/css/style.css`. Status colors (`--up/--down/--pending/--blocked/--paused`) are reserved for status.
- Backend has one runtime dependency (`nodemailer`, lazily imported). Uses `node:sqlite` (no native modules) and `node:http`. Don't add Express.
- Prepared statements go through `Store.q(sql)` (cached). Schema changes = append a new entry to `MIGRATIONS` in `db.js`; never edit an existing one.

## Adding things

- **Monitor type**: add a checker in `src/checkers/`, register it in `checkers/index.js` (`checkers` + `MONITOR_TYPES`), add `describeTarget` in `engine.js`, then add form fields in `public/js/forms.js` (`TYPE_FIELDS`, `TYPE_HELP`) and a label in `util.js` (`TYPE_LABEL`). Add its settings to `CSV_COLUMNS` in `transfer.js` and to `docs/csv.md`.
- **Notification provider**: add an entry to `providers` in `notifier.js` with `label`, `fields` (rendered automatically by the form) and `send(cfg, alert)`.

## Releasing

Bump the version in **both** `waterfall_alert/config.yaml` and `waterfall_alert/app/package.json` (the UI reads it from package.json), and add a `CHANGELOG.md` entry. The Supervisor offers the update when `config.yaml`'s version changes. On the push to main, CI publishes `ghcr.io/big-barlowe/waterfall-alert:<version>`, `:<major.minor>` and `:latest` (only if that version has no image yet), and always `:edge`. A version bump is therefore also the Docker release.
