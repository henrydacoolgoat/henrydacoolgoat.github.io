# Username Change

Location: **System Settings → Account**

Price: **300 Shards**

The operation uses the existing Supabase Auth account and never creates a replacement account. The immutable `auth.users.id` remains unchanged, so UUID-owned data continues to belong to the same person. Username-owned records are migrated atomically by the `asteroid_change_username` RPC.

## Data moved

- Supabase Auth internal email and username metadata
- Asteroid profile and display name when it matched the old username
- MessageX chat members, creators, hidden-state lists, messages, senders, read receipts, reactions, polls, typing state, direct calls, group calls, and signaling
- MessageX game invites, blocks, moderation/history references, proxy access/logging, and Terms acceptance identity fields
- BlueJ posts, comments, reactions, follows, and media ownership references
- Shards wallet, ledger, counterparties, reward claims, and survey data
- Supported legacy tables and structured JSON identity values
- Local per-user lock settings and Shards cache

Asteroid OS files, photos, notes, wallpaper, appearance, Comet data, and other local settings are not deleted or replaced; they remain in the same browser storage and continue under the new account name.

## Safety

- Requires a freshly confirmed password.
- Validates the same 2–24 character username format used at account creation.
- Rejects existing, reserved, and previously retired usernames.
- Locks the profile and wallet to prevent races.
- Deducts Shards only after the identity migration succeeds.
- Rolls back the entire operation on any error.
