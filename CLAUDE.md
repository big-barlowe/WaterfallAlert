# CLAUDE.md

Waterfall Alert is a Home Assistant add-on for hierarchical uptime monitoring (Uptime Kuma-style, but monitors form a DAG and a failure sends one root-cause alert listing everything downstream).

## Layout

```
repository.yaml              HA add-on repository manifest (this repo is the repository)
waterfall_alert/             the add-on (Supervisor build context)
  config.yaml                add-on manifest: version, ingress, options/schema
  Dockerfile                 node:22-alpine, copies app/
  DOCS.md / CHANGELOG.md     shown in the HA add-on UI
  app/
    src/server.js            node:http server, static files, ingress access control
    src/api.js               all REST routes + input validation + edge/cycle checks
    src/engine.js            scheduler + hierarchy logic (the core; read this first)
    src/graph.js             DAG helpers: ancestors/descendants, levels, cycles, subtree
    src/db.js                node:sqlite Store, migrations (PRAGMA user_version)
    src/checkers/            one function per monitor type -> { ok, ping?, msg }
    src/notifier.js          notification providers + their form field definitions
    src/icons.js             icon specs, favicon discovery, IconCache (cached images in the `icons` table)
    src/status.js            heartbeat status codes
    public/                  vanilla-JS SPA, no build step
      js/app.js              router, polling, sidebar tree (drag/drop), views
      js/flow.js             SVG "falls" diagram, focus/lineage view, FLIP animation
      js/icons.js            built-in glyphs, iconEl() (HTML) / iconSvg() (inside the diagram)
      js/chart.js            heartbeat bar + response-time chart
      js/forms.js            monitor + notification forms
      js/util.js             api(), h()/svg()/fill() DOM helpers, formatters
    test/engine.test.js      node:test scenarios for the hierarchy logic
    test/icons.test.js       favicon discovery and icon cache, with a fake `request`
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

## Icons

- A monitor's `icon` column holds a spec: `''` automatic (favicon for HTTP, folder for groups), `none`, `builtin:<name>`, `emoji:<text>`, `url:<url>`, `upload`. Parsing and validation are in `src/icons.js`.
- `IconCache.sync(monitors, forceIds)` runs after every monitor create/update/delete and every 6h. It drops images nothing wants and fetches missing or stale ones in the background, then calls `engine.touch()` so the UI polls them in.
- `/api/state` replaces each monitor's spec with a render descriptor from `icons.describe()`: `{kind:'image', src}`, `{kind:'builtin', name}`, `{kind:'emoji', value}` or `null`. `GET api/monitors/:id` still returns the raw spec, which is what the form edits.
- Images are served from `api/monitors/:id/icon` with a sandboxing CSP, because SVGs come from arbitrary sites and the add-on shares Home Assistant's origin. Keep those headers. Types are sniffed from bytes (`sniffImage`), never from Content-Type.
- Built-in glyph keys are stored in the database, so never rename one in `public/js/icons.js`. Adding one is fine.

## Falls diagram (flow.js)

- `render(monitors, focusId)`: with a focus, only `lineage()` (ancestors + descendants) is laid out. The structure is rebuilt only when the topology key changes (ids, names, edges, icons, focus); `#paint` updates status classes in place so animations don't restart.
- On a rebuild, surviving nodes FLIP from their old screen position. They are positioned via the outer `g`'s `transform` attribute and animated via CSS transforms on the inner `.node-inner`, because a CSS transform on the outer one would override the attribute.
- Focus state lives in `ui.focus`/`ui.info` in app.js and is mirrored into the hash with `history.replaceState`. A real hash change would re-route and rebuild the diagram without the animation.
- Two glow filters: `#glow` (user space) for streams, since a bounding-box region is zero-wide on a vertical path, and `#glow-box` for elements inside a translated node.

## Conventions

- **No build step, no framework.** Frontend is ES modules served as-is. Keep it that way.
- **All frontend URLs are relative** (`api/...`, `css/...`, hash routes). HA ingress serves the app under `/api/hassio_ingress/<token>/`, so a leading `/` breaks it.
- Live updates are **polling** (`api/state?v=<version>` every 3s; the server returns `{unchanged: true}` when nothing changed). `engine.version` must be bumped on any state change visible to the UI.
- DOM: build with `h()`/`svg()`. Use `fill(el, …)` instead of `el.replaceChildren(…)`, because it flattens arrays and drops `null`/`false` (`replaceChildren` stringifies them into "[object HTMLDivElement]" / "null").
- CSS class names are global. Generic names collide (a heartbeat pill once used `.empty`, which picked up the dashboard empty-state padding). Prefer specific names.
- The UI is dark-only, with CSS custom properties in `:root` of `public/css/style.css`. Status colors (`--up/--down/--pending/--blocked/--paused`) are reserved for status.
- Backend has one runtime dependency (`nodemailer`, lazily imported). Uses `node:sqlite` (no native modules) and `node:http`. Don't add Express.
- Prepared statements go through `Store.q(sql)` (cached). Schema changes = append a new entry to `MIGRATIONS` in `db.js`; never edit an existing one.

## Adding things

- **Monitor type**: add a checker in `src/checkers/`, register it in `checkers/index.js` (`checkers` + `MONITOR_TYPES`), add `describeTarget` in `engine.js`, then add form fields in `public/js/forms.js` (`TYPE_FIELDS`, `TYPE_HELP`) and a label in `util.js` (`TYPE_LABEL`).
- **Notification provider**: add an entry to `providers` in `notifier.js` with `label`, `fields` (rendered automatically by the form) and `send(cfg, alert)`.

## Releasing

Bump the version in **both** `waterfall_alert/config.yaml` and `waterfall_alert/app/package.json` (the UI reads it from package.json), and add a `CHANGELOG.md` entry. The Supervisor offers the update when `config.yaml`'s version changes.
