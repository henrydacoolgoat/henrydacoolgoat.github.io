# Asteroid OS v0.99.23.4 — complete GitHub Pages release

This build preserves the v0.99.23.4 performance and direct-username changes and
includes laptop-backed MessageX media storage, FreePeriod, MessageX, and the
complete Asteroid Browser runtime.

## Asteroid Browser and GitHub Pages

- `asteroid-browser/` contains the complete project-path-safe browser bundle:
  Scramjet, the controller and service worker, the WebAssembly rewriter,
  locally bundled Libcurl and Epoxy transports, and all required notices.
- The Browser accepts Asteroid OS's short-lived Shards access handoff and can
  open either the full browser interface or an OS-launched web app target.
- Its 16-profile per-site compatibility engine learns and remembers the best
  working transport/header/rewriter combination for each host. These local site
  blueprints do not expose a user's browsing history to Supabase.
- The background-research bridge can gather live Wikipedia results and return
  sources to the Asteroid OS assistant without blocking the visible Browser.
- A bundled compatibility runtime is available automatically if the normal
  Scramjet runtime cannot load.
- Relative asset paths and the included `.nojekyll` files allow the complete OS
  and Browser service worker to run from a GitHub Pages project subdirectory.
- All Browser-facing labels, internal Asteroid storage keys, and release
  validators use Asteroid Browser naming only.
- When Asteroid Browser opens a secure `ixl.com` page, it automatically loads
  the bundled IXL Answer Helper supplied for this release. The helper receives
  persistent isolated settings and uses the Browser's Libcurl/Epoxy transport
  for its Mistral, Supabase-cache, and other userscript HTTP requests. It is not
  injected into any non-IXL website.

## Supabase Auth security upgrade

- Asteroid OS now verifies every restored session against Supabase Auth's
  `/auth/v1/user` endpoint before the desktop can open.
- The returned Supabase user ID must match the profile's `auth_user_id`; cached
  usernames and user-editable metadata are not authorization evidence.
- Expiring sessions refresh early and the refreshed token is verified before
  it is saved.
- Temporary network failures and verification timeouts preserve the saved
  session; only a definitive Supabase Auth rejection signs the user out.
- New accounts are created by a Supabase Edge Function through the official
  server-only Supabase Auth Admin API. The old browser-callable direct-table
  signup RPC is disabled.
- Lock-screen password checks are performed by Supabase Auth.
- Log Out and Switch User revoke the current Supabase session before clearing
  the device copy.
- Legacy token mirrors in `localStorage`, `window.name`, and browser history
  are migrated and removed. See `SUPABASE_SECURITY.md`.

## MessageX media change

- New MessageX photos, videos, drawings, and voice/audio files upload to the
  owner's laptop instead of the Supabase `chat-media` bucket.
- Supabase continues to store accounts, chats, message rows, realtime events,
  the permanent media gateway, and the laptop's online heartbeat. It remains
  the only account and password authority.
- Existing Supabase media URLs are unchanged and still render.
- New media rows use a logical `messagex-laptop:` path. MessageX resolves that
  path through `https://messagex-media.asteroid-messagex.workers.dev`, the
  permanent Cloudflare gateway stored in `media_storage_config`.
- This build pins authenticated media requests to that exact HTTPS origin. It
  still reads Supabase for the laptop's online state and timestamps, but a
  different registry hostname cannot receive a user's bearer session.
- The permanent gateway has a private Cloudflare Workers VPC binding to the
  persistent `messagex-storage` named tunnel. There is no rotating
  `trycloudflare.com` hostname and no inbound router or Windows Firewall rule.
- Both Supabase gateway fields publish the same permanent HTTPS address. Old
  message rows do not need rewriting when Windows or the tunnel process restarts.
- A media request now retries the Supabase registry lookup and gateway request
  together up to three times (immediately, after 750 ms, and after 2 seconds).
  This prevents a short connector reconnect from aborting a photo with the raw
  browser `Failed to fetch` error.
- Uploads require a valid Supabase Auth session and membership in the target
  MessageX chat.
- Downloads also require the signed-in Supabase user to be a current member of
  the chat. MessageX requests a short-lived signed URL through an authenticated
  POST ticket request; raw laptop media paths are not public. The legacy GET
  ticket route remains available for older clients.
- Username/password login remains handled by Supabase Auth. The laptop receives
  only the resulting access token and never receives or saves a password.
- Protected media can be forwarded only after the laptop verifies the sender is
  a member of both the source and destination chats.

The laptop service is a media-only backend and does not host this `index.html`.
Open or host Asteroid OS separately. MessageX discovers the current media API
through Supabase, and the laptop server supports the required cross-origin
browser requests. The desktop MessageX app, Contacts, MessageX notifications,
and Comet all use the same validated client embedded in this complete Asteroid
OS build. See `LAPTOP_STORAGE.md`.

## Restart persistence

The normal-user supervisor starts automatically after the Windows owner signs
in. It restarts the server, the same named-tunnel connector, and the Supabase
heartbeat without hosting Asteroid OS itself. Supabase retains accounts, chats,
messages, and Asteroid OS sync data; the laptop retains media under
`storage\chat-media`. A reboot replaces only disposable process IDs; the tunnel
UUID and permanent `workers.dev` gateway address do not change. See
`RESTART_RECOVERY_TEST.json` for the forced recovery validation performed on
2026-08-06.

## Preserved performance behavior

Revamped AI remains enabled by default. The existing performance pass keeps:

- performance-first automatic mode on phones and weak devices;
- no startup decoding or warm-up of the bundled intent model on lite devices;
- no large local language model on lite devices;
- instant action presentation by default on lite devices;
- delayed/idle Notes memory synchronization;
- Asteroid Browser for live web knowledge;
- Gemini API as optional cloud computing; and
- silent MessageX sending with an exact top confirmation banner.

## Direct MessageX usernames

Comet does not require recipients to be saved in Asteroid Contacts. Commands
such as `message henry saying hello` and `message @henry saying hello` send
directly to the MessageX username `henry`. Asteroid Contacts remain optional and
can provide friendly display-name aliases.
