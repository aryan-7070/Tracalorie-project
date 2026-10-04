'use strict';

/**
 * Week dashboard aggregation.
 *
 * Day bucketing uses `items.entry_date` (the local calendar day the entry
 * belongs to) rather than `created_at`. Without it, a user in UTC+13 logging
 * dinner at 11am local time would have the meal attributed to the previous day,
 * silently corrupting streaks and badges.
 *
 * All computation happens in a single SQL pass and in-process over at most 120
 * days, so there is no N+1 query pattern and no unbounded memory growth.
 */

const express = require('express');
const { query } = require('../db');
const { requireAuth, asyncHandler } = require('../middleware/auth');
const { heavyLimiter } = require('../middleware/rateLimit');

const WINDOW_DAYS = 120;
const WEEK_DAYS = 7;

const BADGES = [
  { id: 'first-log',   icon: 'star',   name: 'First Steps',   desc: 'Log your first meal or workout' },
  { id: 'first-sweat', icon: 'bolt',   name: 'Sweat Session', desc: 'Log your first workout' },
  { id: 'on-track',    icon: 'target', name: 'On Track',      desc: 'Stay under your limit today' },
  { id: 'streak-3',    icon: 'flag',   name: '3-Day Streak',  desc: 'Stay under your limit 3 days in a row' },
  { id: 'streak-7',    icon: 'trophy', name: '7-Day Streak',  desc: 'Stay under your limit 7 days in a row' },
  { id: 'goal-keeper', icon: 'shield', name: 'Goal Keeper',   desc: 'Under your limit on 5+ of the last 7 days' },
  { id: 'burn-1000',   icon: 'flame',  name: 'Week Warrior',  desc: 'Burn 1,000+ calories in a week' },
];

const router = express.Router();

router.use(requireAuth);

/** Today in the user's own timezone, as a `YYYY-MM-DD` key. */
function todayForUser(timezone) {
  // Intl with an invalid zone throws; fall back to UTC rather than 500.
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }
}

function addDays(dateKey, delta) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function weekdayLabel(dateKey) {
  return new Date(`${dateKey}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

router.get(
  '/',
  heavyLimiter,
  asyncHandler(async (req, res) => {
    const [userResult, itemsResult] = await Promise.all([
      query('SELECT calorie_limit, timezone FROM users WHERE id = $1', [req.user.id]),
      query(
        `SELECT entry_date::text AS day,
                SUM(CASE WHEN type = 'meal' THEN calories ELSE 0 END)::int AS consumed,
                SUM(CASE WHEN type = 'workout' THEN calories ELSE 0 END)::int AS burned,
                COUNT(*)::int AS item_count
         FROM items
         WHERE user_id = $1
           AND entry_date >= (now() AT TIME ZONE 'UTC')::date - $2::int
         GROUP BY entry_date
         ORDER BY entry_date ASC`,
        [req.user.id, WINDOW_DAYS]
      ),
    ]);

    const limit = userResult.rows[0]?.calorie_limit ?? 2000;
    const timezone = userResult.rows[0]?.timezone || 'UTC';

    const dayMap = new Map();
    for (const row of itemsResult.rows) {
      dayMap.set(row.day, {
        consumed: Number(row.consumed) || 0,
        burned: Number(row.burned) || 0,
        count: Number(row.item_count) || 0,
      });
    }

    const isUnder = (key) => {
      const d = dayMap.get(key);
      return !!d && d.count > 0 && d.consumed - d.burned <= limit;
    };

    const today = todayForUser(timezone);

    const days = [];
    for (let i = WEEK_DAYS - 1; i >= 0; i -= 1) {
      const key = addDays(today, -i);
      const data = dayMap.get(key) || { consumed: 0, burned: 0, count: 0 };
      const net = data.consumed - data.burned;
      days.push({
        date: key,
        label: weekdayLabel(key),
        consumed: data.consumed,
        burned: data.burned,
        net,
        hasLogs: data.count > 0,
        underLimit: data.count > 0 && net <= limit,
        limit,
      });
    }

    const week = {
      consumed: days.reduce((t, d) => t + d.consumed, 0),
      burned: days.reduce((t, d) => t + d.burned, 0),
      net: days.reduce((t, d) => t + d.net, 0),
      daysUnderLimit: days.filter((d) => d.underLimit).length,
    };
    week.avgNet = Math.round(week.net / WEEK_DAYS);

    // Current streak, anchored to today or yesterday so an unlogged morning does
    // not read as a broken streak.
    let current = 0;
    let cursor = today;
    if (!dayMap.has(cursor)) cursor = addDays(cursor, -1);
    while (isUnder(cursor)) {
      current += 1;
      cursor = addDays(cursor, -1);
    }

    let best = 0;
    let run = 0;
    for (let i = WINDOW_DAYS - 1; i >= 0; i -= 1) {
      const key = addDays(today, -i);
      if (isUnder(key)) {
        run += 1;
        best = Math.max(best, run);
      } else {
        run = 0;
      }
    }

    let bestDay = null;
    for (const d of days) {
      if (d.hasLogs && d.underLimit) {
        const margin = limit - d.net;
        if (!bestDay || margin > bestDay.underBy) {
          bestDay = { date: d.date, label: d.label, underBy: margin };
        }
      }
    }

    const hasAnyLogs = itemsResult.rows.some((r) => Number(r.item_count) > 0);
    const hasWorkout = itemsResult.rows.some((r) => Number(r.burned) > 0);
    const todayUnder = days[days.length - 1].underLimit;

    const earned = {
      'first-log': hasAnyLogs,
      'first-sweat': hasWorkout,
      'on-track': todayUnder,
      'streak-3': current >= 3,
      'streak-7': current >= 7,
      'goal-keeper': week.daysUnderLimit >= 5,
      'burn-1000': week.burned >= 1000,
    };

    return res.json({
      days,
      week,
      streak: { current, best },
      bestDay,
      badges: BADGES.map((b) => ({ ...b, earned: Boolean(earned[b.id]) })),
      timezone,
    });
  })
);

module.exports = router;
