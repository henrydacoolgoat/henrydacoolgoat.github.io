# Shards earning prototype

The minimal Shards page has two Supabase-backed prototype provider flows and one fully working daily account reward.

## Watch ads

- No Google ad is loaded yet; the displayed sponsor content is local.
- Starting the flow creates an authenticated claim in Supabase.
- Supabase records the server-side availability time.
- The claim cannot complete before 20 seconds.
- Successful completion adds 10 Shards and creates a reward ledger entry.
- Maximum: two completed ad rewards per UTC day.

## Take surveys

- No external survey company is connected yet.
- The three local answers are sent to Supabase only when the user submits.
- Required answers and allowed choices are validated server-side.
- Successful submission stores the response, adds 25 Shards, and creates a reward ledger entry.
- Maximum: one completed survey reward per UTC day.

## Daily reward

- The authenticated user can claim **5 Shards** once per UTC day.
- `asteroid_claim_daily_shards` performs the claim server-side.
- A unique `(user_id, reward_date)` record and wallet row lock prevent duplicate awards across tabs or devices.
- A successful claim updates the wallet and lifetime-earned total and writes a `Daily reward` ledger entry.
- Apply `asteroid_v09910_daily_reward.sql` after the existing Shards migrations.
