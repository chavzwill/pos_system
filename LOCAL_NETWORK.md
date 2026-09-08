# Total Tools POS — Local Network Runtime

The POS is designed to run from the Total Tools network without Vercel or another cloud frontend host.

## Recommended topology

Run the native POS server on one always-on computer on the branch/store LAN. All POS terminals, tablets and phones on that trusted network open the server by its LAN address.

Example:

```text
POS server PC: 192.168.1.50
POS port:      3001
Browser URL:   http://192.168.1.50:3001
```

The frontend and API are same-origin, so no separate frontend server is required.

## Start the POS

On the POS server computer:

```bash
npm install
npm start
```

The existing Node listener is reachable on the local network when the operating-system firewall allows inbound TCP traffic to the configured `PORT` (default `3001`).

Do not use a Vercel URL for branch terminals.

## Login cookies on HTTP LANs

The POS session cookie now uses transport-aware security.

`POS_COOKIE_SECURE=auto` is the default:

- HTTP local-network request -> cookie is `HttpOnly; SameSite=Lax` and is usable on the LAN.
- HTTPS request -> cookie also receives `Secure`.

This avoids the old failure where `NODE_ENV=production` forced a `Secure` cookie even when a branch terminal was using `http://192.168.x.x`, causing login to succeed on the server but disappear on the next page request.

Optional override:

```env
POS_COOKIE_SECURE=auto
```

Use `POS_COOKIE_SECURE=true` only when every terminal reaches the POS through HTTPS. Do not enable it for plain HTTP LAN access.

## Network and firewall

For a Windows host, allow inbound TCP traffic for Node.js (or specifically TCP port 3001) on the **Private** network profile only. Do not expose the POS port directly to the public internet.

Prefer assigning the server a DHCP reservation/static LAN address so terminals do not have to change bookmarks after a router restart.

## Browser access

From another device connected to the same LAN, open:

```text
http://<POS-SERVER-LAN-IP>:3001
```

Do not use `localhost` from another device; `localhost` always means that device itself.

## Security boundary

A local network is not an authentication bypass. Employee sessions, RBAC, branch authorization, same-origin mutation protection, lifecycle concurrency controls and mutation idempotency remain active.

If the POS is later placed behind Caddy/Nginx with HTTPS, configure the reverse proxy deliberately rather than exposing Node directly to the internet.

## Login troubleshooting

If credentials are accepted but the login screen immediately reappears:

1. Confirm the browser is opening the LAN URL directly (for example `http://192.168.1.50:3001`).
2. Confirm `POS_COOKIE_SECURE` is `auto` or `false` for HTTP.
3. Clear any old `pos_session` cookie left from previous builds and sign in again.
4. Confirm the server computer's date/time is correct because session expiration is UTC-based.
5. Check the server console for `Session authentication failed` or `POS client diagnostic` messages.

The POS should not require Vercel for normal local-network operation.
