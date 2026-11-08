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
2. `cp env.example .env`, fill in the REQUIRED block, point `API_BASE`/`GATEWAY_URL` at your
   Fluxer and set `BOT_IMAGE=ghcr.io/<owner>/<repo>:latest`.
   For a private package run `docker login ghcr.io` with a PAT that has `read:packages`.
3. Start: `docker compose up -d`. Update: `docker compose pull && docker compose up -d`.
   Without `BOT_IMAGE`, `docker compose up -d --build` builds the image locally.

`docker-compose.yml` runs the bot, NodeLink (official dev build pinned by digest) with a self-hosted yt-cipher and MongoDB, and publishes
no ports. The bot runs read-only as UID 1000 with `cap_drop: ALL` and `no-new-privileges`.
NodeLink runs with its `local` (file) and `http` (arbitrary URL) sources and metrics disabled.
MongoDB has auth, a least-privilege user and sits on an `internal` network. Block your LAN or
management subnets for the `egress` network with host firewall rules.

## Development

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm test
```

Tests run in CI inside the image (`docker build --target test .`).
