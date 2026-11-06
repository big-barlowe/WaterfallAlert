# Changelog

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
