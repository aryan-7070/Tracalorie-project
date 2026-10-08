-- =============================================================================
-- Recipes: user-owned meal templates + ingredients. Logging a recipe creates a
-- meal entry in `items` using totals multiplied by the servings logged. This
-- keeps stats/badges unchanged — the log is just another meal.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- recipes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipes (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  servings    NUMERIC(4,2) NOT NULL DEFAULT 1
                CHECK (servings BETWEEN 0.1 AND 200),

  -- Cached totals so list queries can avoid scanning ingredients repeatedly.
  -- Updated when ingredients change; kept as integers (rounded kcal) and
  -- one-decimal grams, matching item macro columns.
  calories    INTEGER NOT NULL DEFAULT 0,
  protein_g   NUMERIC(6,1) NOT NULL DEFAULT 0,
  carbs_g     NUMERIC(6,1) NOT NULL DEFAULT 0,
  fat_g       NUMERIC(6,1) NOT NULL DEFAULT 0,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT recipes_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_recipes_user_created
  ON recipes (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- recipe_ingredients
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id            SERIAL PRIMARY KEY,
  recipe_id     INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  amount        NUMERIC(6,2) NOT NULL DEFAULT 1
                  CHECK (amount BETWEEN 0 AND 10000),
  calories      INTEGER NOT NULL DEFAULT 0,
  protein_g     NUMERIC(6,1) NOT NULL DEFAULT 0,
  carbs_g       NUMERIC(6,1) NOT NULL DEFAULT 0,
  fat_g         NUMERIC(6,1) NOT NULL DEFAULT 0,

  CONSTRAINT recipe_ing_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_recipe
  ON recipe_ingredients (recipe_id);

DROP TRIGGER IF EXISTS trg_recipes_updated_at ON recipes;
CREATE TRIGGER trg_recipes_updated_at BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
