-- C-132: decisions and human actions are numbered Q-n / H-n instead of q(n) / h(n).
-- The rewrite of stored values runs in migrate.ts (id-format-migration.ts), in
-- this same migration transaction; Store.open backs the database up first.
SELECT 1;
