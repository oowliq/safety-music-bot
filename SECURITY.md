# Security notes

This fork exists to reduce the attack surface of the upstream bot. See the table in
`README.md` for what was removed and why.

## Deployment checklist

- [ ] `NODELINK_PASSWORD` is random (≥16 characters) and NodeLink is not published to the internet.
- [ ] NodeLink and yt-cipher images are pinned by digest (they are in `docker-compose.yml`).
- [ ] Secrets are split: `.env` (infrastructure) and `bot.env` (bot). The bot container gets
      only its Mongo URI (least-privilege `musicbot` user) and the NodeLink password.
- [ ] No `ports:` on any service; `/metrics` stays on `127.0.0.1` inside the bot container.
- [ ] `ALLOW_PRIVATE_MEDIA_URLS=0`, so users cannot make the bot fetch LAN addresses.
- [ ] Egress firewall (below) blocks the `egress` network from reaching your LAN.
- [ ] `.env` and `bot.env` are not committed.

## Egress firewall

The application refuses private addresses (`safeFetch` resolves DNS, blocks private ranges and
re-checks every redirect). ffmpeg and NodeLink, however, fetch media on their own and can follow
redirects or HLS segment lists to internal addresses. Do not rely on the application alone:
block the `egress` network (`EGRESS_SUBNET`, default `172.30.250.0/24`) at the host.

Docker evaluates the `DOCKER-USER` chain for forwarded container traffic. Example with iptables
(run as root on the Docker host, adapt the ranges to your homelab):

```bash
SUBNET=172.30.250.0/24          # EGRESS_SUBNET
FLUXER_IP=                      # your Fluxer host if it lives on the LAN (else leave empty)

iptables -N SMB-EGRESS 2>/dev/null || iptables -F SMB-EGRESS
iptables -A SMB-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A SMB-EGRESS -d "$SUBNET" -j RETURN                      # bot <-> nodelink <-> yt-cipher
[ -n "$FLUXER_IP" ] && iptables -A SMB-EGRESS -d "$FLUXER_IP" -p tcp -m multiport --dports 80,443 -j RETURN
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 224.0.0.0/4; do
  iptables -A SMB-EGRESS -d "$net" -j REJECT
done
iptables -C DOCKER-USER -s "$SUBNET" -j SMB-EGRESS 2>/dev/null || iptables -I DOCKER-USER -s "$SUBNET" -j SMB-EGRESS
```

- Container DNS goes through Docker's embedded resolver (127.0.0.11), which forwards from the
  host itself, so it keeps working.
- The rules are not persistent; save them with your distribution's tooling
  (`netfilter-persistent`, an nftables include, or your router/OPNsense rules for this host).
- With IPv6 enabled on Docker, add the equivalent `ip6tables` rules (`fc00::/7`, `fe80::/10`).
- Verify from the bot container:
  `docker compose exec bot node -e "fetch('http://192.168.1.1').then(()=>console.log('OPEN')).catch(e=>console.log('blocked:',e.cause?.code))"`

## Remaining trust boundaries

- NodeLink fetches from YouTube and other providers on the bot's behalf; its `local` and `http`
  sources are disabled in `docker-compose.yml`. Its code and dependencies are outside this repository.
- yt-cipher downloads and runs YouTube's player JavaScript to decipher stream signatures.
- Lyrics are fetched from `lrclib.net` and `api.lyrics.ovh` when a user runs `lyrics`.
- A guild admin can set a `musicwebhook` URL. Requests go through the SSRF-guarded `safeFetch`.
- The YouTube TV refresh token (if set) belongs to a Google account; use a throwaway account.
