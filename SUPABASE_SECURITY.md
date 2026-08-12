# Asteroid OS Supabase security

Security build: `asteroid-os-supabase-verified-session-2026-08-05`

Asteroid OS and MessageX use the same hosted Supabase Auth identity. Passwords
are submitted over HTTPS to Supabase. Asteroid OS receives a short-lived access
token and a rotating refresh token; the laptop media service receives only the
access token attached to an authorized media request.

## Authentication guarantees in this build

- A password sign-in is completed by Supabase Auth, not by comparing a local
  password value.
- Account creation calls the `messagex-create-account` Supabase Edge Function,
  which uses the server-only Supabase Auth Admin API. The service-role key never
  enters Asteroid OS, MessageX, GitHub Pages, or the laptop media service, and
  the obsolete browser-callable direct Auth-table RPC has no `anon` or
  `authenticated` execute permission.
- A saved session cannot unlock Asteroid OS merely because it contains an
  `access_token` string. The OS calls Supabase `/auth/v1/user` and requires an
  authentic user response.
- The verified Supabase user ID must match `profiles.auth_user_id`. The OS no
  longer falls back to a username stored in editable user metadata when it
  decides whether a session may start the desktop.
- The account profile must be approved and not banned.
- Refreshes are attempted before the access token expires, and the refreshed
  access token is verified with Supabase before it is stored.
- Network outages, 5xx responses, and verification timeouts preserve the saved
  session for a later retry. Only a definitive Supabase Auth rejection clears
  it.
- Lock-screen password verification uses Supabase Auth again and requires the
  same verified user/profile relationship.
- Log Out and Switch User call Supabase's local-session logout endpoint before
  deleting the browser copy of the session.

## Session storage

The durable session remains in Asteroid OS's application storage so a user can
remain signed in on that device. A per-tab `sessionStorage` mirror supports
Android/local-document reload behavior. Older builds copied the full session
into `localStorage`, `window.name`, and browser history; this build migrates an
existing session once and removes those extra copies. It never writes new
tokens to those three locations.

Static browser apps cannot create `HttpOnly` cookies by themselves. Any script
that executes in the Asteroid OS origin could still access browser-managed
tokens, so this build should be served only from a trusted copy and should not
be combined with untrusted scripts or browser extensions.

## Authorization

Supabase Row Level Security remains the authorization boundary for Asteroid OS
sync data, profiles, chats, messages, game invites, and votes. Identity is
derived from `auth.uid()` and the profile row linked by `auth_user_id`; it is
not derived from user-editable metadata. The laptop media server independently
calls Supabase Auth for the bearer token and checks current membership in
`chats.members` before upload, ticket creation, forwarding, or download.

`media_storage_config` intentionally permits read-only access so a signed-out
client can discover whether the media endpoint exists. Only the heartbeat
backend can change it.

## Remaining operational controls

- Keep the laptop patched, plugged in, and protected by the Windows account.
- Do not add a Supabase secret or `service_role` key to `index.html`.
- Use a unique password that is not reused on email, school, banking, or social
  accounts.
- The current Supabase project security advisor reports that leaked-password
  protection is disabled. That dashboard control should be enabled if the plan
  supports it. MessageX uses internal username identities rather than real
  email ownership, so email password recovery is not available.
- This is authenticated and access-controlled messaging, not guaranteed
  end-to-end encryption.

Run `node validate-asteroid-auth-hardening.mjs` and
`node validate-inline-scripts.mjs` after changing `index.html`.
