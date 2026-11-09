# Importing and exporting monitors (CSV)

Waterfall Alert can export every monitor to a CSV file and import monitors from one. Use it to:

- **Move to a new install.** Export here, import there. The hierarchy, settings, tags, icons and notification choices all come along.
- **Edit in bulk.** Export, change the file in a spreadsheet, and import it again with **Update** mode.
- **Set up many monitors at once.** Start from the blank template or the example file.

Everything is under **Settings → Import & export monitors**. Exports and imports use exactly the same columns, so an exported file imports as it is.

- [Quick start](#quick-start)
- [File format](#file-format)
- [Import modes](#import-modes)
- [Blank cells and missing columns](#blank-cells-and-missing-columns)
- [The hierarchy: `key` and `parents`](#the-hierarchy-key-and-parents)
- [Column reference](#column-reference)
- [Settings for each monitor type](#settings-for-each-monitor-type)
- [Checking and errors](#checking-and-errors)
- [What is not exported](#what-is-not-exported)
- [Example](#example)

## Quick start

**Moving to a new install**

1. On the new install, create your notification channels (**Notifications**) with the **same names** as on the old one. Channels are not exported, because they hold passwords and tokens.
2. On the old install, go to **Settings → Import & export monitors → Export all monitors (CSV)**.
3. On the new install, choose that file under **Import**, keep **Add every row as a new monitor**, check the summary, and press **Import**.

**Editing many monitors at once**

1. Export.
2. Edit the file. You can delete the columns and rows you aren't changing (keep `name`).
3. Import it with **Update monitors with the same name**.

## File format

- One row per monitor. The first row holds the column names.
- Columns can be in any order, and only `name` is needed in every file. Column names are not case-sensitive, and spaces count as underscores (`Retry Interval` = `retry_interval`). Unknown columns are ignored, with a warning.
- Comma-separated, UTF-8. Values containing commas, quotes or line breaks must be in double quotes, with quotes inside doubled: `"Say ""hi"", please"`. Spreadsheet apps do this for you.
- **Lists** (`parents`, `tags`, `notifications`) separate their items with `|`, e.g. `WAN | Router`. Spaces around the `|` don't matter.
- **True/false** columns accept `true`/`false`, `yes`/`no`, `1`/`0` or `on`/`off`.
- Exports start with a byte-order mark and use Windows line endings, so Excel opens names with accents or emoji correctly. When saving from Excel, choose **CSV UTF-8**.

## Import modes

The mode decides what happens when a row's `name` matches a monitor that already exists:

| Mode | Matching name | New name |
|---|---|---|
| **Add every row as a new monitor** | Added anyway; you get two monitors with that name | Added |
| **Update monitors with the same name** | That monitor is changed to match the row | Added |
| **Skip monitors that already exist** | Left alone | Added |

In update and skip mode, a name that more than one existing monitor uses can't be matched, and the import stops with an error. Rename them, or import in add mode.

## Blank cells and missing columns

- **A column that isn't in the file** is left alone. Updated monitors keep their current value, and new monitors get the default.
- **A column that is there but blank** means "the default": the default interval, no description, the automatic icon, and so on. For `parents` and `tags`, blank means none. For `notifications`, blank means the channels marked as default, and `none` means no channels.

So in update mode, include only the columns you want to change. A blank cell in an included column resets that setting.

## The hierarchy: `key` and `parents`

`parents` lists a monitor's parents, separated by `|`. Each entry is looked up in this order:

1. the `key` of a row in the file,
2. the `name` of a row in the file,
3. the name of a monitor that already exists. This means a file can add monitors underneath something you already have, like your WAN.

Rows can come in any order, so a child can appear before its parent. Leave `parents` blank for a top-level monitor. With more than one parent, `parent_mode` decides when the monitor is blocked (see [Multiple parents](../waterfall_alert/DOCS.md#multiple-parents)).

`key` is only needed when two monitors share a name, e.g. two monitors called `API` under different hosts. Give each a unique key and use that key in `parents`. When it is blank, the key is the name. Exports fill in `key` for monitors whose name is shared (as `API #12`) or contains a `|`.

An import that would create a loop (a monitor upstream of itself) is rejected.

```csv
key,name,type,parents,url
,Host 1,ping,,
,Host 2,ping,,
api-1,API,http,Host 1,http://10.0.0.1/health
api-2,API,http,Host 2,http://10.0.0.2/health
,Dashboard,http,api-1 | api-2,http://10.0.0.3/
```

(`ping` monitors also need a `host`. It's left out here to keep the example short.)

## Column reference

These columns apply to every monitor type. The same reference, built from the importer's own definitions, is under **Column reference** on the Settings page.

| Column | Values | Default | Notes |
|---|---|---|---|
| `key` | text | the name | See [above](#the-hierarchy-key-and-parents). |
| `name` | text | | **Required.** Rows are matched to existing monitors by name in update and skip mode. |
| `type` | `group`, `http`, `tcp`, `ping`, `dns`, `ha_entity`, `minecraft`, `snmp`, `push` | | Required for new monitors. In update mode, a blank or missing `type` keeps the current one. |
| `parents` | list | none | Keys or names, separated by `\|`. |
| `parent_mode` | `all`, `any` | `all` | `all`: blocked when any parent is down. `any`: blocked only when every parent is down (redundant paths). |
| `active` | true/false | `true` | `false` = paused. |
| `interval` | 10–86400 | `60` | Seconds between checks. |
| `retries` | 0–20 | `1` | Failures in a row before it counts as down. |
| `retry_interval` | 5–86400 | `20` | Seconds between retries. |
| `timeout` | 1–300 | `10` | Seconds. |
| `resend_interval` | 0–10000 | `0` | Remind every N down checks; `0` = alert once. |
| `description` | text | | |
| `icon` | see below | automatic | |
| `tags` | list | none | See below. |
| `notifications` | list, or `none` | default channels | See below. |

Numbers outside a range are clamped to it, e.g. an interval of `5` becomes `10`.

### `icon`

| Value | Meaning |
|---|---|
| *(blank)* | Automatic: the icon of the monitor's tags if one has one, else the site's favicon for HTTP, the server icon for Minecraft, a folder for groups, nothing for the rest. Tag icons themselves are not in the CSV file; set them on the Tags page. |
| `none` | No icon. |
| `builtin:<name>` | A built-in icon: `globe`, `cloud`, `router`, `switch`, `wifi`, `server`, `nas`, `database`, `container`, `cpu`, `shield`, `lock`, `home`, `bulb`, `camera`, `sensor`, `bolt`, `power`, `tv`, `speaker`, `phone`, `gamepad`, `printer`, `mail`, `drop`, `folder`. |
| `emoji:<emoji>` | Any emoji, e.g. `emoji:🖥️`. |
| `url:<address>` | An image on the web, downloaded and cached by the add-on. Must start with `http://` or `https://`. |
| `data:image/…;base64,…` | An uploaded image. Exports write uploaded icons this way so they move with the file. PNG, JPEG, GIF, WebP, SVG or ICO, at most 256 KB. |

Excel cuts off cells longer than 32,767 characters, which a large uploaded icon can exceed. If an icon goes missing after editing in Excel, re-upload it, or edit the file in a text editor or another spreadsheet app.

### `tags`

Tag names separated by `|`. Each can be followed by its colour as `#rrggbb`:

```
Home #60a5fa | Media #e879f9 | Critical
```

Tags that don't exist yet are created, with the given colour or the next preset colour. Tags that already exist keep their current colour. In an included `tags` column, the list replaces the monitor's tags, and a blank cell removes them all.

### `notifications`

Names of notification channels, separated by `|` (not case-sensitive), e.g. `Phone | Email`. A blank cell means the channels marked **Default for new monitors**, and `none` means no channels. Exports write `none` for monitors without any.

Channels must already exist on the install you import into. A name that doesn't match one is skipped, with a warning.

## Settings for each monitor type

The remaining columns are the settings of particular monitor types. A filled-in value in a column that doesn't apply to the row's type is ignored, with a warning. When a monitor's type changes in update mode, its old type's settings are dropped.

### `http` (HTTP(S))

| Column | Values | Default | Notes |
|---|---|---|---|
| `url` | URL | | **Required.** |
| `method` | `GET`, `HEAD`, `POST`, `PUT` | `GET` | |
| `accepted_codes` | e.g. `200-299,301` | `200-299` | Status codes and ranges that count as up. |
| `keyword` | text | | Down unless the response body contains it. |
| `invert_keyword` | true/false | `false` | Down if the keyword *is* present. |
| `ignore_tls` | true/false | `false` | Ignore certificate errors. |
| `headers` | JSON object | | e.g. `{"Authorization": "Bearer abc"}`. Remember to double the quotes inside a quoted CSV cell. |
| `body` | text | | Request body. |

### `tcp` (TCP port)

| Column | Notes |
|---|---|
| `host` | **Required.** Host name or IP address. |
| `port` | **Required.** |

### `ping`

| Column | Notes |
|---|---|
| `host` | **Required.** |

### `dns`

| Column | Values | Default | Notes |
|---|---|---|---|
| `hostname` | | | **Required.** The name to resolve. For SRV records: `_service._proto.example.net`. |
| `record_type` | `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `SRV` | `A` | |
| `server` | IP address | system resolver | Resolver to ask, e.g. `1.1.1.1`. |
| `expected` | text | | Down unless an answer contains it. SRV answers read as `target:port`. |

### `ha_entity` (Home Assistant entity)

| Column | Notes |
|---|---|
| `entity_id` | **Required.** e.g. `binary_sensor.nas_online`. |
| `expected_state` | Comma-separated states that count as up, e.g. `on, home`. Blank = up unless `unavailable` or `unknown`. |

### `minecraft` (Java Edition server)

| Column | Notes |
|---|---|
| `host` | **Required.** The address you type into the game. |
| `port` | Blank = follow the `_minecraft._tcp` SRV record, or 25565 without one. A port skips the SRV lookup, as it does in the game. |

### `snmp`

| Column | Notes |
|---|---|
| `host` | **Required.** Host name or IP address of the device. |
| `port` | Blank = 161. |
| `snmp_version` | `2c` (default) or `1`. |
| `community` | The read-only community. Blank = `public`. Exported as plain text, so treat an export with SNMP monitors like a password. |
| `snmp_oids` | Extra values to read and show, as `Label = OID`, separated by `;` or new lines, e.g. `Temperature = 1.3.6.1.4.1.9.9.13.1.3.1.3.1; Fan = 1.3.6.1.4.1.9.9.13.1.4.1.3.1`. |
| `snmp_hide` | What **Customize** left off the monitor's page, separated by `\|`: `fact:contact`, `fact:objectId` (also `name`, `location`, `uptime`, `descr`), `if:<interface name>`, `res:cpu`, `res:<memory or disk name>`, `section:interfaces`, `section:resources`, `section:values`. |
| `snmp_card` | Up to two values for the card in the Falls, separated by `\|`: `name`, `location`, `uptime`, `ifs` (links up), `cpu`, `memory`, `disk:<name>`, `if:<interface name>` (its traffic), `value:<OID>` (one of `snmp_oids`). Blank = name and links up. |

### `push`

| Column | Notes |
|---|---|
| `push_token` | The secret in the push URL (`/api/push/<token>`). Keep it when moving installs so whatever pushes to the old URL keeps working. Blank = generate a new one. If another monitor already uses the token, a new one is generated, with a warning. |

### `group`

Groups have no settings of their own.

## Checking and errors

Choosing a file only **checks** it: the import runs without saving and shows what would happen ("7 to add · 2 to update · 1 new tag"), plus any problems with their line numbers. Nothing changes until you press **Import**.

An import is all-or-nothing. If any row has an error, nothing is imported. Warnings, such as an unknown column or a missing notification channel, don't stop the import.

Typical errors:

| Message | Fix |
|---|---|
| `url is required for http monitors` | Fill in the type's required column. |
| `Parent "X" isn't in the file and no monitor has that name` | Check the spelling, or add a row for X. |
| `Parent "API" is ambiguous` | Give the rows named API a `key` and use the key in `parents`. |
| `2 existing monitors are called "X", so it can't be matched` | Rename one, or import in add mode. |
| `"X" is also used on line 7` | Two rows with the same name (or key) in add mode; give one a `key`. |
| `interval must be a whole number` | Numbers only, without units. |
| `The parents form a loop` | Some monitor would end up upstream of itself. |

## What is not exported

- **Heartbeat history, uptime and the alert log** stay on the old install.
- **Notification channels** (they hold secrets). Recreate them with the same names.
- **Add-on settings**, such as heartbeat retention.

Icons fetched automatically (favicons, Minecraft server icons) are not in the file either. The new install fetches them again.

## Example

This is the **Example file** offered on the Settings page, trimmed to the columns it uses:

```csv
name,type,parents,parent_mode,interval,retries,description,icon,tags,url,accepted_codes,keyword,host,port,hostname,record_type,entity_id,expected_state
WAN,ping,,,,,Internet connection,builtin:globe,Network #60a5fa,,,,1.1.1.1,,,,,
Router,ping,WAN,,,,,builtin:router,Network,,,,192.168.1.1,,,,,
NAS,http,Router,,,,,builtin:nas,Home #a78bfa,http://192.168.1.20:5000/,,,,,,,,
Plex,tcp,NAS,,,,,,Home | Media #e879f9,,,,192.168.1.20,32400,,,,
Nightly backup,push,NAS,,90000,0,,,Home,,,,,,,,,
Front door camera,ha_entity,Router,,,,,builtin:camera,,,,,,,,,binary_sensor.front_door_camera_online,on
Website DNS,dns,WAN,,,,,,,,,,,,example.com,A,,
Website,http,WAN | Website DNS,all,,,,,,https://example.com/health,200-299,ok,,,,,,
Minecraft,minecraft,WAN,,,,,,,,,,mc.example.net,,,,,
```
