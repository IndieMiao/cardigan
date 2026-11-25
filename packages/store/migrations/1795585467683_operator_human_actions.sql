-- C-742: human actions name who performs them (`executor`: owner | operator).
-- No schema change; the migration hook backfills open, non-system actions that
-- rule 1 addresses to the host operator (title starting with `张良：` or an
-- operator-only reason) so they leave the owner's push and Needs You count.
SELECT 1;
