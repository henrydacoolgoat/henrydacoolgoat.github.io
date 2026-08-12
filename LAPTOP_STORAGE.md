# Laptop-backed MessageX storage

## No administrator access required

The MessageX storage server runs as the normal Windows user. It does not install
a Windows service, request elevation, add a firewall rule, or modify the router.
It binds only to `127.0.0.1:8787`, and `cloudflared` creates an outbound tunnel.
The hidden launcher is in the current user's Windows Startup folder and starts
after that user signs in. A matching current-user `HKCU\...\Run` entry provides
a second no-admin sign-in trigger; the supervisor's single-instance lock makes
the duplicate launch harmless. A limited-user scheduled watchdog runs every
five minutes after sign-in and relaunches the supervisor if it is missing.

The currently installed service lives at:

`C:\Users\henry_x0k28gt\Downloads\New folder (4)\local-storage`

## Opening Asteroid OS

The laptop service does not serve this package's `index.html`; it is a media-only
backend. Open or host Asteroid OS separately. The MessageX client discovers the
permanent media gateway through the singleton Supabase row
`public.media_storage_config`, and the media server allows the required
cross-origin browser requests.

This works when `index.html` is hosted on GitHub Pages: GitHub serves the app
over HTTPS, `https://messagex-media.asteroid-messagex.workers.dev` is also HTTPS,
and both Supabase and the permanent gateway answer the required CORS preflights.
Do not hard-code a Quick Tunnel hostname into the GitHub Pages copy.

The Cloudflare Worker domain is stable. Its private `LAPTOP_VPC` binding targets
the persistent `messagex-storage` named-tunnel UUID and forwards requests to
`127.0.0.1:8787` through Cloudflare's network. The connector makes only an
outbound connection, so this setup needs no router port forwarding, public IP,
Windows service, firewall exception, or administrator access. No account-less
Quick Tunnel or random `trycloudflare.com` hostname is used. The no-admin
connector uses HTTP/2 edge transport because this network showed intermittent
QUIC/UDP timeouts; the public client URL is unchanged.

On recovery, the heartbeat keeps both `endpoint_url` and `public_gateway_url`
set to the permanent Worker address and updates the online state and timestamps.
MessageX re-reads the singleton registry when needed. Existing message rows keep
logical `messagex-laptop:` paths, so a Windows or tunnel-process restart never
requires rewriting old messages.

The packaged client retries both the registry lookup and the media request in a
single three-attempt boundary. It never inserts the Supabase message row for a
new photo until the laptop has returned and MessageX has validated the stored
media path. Recipients use the same resilient path when requesting a protected
media ticket. The current client uses an authenticated JSON POST ticket request,
which follows the cross-network request shape already proven by media uploads;
the server retains its legacy GET ticket route for older builds.

The packaged MessageX client pins authenticated media requests to
`https://messagex-media.asteroid-messagex.workers.dev`. Supabase must advertise
that origin and report the laptop online before the client sends a request. This
prevents a changed registry hostname from receiving a user's bearer token.

## Upload behavior

- The MessageX client uploads one `file` field as `multipart/form-data` over HTTP; the server also keeps accepting the previous raw-media request shape for older clients.
- Media requests use five bounded attempts so a brief tunnel reconnection or Cloudflare edge failure does not immediately fail a send.
- Maximum file size: 100 MB.
- Accepted content: common image, video, and audio MIME types.
- Rejected content: HTML, JavaScript, SVG, executables, and non-media files.
- Required access: a live MessageX Supabase Auth session and membership in the
  destination chat.
- Username/password authentication is performed by Supabase Auth using
  MessageX's internal username identity. The laptop sees only a bearer access
  token, never the password.
- Downloads require a one-hour signed media ticket issued only after the laptop
  verifies the Supabase username is currently in that chat's `members` array.
- Direct-chat media is available only to the members of that direct chat.
  Group-chat media is available only to the members of that group.
- Unsigned, modified, or expired `/media/...` URLs return HTTP 403.
- Forwarding protected media grants the destination chat access only after the
  user is verified as a member of both chats.
- New bytes: `local-storage\storage\chat-media`.
- Existing Supabase Storage objects: left unchanged.

The laptop must remain plugged in, signed in, awake, online, and ventilated.
Closing the lid and ordinary sleep/hibernate timers are disabled on AC and
battery. Critical-battery protection is preserved, so a drained battery can
still stop the server. Never operate the closed laptop in a bag or enclosed
space.

Back up `local-storage\storage\chat-media` regularly. New laptop-backed uploads
do not have another media copy unless a separate backup is made. Back up the
local `config\media-signing-secret.txt` with it.

Supabase retains accounts, chats, message rows, chat membership, and Asteroid OS
sync records across laptop restarts. The laptop retains its media directory and
signing secret. Files under `run\` are disposable runtime state and are rebuilt
automatically. Automatic startup occurs after this Windows user signs in; a true
pre-login Windows service would require administrator privileges and is
intentionally not installed.
