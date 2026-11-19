-- NULL means no protocol evidence (including all pre-migration attempts).
ALTER TABLE bell_attempts ADD COLUMN review_wake TEXT
  CHECK (review_wake IS NULL OR json_valid(review_wake));
