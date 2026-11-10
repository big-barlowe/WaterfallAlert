# Running Waterfall Alert with Docker

You don't need Home Assistant to use Waterfall Alert. It is published as a Docker image, `ghcr.io/big-barlowe/waterfall-alert`, and outside Home Assistant it runs as a standalone web app. Everything works the same, except:

- **Home Assistant entity monitors** and the **Home Assistant notification channel** need a connection to a Home Assistant instance. See [Connecting to Home Assistant](#connecting-to-home-assistant-optional). All other monitor types (HTTP(S), TCP, ping, DNS, Minecraft, push, group) and notification channels (ntfy, Discord, Slack, Telegram, Pushover, Gotify, webhook, email) work on their own.
- **There is no login.** Inside Home Assistant, HA handles sign-in. On its own, anyone who can reach the port can use the UI. Keep it on a trusted network, or put it behind a reverse proxy that adds a login. See [Security](#security).

Contents:

- [Requirements](#requirements)
- [Docker Compose (recommended)](#docker-compose-recommended)
- [Plain `docker run`](#plain-docker-run)
- [Image tags](#image-tags)
- [Building it yourself](#building-it-yourself)
- [Configuration](#configuration)
- [Your data and backups](#your-data-and-backups)
- [Updating](#updating)
- [Security](#security)
- [Networking notes](#networking-notes)
- [Connecting to Home Assistant (optional)](#connecting-to-home-assistant-optional)
- [Moving between the add-on and Docker](#moving-between-the-add-on-and-docker)
- [Troubleshooting](#troubleshooting)

## Requirements

- Docker Engine with the Compose plugin (`docker compose version` should print v2 or later). Docker Desktop on macOS or Windows works too.
- A 64-bit machine: x86-64 (amd64) or ARM (arm64, e.g. a Raspberry Pi 4 or 5 running a 64-bit OS).
- About 170 MB of disk for the image, plus the database. The database grows with heartbeat history; the default 90-day retention keeps it modest.

## Docker Compose (recommended)

1. Make a folder for it, e.g. `~/waterfall-alert`, and save this as `compose.yaml` inside (the same file is at the top of this repository, [`compose.yaml`](../compose.yaml)):

   ```yaml
   services:
     waterfall-alert:
       image: ghcr.io/big-barlowe/waterfall-alert:latest
       container_name: waterfall-alert
       restart: unless-stopped
       ports:
         - "8099:8099"
       volumes:
         - ./data:/data
       environment:
         TZ: America/Chicago        # your time zone
         LOG_LEVEL: info
         # HA_URL: http://homeassistant.local:8123
         # HA_TOKEN: <long-lived access token>
       healthcheck:
         test: ["CMD", "wget", "-qO", "/dev/null", "http://localhost:8099/api/info"]
         interval: 30s
         timeout: 5s
         start_period: 10s
         retries: 3
   ```

2. Start it:

   ```sh
   cd ~/waterfall-alert
   docker compose up -d
   ```

3. Open `http://<your-server>:8099` and add your first monitor. Your data is kept in the `data` folder next to `compose.yaml`.

### Everyday commands

| | |
|---|---|
| Start, or apply changes to `compose.yaml` | `docker compose up -d` |
| Stop | `docker compose down` (your data stays in `./data`) |
| Logs | `docker compose logs -f` |
| Status and health | `docker compose ps` |
| Restart | `docker compose restart` |

## Plain `docker run`

```sh
docker run -d \
  --name waterfall-alert \
  --restart unless-stopped \
  -p 8099:8099 \
  -v /srv/waterfall-alert:/data \
  -e TZ=America/Chicago \
  ghcr.io/big-barlowe/waterfall-alert:latest
```

## Image tags

| Tag | |
|---|---|
| `latest` | The newest release. |
| `0.5.1` (etc.) | One exact release. It never changes, so use it to stay on a version until you choose to move. |
| `0.5` (etc.) | The newest release in that series. |
| `edge` | The newest code on the main branch, including unreleased changes. Mostly for testing. |

Images are built for amd64 and arm64 by [GitHub Actions](../.github/workflows/test.yml) after the tests pass. The [changelog](../waterfall_alert/CHANGELOG.md) lists every release.

## Building it yourself

To build from source instead, e.g. to run local changes, replace the `image:` line in `compose.yaml` with one of these, then run `docker compose up -d --build`:

```yaml
    # from a clone of this repository (compose.yaml at its top level)
    build: ./waterfall_alert
    # or straight from GitHub, without cloning
    build: https://github.com/big-barlowe/WaterfallAlert.git#main:waterfall_alert
```

In the GitHub form, `#main` is the branch. To build a particular version, use the full 40-character hash of its commit; the short form doesn't work there.

## Configuration

Everything about monitors, notifications, tags and retention is set in the web UI. The container itself only takes these environment variables:

| Variable | Default | |
|---|---|---|
| `TZ` | `Etc/UTC` | Time zone for the timestamps in alert messages and logs, e.g. `Europe/London`, `America/New_York`. The web UI always shows times in your browser's time zone. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warning` or `error`. |
| `PORT` | `8099` | Port inside the container. To use a different port on the host, change the left side of `ports` instead (e.g. `"8080:8099"`). |
| `DATA_DIR` | `/data` | Where the database lives inside the container. Change the volume, not this. |
| `HA_URL` | | Optional. See [Connecting to Home Assistant](#connecting-to-home-assistant-optional). |
| `HA_TOKEN` | | Optional. |

## Your data and backups

Everything (monitors, settings, heartbeat history, the alert log, tags, cached icons) is stored in one SQLite database in the data volume: `./data/waterfall.db` with Compose, or whatever you mounted at `/data`. Next to it you'll also see `waterfall.db-wal` and `waterfall.db-shm`. These belong to the database and must be kept with it.

**To back up**, stop the container so the database is consistent, then copy the folder:

```sh
docker compose stop
cp -a data "data-backup-$(date +%F)"
docker compose start
```

For a backup without stopping, use SQLite's online backup, e.g. `sqlite3 data/waterfall.db ".backup 'waterfall-backup.db'"` (requires the `sqlite3` tool on the host).

**For just the monitors**, use **Settings → Import & export monitors → Export all monitors (CSV)**. This file is small and readable, and is the easiest way to move to a new install (see the [CSV guide](csv.md)). It doesn't include heartbeat history, notification channels or rules.

**To restore**, stop the container, put the backed-up files back in the data folder, and start it again.

## Updating

```sh
docker compose pull
docker compose up -d
```

With `latest`, this moves you to the newest release. With a version tag such as `0.5.1`, change the tag in `compose.yaml` first. Your data is kept: database changes between versions are applied automatically when the new version starts. You can't go back to an older version with an upgraded database, so take a backup before big jumps.

To clear out old images afterwards: `docker image prune`.

If you build it yourself, run `git pull` (for a clone), then `docker compose build --pull` and `docker compose up -d`.

## Security

Waterfall Alert has **no user accounts or login** of its own. Anyone who can open the port can view and change everything, including notification settings such as bot tokens and SMTP passwords. So:

- **On a home network:** fine as it is, if you trust the devices on it.
- **Reachable from the internet:** don't publish port 8099 directly. Put a reverse proxy in front that adds authentication: basic auth, or a single sign-on service such as Authelia, Authentik or Cloudflare Access.
- **Push monitors** are the exception. Services call `/api/push/<token>` without a login, and the token in the URL acts as the password. If those services are outside your network, let `/api/push/` through the proxy without authentication.

Example with [Caddy](https://caddyserver.com/), which also handles HTTPS. Create the password hash with `caddy hash-password`:

```caddyfile
waterfall.example.com {
	# push monitors: no login, the token in the URL is the secret
	@push path /api/push/*
	handle @push {
		reverse_proxy waterfall-alert:8099
	}

	handle {
		basic_auth {
			admin <hash from caddy hash-password>
		}
		reverse_proxy waterfall-alert:8099
	}
}
```

(`waterfall-alert:8099` works when Caddy runs in the same Compose project or Docker network. Otherwise use `localhost:8099` or the server's IP.)

**Serving under a sub-path** such as `https://example.com/waterfall/` works too, because the app only uses relative links. Have the proxy strip the prefix, and always link to the address with the trailing slash.

## Networking notes

The checks run **from inside the container**, so they see the network the way the container does:

- **Devices on your LAN** (`192.168.x.x`, `nas.local`, …) are reachable from Docker's default bridge network. Nothing extra is needed.
- **`localhost` means the container itself**, not your server. To monitor something on the Docker host, use the host's LAN IP. Or add this to the service and use `host.docker.internal`:

  ```yaml
      extra_hosts:
        - "host.docker.internal:host-gateway"
  ```

- **Other containers** in the same Compose project can be reached by service name, e.g. `http://jellyfin:8096/`.
- **mDNS names** (`something.local`) may not resolve inside containers. Use IP addresses, or run with `network_mode: host`. With host networking, `ports:` is ignored and the UI is on port 8099 of the host.
- **Ping** needs the `NET_RAW` capability. Docker grants it by default. With rootless Docker or Podman, ping monitors may fail with "permission denied"; add `cap_add: [NET_RAW]` to the service, or use TCP monitors instead.
- **Push monitors** need the push URL to be reachable by whatever sends the pushes: `http://<docker-host>:8099/api/push/<token>`. The full URL is shown on the push monitor's edit page.

## Connecting to Home Assistant (optional)

Waterfall Alert can talk to a Home Assistant instance even when it runs on its own. This enables **HA entity** monitors (for example, alert when `binary_sensor.nas_online` goes off) and the **Home Assistant** notification channel (send alerts through any `notify.*` service, such as the mobile app).

1. In Home Assistant, open your profile → **Security** → **Long-lived access tokens** → **Create token**.
2. Set the two variables and restart the container:

   ```yaml
       environment:
         HA_URL: http://homeassistant.local:8123
         HA_TOKEN: <the token>
   ```

Use the address Home Assistant is reachable at *from the container* (see [Networking notes](#networking-notes)). Without these variables, everything else still works. HA entity monitors show "Home Assistant API not available".

## Moving between the add-on and Docker

Both run the same code and read the same database format, so you can switch either way:

- **Easiest:** **Settings → Import & export monitors**. Export on one side and import on the other, then set up notification channels and rules on the new side. Heartbeat history isn't carried over.
- **Everything, history included:** stop both, then copy `waterfall.db` (and `-wal`/`-shm`, if present) into the other one's data folder. From the add-on, the database is in its backups: make a partial backup of just the add-on, download it, and look for `waterfall.db` in the extracted archive. It's in the add-on's own archive, inside its data folder.

## Troubleshooting

| Symptom | Check |
|---|---|
| Page won't load | `docker compose ps` should show `healthy`. Check `docker compose logs`. Is another program already using port 8099? Change the host side of `ports`. |
| Ping monitors always down, "permission denied" | See the ping note in [Networking notes](#networking-notes). |
| Can't monitor something on the same machine | `localhost` is the container. Use the host IP or `host.docker.internal`. |
| `.local` names don't resolve | Use IP addresses or `network_mode: host`. |
| HA entity monitors say "Home Assistant API not available" | Set `HA_URL` and `HA_TOKEN`, then `docker compose up -d`. |
| Times in alerts are off by hours | Set `TZ`. |
| Permission errors on `./data` (SELinux hosts such as Fedora) | Mount with `./data:/data:Z`. |
