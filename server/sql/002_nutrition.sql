-- =============================================================================
-- Nutrition profile: macros on entries, body weight and a protein goal.
--
-- Everything here is additive and nullable so existing rows and older API
-- clients keep working: a row with NULL protein/carbs/fat simply has no macro
-- breakdown, and stats COALESCE the sums to zero.
--
-- Stored as NUMERIC(6,1) (one decimal place) because grams are frequently
-- fractional but nobody needs more precision than a tenth.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- items
-- -----------------------------------------------------------------------------
ALTER TABLE items ADD COLUMN IF NOT EXISTS protein_g NUMERIC(6,1);
ALTER TABLE items ADD COLUMN IF NOT EXISTS carbs_g   NUMERIC(6,1);
ALTER TABLE items ADD COLUMN IF NOT EXISTS fat_g     NUMERIC(6,1);

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_protein_range;
ALTER TABLE items ADD CONSTRAINT items_protein_range
  CHECK (protein_g IS NULL OR protein_g BETWEEN 0 AND 10000);

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_carbs_range;
ALTER TABLE items ADD CONSTRAINT items_carbs_range
  CHECK (carbs_g IS NULL OR carbs_g BETWEEN 0 AND 10000);

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_fat_range;
ALTER TABLE items ADD CONSTRAINT items_fat_range
  CHECK (fat_g IS NULL OR fat_g BETWEEN 0 AND 10000);

-- -----------------------------------------------------------------------------
-- foods (the saved library mirrors macros so a reused food keeps its profile)
-- -----------------------------------------------------------------------------
ALTER TABLE foods ADD COLUMN IF NOT EXISTS protein_g NUMERIC(6,1);
ALTER TABLE foods ADD COLUMN IF NOT EXISTS carbs_g   NUMERIC(6,1);
ALTER TABLE foods ADD COLUMN IF NOT EXISTS fat_g     NUMERIC(6,1);

ALTER TABLE foods DROP CONSTRAINT IF EXISTS foods_protein_range;
ALTER TABLE foods ADD CONSTRAINT foods_protein_range
  CHECK (protein_g IS NULL OR protein_g BETWEEN 0 AND 10000);

ALTER TABLE foods DROP CONSTRAINT IF EXISTS foods_carbs_range;
ALTER TABLE foods ADD CONSTRAINT foods_carbs_range
  CHECK (carbs_g IS NULL OR carbs_g BETWEEN 0 AND 10000);

ALTER TABLE foods DROP CONSTRAINT IF EXISTS foods_fat_range;
ALTER TABLE foods ADD CONSTRAINT foods_fat_range
  CHECK (fat_g IS NULL OR fat_g BETWEEN 0 AND 10000);

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
-- Body weight feeds the MET exercise formula (kcal = MET * kg * minutes / 60).
-- Like other health data it stays optional; without it the formula simply
-- cannot run and the client falls back to manual calories.
ALTER TABLE users ADD COLUMN IF NOT EXISTS body_weight_kg NUMERIC(5,1);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_body_weight_range;
ALTER TABLE users ADD CONSTRAINT users_body_weight_range
  CHECK (body_weight_kg IS NULL OR body_weight_kg BETWEEN 20 AND 500);

-- Daily protein target in grams, surfaced as a per-day progress bar. NULL
-- means "no goal set"; the UI then hides the bar rather than showing 0/none.
ALTER TABLE users ADD COLUMN IF NOT EXISTS protein_target_g INTEGER;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_protein_target_range;
ALTER TABLE users ADD CONSTRAINT users_protein_target_range
  CHECK (protein_target_g IS NULL OR protein_target_g BETWEEN 0 AND 2000);