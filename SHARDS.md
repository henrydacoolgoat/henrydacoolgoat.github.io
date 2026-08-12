# Shards

Shards are the authenticated account currency for Asteroid OS.

## Wallet and transfers

- Every approved Supabase-authenticated Asteroid account has one wallet.
- Shards are whole-number virtual credits.
- Users can view only their own wallet and ledger.
- Transfers are executed through `asteroid_transfer_shards`; the browser cannot directly edit balances.
- A transfer creates matching outgoing and incoming ledger entries with one shared reference ID.
- Both wallets are locked during a transfer to prevent race conditions and double spending.
- One transfer is limited to 1–1,000,000 Shards and balances cannot become negative.

## Earning

- `asteroid_claim_daily_shards` securely awards 5 Shards once per UTC day.
- `asteroid_start_shard_reward` creates or resumes an authenticated prototype provider claim.
- Prototype ads require a server-verified 20-second wait and award 10 Shards.
- Prototype surveys validate and store the three answers in Supabase and award 25 Shards.
- Limits are one 5-Shard daily reward, two completed ad rewards, and one completed survey reward per UTC day.
- Reward claims expire, are account-bound, and cannot be completed twice.
- The external provider field is currently `local_prototype`.

## Security

- Wallet, transaction, daily-reward, reward-claim, and survey-response tables use row-level security.
- Authenticated users receive read access only to their own rows.
- All balance changes happen inside `SECURITY DEFINER` RPCs that verify `auth.uid()`, account approval, bans, limits, claim ownership, and current wallet state.
- An authenticated administrator is still required for `asteroid_shards_admin_adjust`.

Shards are not cash, cryptocurrency, or redeemable for money.

## Username-change purchase

- System Settings → Account offers **Change username** for **300 Shards**.
- The client confirms the current password with Supabase Auth and calls `asteroid_change_username` using the freshly issued authenticated token.
- The server locks the profile and wallet, checks availability and balance, moves all supported username ownership references in one transaction, updates the internal Supabase Auth email, deducts the price, and writes a `purchase` ledger entry.
- The old visible username is removed and cannot be reused. The server retains only its one-way hash for anti-impersonation protection.
- If any part of the migration fails, the transaction rolls back, including the Shards deduction.
