# Safety Music Bot

A security-focused music bot for self-hosted [Fluxer](https://fluxer.app).
Based on [Vinto-Music](https://github.com/invaliduser231/Vinto-Music) by Rainer Schnittert
(upstream commit `9e93e35`, MIT licence, see `LICENSE`). Not affiliated with the upstream project.

All provider playback (YouTube, SoundCloud, Deezer, Spotify/Apple/Tidal imports, …) goes
through **your NodeLink**. The bot never runs yt-dlp/play-dl and never handles cookies or provider
credentials. It decodes locally only plain HTTP audio files and internet radio (ffmpeg).

## What changed compared with upstream

| Removed / changed | Why |
|---|---|
| `eval` command (AsyncFunction with `process`/`globalThis`) | arbitrary code execution in the bot process |
| Dashboard (Next.js) + Dashboard API (`:9092`, shared secret, OAuth) | public listener with a well-known example secret |
| Earrape protection | bot sat undeafened, subscribed to members' voice and stored per-user profiles |
| yt-dlp, play-dl, bgutil PO-token, cookies (`YTDLP_*`, `cookies.txt`) | binary downloaded at `latest`, cookie handling, remote JS components |
| Direct Deezer (ARL + blowfish decryption), SoundCloud client-id scraping, Audius, Apple token scraping | duplicates NodeLink and needs extra secrets |
| Last.fm (scrobbling, accounts, crowns) | stores third-party session keys |
| AudD radio recognition | uploaded radio audio samples to api.audd.io |
| Sentry, FluxerList stats and votes | telemetry to third parties |
| `ffmpeg-static` | downloaded a binary at install time; Debian's `ffmpeg` is used instead |
| NodeLink is **required**, with a password ≥16 chars | well-known defaults (`youshallnotpass`) are rejected at startup |
| Monitoring server binds to `127.0.0.1` by default | `/metrics` was reachable on `0.0.0.0` |
| ffmpeg runs with `-protocol_whitelist http,https,tcp,tls,crypto,hls` | blocks `file:`/`concat:` style inputs |
| Support/donation links | removed; set `SUPPORT_URL` if you want one |

`autoplay` remains (related tracks via NodeLink search). Everything else (queue, playlists,
favourites, filters/EQ, radio, lyrics, 24/7, DJ roles, stats, templates, …) is unchanged.

## Running

1. Push to GitHub. `.github/workflows/ci.yml` runs typecheck and tests on every push/PR.
   On the default branch and on `v*` tags it builds `linux/amd64` + `linux/arm64` images and
   publishes them to `ghcr.io/<owner>/<repo>` (`latest`, `sha-<short>`, semver tags) with
   SBOM and build provenance. Verify an image with
   `gh attestation verify oci://ghcr.io/<owner>/<repo>:latest --owner <owner>`.
2. Create the two env files and fill in their REQUIRED blocks:
   - `cp .env.example .env`: infrastructure secrets (Mongo, NodeLink, YouTube token) and images.
     Set `BOT_IMAGE=ghcr.io/<owner>/<repo>:latest`.
   - `cp bot.env.example bot.env`: bot token, Fluxer URLs (`API_BASE`, `GATEWAY_URL`) and behaviour.

   The bot container only receives `bot.env` plus its own Mongo URI and the NodeLink password;
   the Mongo root password and provider tokens never reach it.
   For a private package run `docker login ghcr.io` with a PAT that has `read:packages`.
3. Start: `docker compose up -d`. Update: `docker compose pull && docker compose up -d`.
   Without `BOT_IMAGE`, `docker compose up -d --build` builds the image locally.

`docker-compose.yml` runs the bot, NodeLink (official dev build pinned by digest), a self-hosted
yt-cipher and MongoDB, and publishes no ports.

- Bot: read-only root FS, UID 1000, `cap_drop: ALL`, `no-new-privileges`.
- NodeLink: the `local` source (reads files) is **disabled**, the `http` source (fetches arbitrary
  URLs) is **disabled**, metrics are **disabled**. Only `loadstream` is enabled for the bot.
- MongoDB: auth enabled, least-privilege `musicbot` user, `internal` network only.
- Egress: the `egress` network has a fixed subnet (`EGRESS_SUBNET`). Block your LAN for it on
  the host; ready-made rules are in [SECURITY.md](SECURITY.md#egress-firewall).

## Development

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm test
```

CI runs the same commands on every push and pull request; `docker build --target test .` runs them inside the image.
