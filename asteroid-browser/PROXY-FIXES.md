# Asteroid Browser repair summary

Build date: 2026-07-24

## Critical runtime repairs

- Repaired invalid JavaScript regular-expression syntax in all four Scramjet bundles. The broken generated `(?i:url)` syntax prevented standards-compliant JavaScript engines from parsing the files.
- Made CSS `url()` and `@import URL()` rewriting case-insensitive without using unsupported inline regex modifiers.
- Disabled stale source-map references on the repaired generated bundles.
- Hardened service-worker installation, activation, route checks, invalid-response handling, and failed-route responses.

## Transport and site-compatibility repairs

- Fixed the request semaphore so queued requests cannot exceed the configured concurrency limit.
- Preserved repeated response headers, including multiple `Set-Cookie` headers required by many login flows.
- Added bounded request timeouts and external abort handling.
- Prevented automatic retries and Wisp failover from replaying non-idempotent requests such as form submissions and POST requests.
- Reworked WebSocket fallback to try transports sequentially with an opening timeout and stale-callback protection.
- Sanitized response download filenames and retained repeated headers while modifying content disposition.
- Disabled the built-in blocker by default to avoid unnecessary page breakage; users can enable it in Settings.

## Browser and storage repairs

- Replaced non-standard `window.find()` usage with a standards-based text-node and Range implementation.
- Added safe Web Storage reads/writes, corrupted-data recovery, numeric clamping, URL validation, and bookmark/history sanitization.
- Debounced metrics persistence instead of writing synchronously on every request.
- Moved uploaded wallpapers to IndexedDB, added transaction-completion checks, and handled quota/storage failures.
- Added a standards-compatible `CSS.escape()` fallback.
- Improved complete-reset behavior for caches, cookies, Web Storage, and IndexedDB.
- Updated the MessageX proxy slash-command key handler to use `keydown`, respect the slash-command setting, and avoid duplicate sends during IME composition.

## Validation completed

- Every `.js` and `.mjs` file passes `node --check`.
- Both HTML entry points have no duplicate IDs, no missing local asset references, and no inline-script parse errors.
- Every DOM ID referenced by `p/app.mjs` exists in `p/index.html`.
- Unit smoke tests passed for concurrency enforcement, repeated `Set-Cookie` preservation, corrupted-setting recovery, CSS escaping, and transport timeout behavior.
- Static-host MIME checks passed for JavaScript modules, the service worker, and WebAssembly.
- `SHA256SUMS.txt` was regenerated and verified after the repairs.

## Structural limitations

No service-worker proxy can guarantee every website. DRM/EME media, aggressive anti-bot systems, device-attestation flows, some OAuth/popup flows, and browser APIs that cannot be virtualized may still fail. The proxy also requires HTTPS (or localhost), a reachable Wisp server, and the full `p/` directory structure.

## Narrow-device settings UI

- The Settings button remains available in the compact browser toolbar.
- The fixed desktop settings sidebar becomes a horizontally scrollable section bar at 760px and below.
- Settings content uses the full remaining viewport width and safe-area-aware vertical scrolling.
- Cards, switches, icon buttons, language selection, shortcut rows, long URLs, and destructive-action buttons now wrap without horizontal overflow.
- Active settings sections scroll into view automatically on narrow screens.
- Touch targets are enlarged while the desktop settings layout remains unchanged.


## Libcurl-primary transport update

- Set `@mercuryworkshop/libcurl-transport` 2.0.5 as the default HTTP and WebSocket transport.
- Kept the bundled `@mercuryworkshop/epoxy-transport` 3.0.1 as the automatic backup.
- Added version-pinned jsDelivr and unpkg Libcurl bundle sources with startup timeout handling.
- If Libcurl cannot load or initialize, Asteroid Browser starts on Epoxy instead of failing completely.
- Safe GET/HEAD requests and WebSockets can fail over from Libcurl to Epoxy; non-idempotent submissions are not replayed automatically.

## Automatic site-compatibility learning

- Added a 16-combination compatibility matrix covering ad blocking, WebRTC behavior, smart request headers, and media range requests.
- New sites begin with the balanced profile and automatically move to the next untested profile only when the page remains blank, shows a fatal proxy/network error, stays on an anti-bot challenge, or fails most requests without rendering usable content.
- The first profile that settles successfully is saved per normalized hostname and reused on later visits.
- Sites are marked `INCOMPATIBLE` only after all 16 combinations fail for the current matrix version.
- Added a narrow-device-compatible Compatibility settings section with live progress, learned-site summaries, per-site retesting, result clearing, and a master learning switch.
- Compatibility results remain local because no trusted server reporting endpoint is configured in this build.
- Added stale-retry generation checks so an automatic retry cannot override a newer user navigation.
- Added unit coverage for winner learning, winner reuse, final incompatible verdicts, blank/fatal/challenge detection, learning-disabled behavior, and stale retry cancellation.
