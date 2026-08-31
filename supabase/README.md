# Database migration model

`migrations/00000000000000_production_schema_baseline.sql` is an immutable snapshot of the production application schema captured on 2026-08-30. It includes tables, constraints, indexes, functions, triggers, RLS, policies, grants, comments, sequence ownership, and realtime publication membership.

The remaining active files are intentionally empty markers matching every row in the production Supabase migration ledger. They prevent the CLI from replaying historical changes already represented by the baseline. Never put SQL into a marker.

The former incremental files are retained under `legacy-migrations/` for archaeology only. They are not a runnable chain and must never be copied back into `migrations/`.

For every new database change:

1. Create a new 14-digit timestamped migration after the latest marker.
2. Put only the forward change in that file; never edit the baseline or a marker.
3. Run `npm run check:migrations`.
4. Validate the migration on a clean Supabase branch before production.

The production ledger entries folded into the snapshot are recorded in `baseline-migration-ledger.json`. Update it only as part of an intentional baseline recapture. Migrations created after the baseline remain executable SQL and must use the exact version recorded by production.
