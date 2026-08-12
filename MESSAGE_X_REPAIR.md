# MessageX v0.99.3 repair record

## Frontend/backend contract

The embedded MessageX build is:

- Build: `messagex-v0993-full-integrity-repair-2026-08-01`
- Backend contract: `v0993-chat-lifecycle-call-guards`

The validated standalone source is included as `messagex-v0.99.3.html`. Its bytes match the MessageX source embedded in Asteroid OS.

## Chat lifecycle

MessageX now distinguishes active chats from preserved historical chats:

- `hidden_for` hides a chat for one user without deleting it for everyone.
- `is_archived`, `archived_at`, and `archive_reason` preserve one-member historical conversations safely.
- Archived conversations are read-only.
- Reopening an existing direct chat removes the current user from `hidden_for`.
- Empty invalid legacy conversations were removed only after a private snapshot was written.

The private snapshot table is `private.messagex_integrity_archive`; it is not exposed to browser roles.

## Calling model

Direct calls use append-only validated signals. Browser users can read their call sessions but cannot directly rewrite session state. Group calls use separate least-privilege policies for sessions, participants, and signals.

Important invariants:

- A signal must be sent as the authenticated MessageX user.
- Direct-call participants must match a valid two-member direct chat.
- A group-call participant may update only their own participant row.
- Only the host can end the entire group call.
- A participant leaving sends `leave`; it does not terminate everyone’s call.
- Internal trigger flags are null-safe and default to disabled.

## Maintenance

`messagex_run_maintenance()` is authenticated, rate-limited to one effective run per five minutes, and performs bounded cleanup of:

- expired typing rows;
- stale ringing/active direct calls;
- stale group calls and participants;
- direct and group call signals older than 24 hours.

## Production migrations

See `SUPABASE_MIGRATIONS_APPLIED.txt` for the exact v0.99.3 migration names applied to the connected production project.

## Shared-project advisories

The connected Supabase project also contains unrelated legacy applications. Their tables and advisor findings were not modified as part of this MessageX repair, avoiding changes to unrelated projects.


## v0.99.4 performance pass

MessageX startup was changed from several serial Supabase requests to one compact bootstrap request. Cached chat metadata is used for the first visible render, while current data refreshes immediately in the background. Noncritical polling and maintenance are deferred until after first paint.


## v0.99.13 bundled loader

Asteroid OS now starts the packaged MessageX build in a hidden singleton iframe during the black-and-white boot screen. The remembered standalone loader also uses this exact packaged build and no longer reads the cloud `app_version.html` field.
