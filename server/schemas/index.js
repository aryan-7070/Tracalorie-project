'use strict';

/**
 * Request schemas.
 *
 * Every value crossing the trust boundary is described here. Rules that exist
 * only in the client are duplicated here deliberately: client validation is a
 * usability feature, this is the control.
 *
 * `.strict()` on body schemas rejects unknown keys outright rather than
 * stripping them, so a client sending `{ role: "admin" }` gets a 422 naming the
 * offending field instead of silent success.
 */

const { z } = require('zod');
const config = require('../config/env');

/** Field names a client must never be able to set directly. */
const FORBIDDEN_USER_FIELDS = [
  'id',
  'role',
  'is_admin',
  'token_epoch',
  'password_hash',
  'failed_login_count',
  'locked_until',
  'status',
  'created_at',
];

const username = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  // Restrict to characters that are unambiguous in a URL and safe to render
  // anywhere without escaping. No leading/trailing whitespace after trim.
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, numbers, dot, underscore and hyphen')
  .refine((v) => !/^[._-]/.test(v), 'Username cannot start with a dot, underscore or hyphen');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email must be at most 254 characters') // RFC 5321 maximum
  .email('Enter a valid email address');

const password = z
  .string()
  .min(config.password.minLength, `Password must be at least ${config.password.minLength} characters`)
  .max(config.password.maxLength, `Password must be at most ${config.password.maxLength} characters`);

const identifier = z
  .string()
  .trim()
  .min(1, 'Enter your username or email')
  .max(254, 'Identifier is too long');

const entryType = z.enum(['meal', 'workout'], {
  errorMap: () => ({ message: 'Type must be "meal" or "workout"' }),
});

// Reject control characters, which are useless in a food name and can corrupt
// log output or downstream CSV export.
const itemName = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(200, 'Name must be at most 200 characters')
  .refine(
    (v) => !/[\u0000-\u001F\u007F]/.test(v),
    'Name cannot contain control characters'
  );

// Negative calories are allowed: workouts are entered as positive "burned"
// values in this app's model, so negatives are almost always a data-entry
// error. The database constraint is the final backstop.
const calories = z
  .number()
  .int('Calories must be a whole number')
  .min(-20000, 'Calories must be at least -20000')
  .max(20000, 'Calories must be at most 20000');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a valid date');

// Macronutrients in grams. One decimal place max (matches NUMERIC(6,1)
// columns); a client cannot smuggle extra precision that would silently
// round on write and drift the displayed totals.
const macro = z
  .number()
  .min(0, 'Grams cannot be negative')
  .max(10000, 'Grams must be at most 10000')
  .refine((v) => Math.abs(v * 10 - Math.round(v * 10)) < 1e-9, 'Grams must have at most one decimal');

/** Shared optional macro fields for item/food/ingredient bodies. */
const macroFields = {
  protein: macro.optional(),
  carbs: macro.optional(),
  fat: macro.optional(),
};

const uuid = z.string().uuid('Must be a valid identifier');

/** Positive integer id from a path segment. */
// Wrapped in an object: validate() parses `req.params` as a whole, which is
// `{ id: '3' }`. A bare primitive here would make z.coerce call
// `Number({ id: '3' })` and throw, so every route using
// `validate({ params: idParam })` would 500. See sessionUuidParam for the
// same shape.
const idParam = z.object({ id: z.coerce.number().int().positive().max(2_147_483_647) });

const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const register = z
  .object({
    username,
    email: email.optional(),
    password,
    displayName: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const login = z
  .object({
    // Accepts either username or email; resolved server-side.
    username: identifier,
    password: z.string().min(1, 'Password is required').max(config.password.maxLength),
  })
  .strict();

const changePassword = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(config.password.maxLength),
    newPassword: password,
  })
  .strict();

const updateProfile = z
  .object({
    displayName: z.string().trim().min(1).max(64).optional(),
    email: email.optional(),
    timezone: z
      .string()
      .max(64)
      .regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+$/, 'Enter a valid IANA timezone, e.g. Asia/Kolkata')
      .optional(),
    units: z.enum(['metric', 'imperial']).optional(),
    // Body weight in kg (whole or one decimal). Feeds the MET formula: the
    // server combines it with an exercise's MET value and the logged duration
    // to derive calories, so a client cannot dictate the number.
    bodyWeightKg: z.number().min(20, 'Body weight must be at least 20 kg').max(300, 'Body weight must be at most 300 kg').optional(),
    // Daily protein goal in grams for the macros progress bars.
    proteinTargetG: z.number().int().min(0, 'Protein target must be at least 0').max(2000, 'Protein target must be at most 2000 g').optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

const updateLimit = z
  .object({
    calorieLimit: z
      .number()
      .int('Calorie limit must be a whole number')
      .min(500, 'Calorie limit must be at least 500')
      .max(20000, 'Calorie limit must be at most 20000'),
  })
  .strict();

const createItem = z
  .object({
    type: entryType,
    name: itemName,
    calories,
    // Optional: lets a client backdate an entry using its own timezone rather
    // than the server's. Server timezone would misattribute late-evening logs.
    entryDate: isoDate.optional(),
    ...macroFields,
  })
  .strict();

const createFood = z
  .object({
    type: entryType,
    name: itemName,
    calories,
    ...macroFields,
  })
  .strict();

// GET /api/items: optional single-day filter. Without it the route returns the
// most recent entries (capped), with it the exact calendar day requested.
const itemListQuery = z.object({
  date: isoDate.optional(),
});

// -----------------------------------------------------------------------------
// Recipes
// -----------------------------------------------------------------------------
// Servings: NUMERIC(4,2) BETWEEN 0.1 AND 200 in the schema, so the same range
// is enforced here to fail fast with a field-level message.
const servings = z
  .number()
  .min(0.1, 'Servings must be at least 0.1')
  .max(200, 'Servings must be at most 200')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'Servings must have at most two decimals');

// Ingredient amount: matches recipe_ingredients.amount NUMERIC(6,2).
const ingredientAmount = z
  .number()
  .min(0, 'Amount cannot be negative')
  .max(10000, 'Amount must be at most 10000')
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'Amount must have at most two decimals');

const createRecipeIngredient = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Ingredient name is required')
      .max(120, 'Ingredient name must be at most 120 characters'),
    amount: ingredientAmount.optional(),
    calories,
    ...macroFields,
  })
  .strict();

// Recipe names are stored in a CHECK (char_length BETWEEN 1 AND 120) column,
// tighter than generic itemName's 200, so validate the real bound here.
const recipeName = itemName.refine((v) => v.length <= 120, 'Recipe name must be at most 120 characters');

const createRecipe = z
  .object({
    name: recipeName,
    description: z.string().trim().max(400).optional(),
    servings: servings.optional(),
    // Ingredients are optional on create (an empty recipe can be filled in
    // later), but a non-empty array must be well formed.
    ingredients: z.array(createRecipeIngredient).min(1, 'Add at least one ingredient').max(200).optional(),
  })
  .strict();

const updateRecipe = createRecipe.partial().strict();

// GET /api/foods/lookup?q= — external food search term. Min length keeps
// broad queries (single character) from hammering the upstream API.
const foodLookupQuery = z.object({
  q: z
    .string()
    .trim()
    .min(2, 'Search term must be at least 2 characters')
    .max(100, 'Search term must be at most 100 characters'),
});

const logRecipe = z
  .object({
    // Servings to log (may differ from the recipe's own serving count, e.g.
    // half a portion). Server scales cached totals by servingsLogged/servings.
    servings: z.number().min(0.25, 'Servings must be at least 0.25').max(200, 'Servings must be at most 200'),
    entryDate: isoDate.optional(),
  })
  .strict();

const sessionUuidParam = z.object({ id: uuid });

const auditQuery = pagination.extend({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const exportQuery = z.object({
  format: z.enum(['json', 'csv']).default('json'),
});

const deleteAccount = z
  .object({
    // Step-up authentication: destructive, irreversible-ish, and the classic
    // target of session-riding. Requiring the current password means a stolen
    // session alone cannot destroy an account.
    password: z.string().min(1, 'Password is required').max(config.password.maxLength),
    confirmation: z.literal('DELETE', {
      errorMap: () => ({ message: 'Type DELETE to confirm' }),
    }),
  })
  .strict();

const assertNoForbiddenFields = (payload) => {
  for (const key of FORBIDDEN_USER_FIELDS) {
    if (key in payload) {
      throw new Error(`Unexpected field: ${key}`);
    }
  }
};

module.exports = {
  FORBIDDEN_USER_FIELDS,
  assertNoForbiddenFields,
  register,
  login,
  changePassword,
  updateProfile,
  updateLimit,
  createItem,
  createFood,
  itemListQuery,
  foodLookupQuery,
  createRecipe,
  updateRecipe,
  logRecipe,
  createRecipeIngredient,
  idParam,
  sessionUuidParam,
  auditQuery,
  exportQuery,
  deleteAccount,
  pagination,
  // Exported for unit tests.
  _primitives: { username, email, password, itemName, calories, uuid },
};
