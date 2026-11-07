---
name: share-a-port
description: Give a port running in this workspace a public HTTPS URL, with factiii-expose. TRIGGER when the user asks to share, expose, preview or publish a local server, wants a link to something running on localhost, or needs an external service to reach a local port.
license: ISC
---

# share-a-port

This workspace can put a local port on the public internet. Both commands are
already on your PATH; nothing needs installing.

## Share a port

```bash
factiii-expose <port> <name>   # e.g. factiii-expose 3000 app
```

It prints the public URL and returns straight away - the tunnel runs in the
background and lives until the session ends or you stop it.

- `<name>` may hold letters, numbers and dashes only.
- Re-running it with the same name replaces that tunnel rather than opening a
  second one, so it is safe to repeat.
- Start the server FIRST. A URL for a port nothing is listening on answers
  with an error, which reads to the user like a broken tunnel.
- The URL is HTTPS. `http://` works too, on a different path through the Mini's
  nginx, so prefer the https one you were given.

## Sharing an app, not just a port

A web app usually needs two tunnels, and its own config has to name them before
it is built or booted. A client that still points at `localhost:5001` loads over
HTTPS and then has every API call blocked as mixed content, which looks like a
broken deploy rather than a config miss.

So: expose both ports first, put those URLs in the app's config (for this repo,
`NEXT_PUBLIC_SITE_URL` / `NEXT_PUBLIC_API_URL` / `ALLOWED_ORIGINS` in `.env`),
and only then start the servers. Getting that order wrong costs a restart of
both.

Two more `.env` values matter once the app has logins, and both fail silently:

- `COOKIE_DOMAIN` — the two tunnels are different hostnames under one parent, so
  a host-only cookie set on the web host is never sent to the api host. Every
  authenticated call 401s while the UI looks signed in.
- `NEXT_PUBLIC_COOKIE_PREFIX` — must differ from production's. A preview under
  `*.dev.factiii.com` also receives cookies scoped to `.factiii.com`, so anyone
  logged into the real site sends a same-named cookie that shadows the
  preview's, and signing in simply does not stick. `.env.example` already ships
  a distinct value; keep it distinct.

## Stop sharing

```bash
factiii-unexpose <name>
```

## Before you share

The URL is public and unauthenticated: anyone holding the link reaches
whatever that port serves. Do not expose a service that fronts real
credentials, customer data, or a database. If you are unsure whether the user
wants something reachable from outside, ask first.

Always tell the user the URL you got back.

They can also see it themselves, in the card's **Tasks** panel — the button in
the session header, which lists what the card is running and which ports are
public. Point them there by that name. **Setup**, the button beside it, is a
different thing: a fixed log of how the workspace was prepared, which never
shows running servers. Saying "the task manager" or leaving it unnamed sends
people to Setup and looks like the tunnel failed.

