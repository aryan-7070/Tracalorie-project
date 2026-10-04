import { useEffect, useMemo, useState } from 'react';
import { request } from '../services/api';
import '../styles/TrackerPage.css';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const toYYYYMMDD = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function TrackerPage({ user, onLogout, onShowSecurity, showSecurity }) {
  const [meals, setMeals] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [foods, setFoods] = useState([]);
  const [foodTab, setFoodTab] = useState('meal');
  const [stats, setStats] = useState(null);
  const [limit, setLimit] = useState(2000);
  const [limitInput, setLimitInput] = useState(2000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mealFilter, setMealFilter] = useState('');
  const [workoutFilter, setWorkoutFilter] = useState('');

  useEffect(() => { setLimitInput(limit); }, [limit]);

  const syncError = (err) => setError(err?.message || 'Something went wrong');

  const refreshFoods = () => {
    request('/api/foods')
      .then(setFoods)
      .catch(syncError);
  };

  const refreshStats = () => {
    request('/api/stats')
      .then(setStats)
      .catch(syncError);
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      request('/api/items'),
      request('/api/foods'),
      request('/api/stats'),
    ])
      .then(([items, foodsData, statsData]) => {
        setMeals(items.meals || []);
        setWorkouts(items.workouts || []);
        setLimit(items.calorieLimit || 2000);
        setFoods(foodsData || []);
        setStats(statsData || null);
      })
      .catch((err) => setError(err?.message || 'Unable to load data'))
      .finally(() => setLoading(false));
  }, []);

  const caloriesConsumed = useMemo(() => meals.reduce((t, m) => t + m.calories, 0), [meals]);
  const caloriesBurned   = useMemo(() => workouts.reduce((t, w) => t + w.calories, 0), [workouts]);
  const totalCalories    = useMemo(() => caloriesConsumed - caloriesBurned, [caloriesConsumed, caloriesBurned]);
  const remaining        = useMemo(() => limit - totalCalories, [limit, totalCalories]);
  const progressPercent  = useMemo(
    () => limit <= 0 ? 0 : clamp((totalCalories / limit) * 100, 0, 100),
    [limit, totalCalories]
  );

  const addItem = async (type, name, calories) => {
    if (!name || !calories) return;
    try {
      const item = await request('/api/items', {
        method: 'POST',
        body: { type, name, calories: Number(calories) },
      });
      type === 'meal' ? setMeals(p => [item, ...p]) : setWorkouts(p => [item, ...p]);
      refreshFoods();
      refreshStats();
    } catch (err) { syncError(err); }
  };

  const deleteItem = async (id, type) => {
    try {
      await request(`/api/items/${id}`, { method: 'DELETE' });
      type === 'meal'
        ? setMeals(p => p.filter(i => i.id !== id))
        : setWorkouts(p => p.filter(i => i.id !== id));
      refreshStats();
    } catch (err) { syncError(err); }
  };

  const deleteFood = async (id) => {
    try {
      await request(`/api/foods/${id}`, { method: 'DELETE' });
      setFoods(p => p.filter(f => f.id !== id));
    } catch (err) { syncError(err); }
  };

  const resetAll = async () => {
    if (!window.confirm('Reset will delete all meals and workouts. Continue?')) return;
    try {
      await request('/api/items', { method: 'DELETE' });
      setMeals([]);
      setWorkouts([]);
      refreshStats();
    } catch (err) { syncError(err); }
  };

  const updateLimit = async (val) => {
    if (val === '' || val === null || val === undefined) return;
    const parsed = Number(val);
    if (Number.isNaN(parsed) || parsed < 0) return;
    try {
      await request('/api/user/limit', { method: 'PATCH', body: { calorieLimit: parsed } });
      setLimit(parsed);
      refreshStats();
    } catch (err) { syncError(err); }
  };

  const filteredMeals    = meals.filter(m => m.name.toLowerCase().includes(mealFilter.toLowerCase()));
  const filteredWorkouts = workouts.filter(w => w.name.toLowerCase().includes(workoutFilter.toLowerCase()));

  const mealSuggestions    = foods.filter(f => f.type === 'meal');
  const workoutSuggestions = foods.filter(f => f.type === 'workout');
  const tabFoods            = foods.filter(f => f.type === foodTab).slice(0, 6);
  const todayStr            = toYYYYMMDD(new Date());

  return (
    <div className="tr-root">

      {/* ── Navbar ── */}
      <nav className="tr-nav">
        <div className="tr-nav-brand">
          <div className="tr-nav-icon">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M10 3L13 8H17L14 12L15.5 17L10 14L4.5 17L6 12L3 8H7L10 3Z" fill="white" />
            </svg>
          </div>
          <span className="tr-nav-name">Tracalorie</span>
        </div>
        <div className="tr-nav-right">
          <span className="tr-nav-user">
            Logged in as <strong>{user.username}</strong>
          </span>
          {onShowSecurity && (
            <button
              className="tr-btn tr-btn-ghost"
              onClick={onShowSecurity}
              aria-expanded={Boolean(showSecurity)}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 1.5 3 3.5v4c0 3 2.1 5.6 5 7 2.9-1.4 5-4 5-7v-4L8 1.5Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                <path d="M5.75 8.25 7.5 10l2.75-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Security
            </button>
          )}
          <button className="tr-btn tr-btn-ghost" onClick={resetAll}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M2 8a6 6 0 1 0 1.5-4M2 4v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Reset
          </button>
          <button className="tr-btn tr-btn-danger" onClick={onLogout}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M10 8H3M6 5l-3 3 3 3M10 3h2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Logout
          </button>
        </div>
      </nav>

      <div className="tr-body">

        {error && (
          <div className="tr-alert">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="7" stroke="#ef4444" strokeWidth="1.4" />
              <path d="M8 5v3.5M8 10.5v.5" stroke="#ef4444" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            {error}
          </div>
        )}

        {/* ── Hero stat cards ── */}
        <div className="tr-hero">
          <div className="tr-stat-card accent-green">
            <div className="tr-stat-label">Net Calories</div>
            <div className={`tr-stat-value ${remaining < 0 ? 'danger' : ''}`}>{totalCalories}</div>
            <div className="tr-stat-sub">of {limit} limit</div>
          </div>
          <div className="tr-stat-card accent-blue">
            <div className="tr-stat-label">Consumed</div>
            <div className="tr-stat-value">{caloriesConsumed}</div>
            <div className="tr-stat-sub">{meals.length} meal{meals.length !== 1 ? 's' : ''}</div>
          </div>
          <div className="tr-stat-card accent-orange">
            <div className="tr-stat-label">Burned</div>
            <div className="tr-stat-value">{caloriesBurned}</div>
            <div className="tr-stat-sub">{workouts.length} workout{workouts.length !== 1 ? 's' : ''}</div>
          </div>
          <div className="tr-stat-card accent-red">
            <div className="tr-stat-label">Remaining</div>
            <div className={`tr-stat-value ${remaining < 0 ? 'danger' : 'success'}`}>{remaining}</div>
            <div className="tr-stat-sub">{remaining < 0 ? 'over limit' : 'to goal'}</div>
          </div>
        </div>

        {/* ── Progress bar ── */}
        <div className="tr-progress-wrap">
          <div className="tr-progress-header">
            <span className="tr-progress-title">Daily Progress</span>
            <span className="tr-progress-pct">{Math.round(progressPercent)}%</span>
          </div>
          <div className="tr-progress-track">
            <div
              className={`tr-progress-bar ${remaining < 0 ? 'bad' : 'ok'}`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* ── This Week panel ── */}
        {stats && (
          <div className="tr-panel tr-stats-panel">
            <div className="tr-panel-head">
              <span className="tr-panel-title">Your Week</span>
              <div className="tr-streak-chips">
                <span className="tr-chip">Streak {stats.streak.current} day{stats.streak.current === 1 ? '' : 's'}</span>
                <span className="tr-chip tr-chip-dim">Best {stats.streak.best}</span>
              </div>
            </div>
            <div className="tr-panel-body">
              <div className="tr-week-chart">
                {stats.days.map((day) => (
                  <DayBar key={day.date} day={day} isToday={day.date === todayStr} />
                ))}
              </div>

              <div className="tr-week-foot">
                <span>
                  Week: <b>{stats.week.consumed}</b> consumed · <b>{stats.week.burned}</b> burned ·{' '}
                  <b className={stats.week.net < 0 ? 'danger' : ''}>{stats.week.net}</b> net
                </span>
                <span className={stats.week.daysUnderLimit >= 5 ? 'tr-goal-ok' : ''}>
                  {stats.week.daysUnderLimit}/7 days under limit
                </span>
              </div>

              {stats.bestDay && (
                <div className="tr-bestday">
                  Best day this week: <b>{stats.bestDay.label}</b> — stayed{' '}
                  <b>{stats.bestDay.underBy} kcal</b> under your limit
                </div>
              )}

              <div className="tr-badges">
                {stats.badges.map((badge) => (
                  <BadgeTile key={badge.id} badge={badge} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Two-column body ── */}
        <div className="tr-cols">

          {/* Left — forms */}
          <div>
            <div className="tr-panel">
              <div className="tr-panel-head">
                <span className="tr-panel-title">Calorie Limit</span>
              </div>
              <div className="tr-panel-body">
                <p className="tr-section-label">Set daily goal</p>
                <div className="tr-limit-row">
                  <input
                    type="number"
                    className="tr-input"
                    value={limitInput}
                    min={0}
                    onChange={(e) => setLimitInput(e.target.value)}
                    onBlur={() => updateLimit(limitInput)}
                  />
                  <button className="tr-btn tr-btn-primary" onClick={() => updateLimit(limitInput)}>
                    Save
                  </button>
                </div>
              </div>
            </div>

            <div className="tr-panel tr-panel-form">
              <div className="tr-panel-head">
                <span className="tr-panel-title">Add Meal</span>
                <span className="tr-badge tr-badge-meal">Meal</span>
              </div>
              <div className="tr-panel-body">
                <ItemForm
                  label="Meal"
                  suggestions={mealSuggestions}
                  onAdd={(name, cal) => addItem('meal', name, cal)}
                />
              </div>
            </div>

            <div className="tr-panel tr-panel-form">
              <div className="tr-panel-head">
                <span className="tr-panel-title">Add Workout</span>
                <span className="tr-badge tr-badge-workout">Workout</span>
              </div>
              <div className="tr-panel-body">
                <ItemForm
                  label="Workout"
                  suggestions={workoutSuggestions}
                  onAdd={(name, cal) => addItem('workout', name, cal)}
                />
              </div>
            </div>

            {/* My Foods library */}
            <div className="tr-panel">
              <div className="tr-panel-head tr-foods-head">
                <span className="tr-panel-title">My Foods</span>
                <div className="tr-tabs">
                  <button
                    className={`tr-tab ${foodTab === 'meal' ? 'active' : ''}`}
                    onClick={() => setFoodTab('meal')}
                  >
                    Meals
                  </button>
                  <button
                    className={`tr-tab ${foodTab === 'workout' ? 'active' : ''}`}
                    onClick={() => setFoodTab('workout')}
                  >
                    Workouts
                  </button>
                </div>
              </div>
              <div className="tr-list-body tr-foods-body">
                {loading ? (
                  <div className="tr-spinner-wrap"><div className="tr-spinner" /></div>
                ) : tabFoods.length === 0 ? (
                  <div className="tr-empty">
                    No saved {foodTab}s yet. Add one above and it'll be saved here for instant re-use.
                  </div>
                ) : (
                  tabFoods.map((food) => (
                    <div className="tr-item" key={food.id}>
                      <span className="tr-item-name">{food.name}</span>
                      <div className="tr-item-right">
                        <span className={`tr-badge tr-badge-${food.type}`}>{food.calories} kcal</span>
                        <button
                          className="tr-add-mini"
                          onClick={() => addItem(food.type, food.name, food.calories)}
                          title="Quick add today"
                        >
                          +
                        </button>
                        <button className="tr-del-btn" onClick={() => deleteFood(food.id)} title="Remove from library">
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right — lists */}
          <div>
            <div className="tr-panel">
              <div className="tr-list-head">
                <span className="tr-panel-title">Meals</span>
                <input
                  type="text"
                  className="tr-filter-input"
                  placeholder="Search meals…"
                  value={mealFilter}
                  onChange={(e) => setMealFilter(e.target.value)}
                />
              </div>
              <div className="tr-list-body">
                {loading ? (
                  <div className="tr-spinner-wrap"><div className="tr-spinner" /></div>
                ) : filteredMeals.length === 0 ? (
                  <div className="tr-empty">No meals yet — add one above.</div>
                ) : (
                  filteredMeals.map((meal) => (
                    <ItemRow
                      key={meal.id}
                      item={meal}
                      type="meal"
                      onDelete={() => deleteItem(meal.id, 'meal')}
                    />
                  ))
                )}
              </div>
            </div>

            <div className="tr-panel">
              <div className="tr-list-head">
                <span className="tr-panel-title">Workouts</span>
                <input
                  type="text"
                  className="tr-filter-input"
                  placeholder="Search workouts…"
                  value={workoutFilter}
                  onChange={(e) => setWorkoutFilter(e.target.value)}
                />
              </div>
              <div className="tr-list-body">
                {loading ? (
                  <div className="tr-spinner-wrap"><div className="tr-spinner" /></div>
                ) : filteredWorkouts.length === 0 ? (
                  <div className="tr-empty">No workouts yet — add one above.</div>
                ) : (
                  filteredWorkouts.map((workout) => (
                    <ItemRow
                      key={workout.id}
                      item={workout}
                      type="workout"
                      onDelete={() => deleteItem(workout.id, 'workout')}
                    />
                  ))
                )}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

function ItemForm({ label, suggestions = [], onAdd }) {
  const [name, setName] = useState('');
  const [calories, setCalories] = useState('');
  const [showSug, setShowSug] = useState(false);

  const matches = useMemo(
    () =>
      suggestions
        .filter((s) => s.name.toLowerCase().includes(name.trim().toLowerCase()))
        .slice(0, 5),
    [suggestions, name]
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim() || !calories) return;
    onAdd(name.trim(), Number(calories));
    setName('');
    setCalories('');
    setShowSug(false);
  };

  const pick = (s) => {
    setName(s.name);
    setCalories(s.calories);
    setShowSug(false);
  };

  return (
    <div className="tr-form">
      <form onSubmit={handleSubmit}>
        <div className="tr-form-row">
          <input
            type="text"
            className="tr-input name"
            placeholder={`${label} name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={() => setShowSug(true)}
            onBlur={() => setShowSug(false)}
            required
          />
          <input
            type="number"
            className="tr-input cal"
            placeholder="kcal"
            value={calories}
            onChange={(e) => setCalories(e.target.value)}
            required
            min={0}
          />
          <button className="tr-btn tr-btn-primary" type="submit">
            Add
          </button>
        </div>
      </form>

      {showSug && name.trim() && matches.length > 0 && (
        <div className="tr-suggest">
          {matches.map((s) => (
            <button
              type="button"
              key={s.id}
              className="tr-suggest-item"
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
            >
              <span className="tr-suggest-name">{s.name}</span>
              <span className="tr-suggest-cal">{s.calories} kcal</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemRow({ item, type, onDelete }) {
  return (
    <div className="tr-item">
      <span className="tr-item-name">{item.name}</span>
      <div className="tr-item-right">
        <span className={`tr-badge tr-badge-${type}`}>{item.calories} kcal</span>
        <button className="tr-del-btn" onClick={onDelete} title="Delete">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function DayBar({ day, isToday }) {
  const height = day.limit > 0 ? clamp((day.consumed / day.limit) * 100, 3, 100) : 3;
  return (
    <div className={`tr-daycol ${day.underLimit ? 'under' : 'over'} ${isToday ? 'today' : ''}`}>
      <div className="tr-daynet">{day.net}</div>
      <div className="tr-daytrack">
        <div className="tr-daybar" style={{ height: `${height}%` }} />
      </div>
      <div className="tr-daylabel">{day.label}</div>
      {isToday && <div className="tr-daytoday">today</div>}
    </div>
  );
}

function BadgeTile({ badge }) {
  return (
    <div
      className={`tr-badge-tile ${badge.earned ? 'earned' : 'locked'}`}
      title={badge.desc}
    >
      <div className="tr-badge-icon">
        <BadgeIcon icon={badge.icon} />
      </div>
      <div className="tr-badge-name">{badge.name}</div>
      <div className="tr-badge-desc">{badge.desc}</div>
    </div>
  );
}

function BadgeIcon({ icon }) {
  const paths = {
    star:   ['M10 2l2.5 5 5.5.5-4 4 1 5.5L10 14l-5 3 1-5.5-4-4 5.5-.5z'],
    bolt:   ['M9 2l-6 8h5l-1 8 6-10h-5z'],
    target: ['M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM10 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'],
    flame:  ['M12 2c1 4-3 5-3 9a3 3 0 0 0 6 0c2 2 3 4 3 7a8 8 0 1 1-16 0c0-5 3.5-7 5-10 .6 2 1.5 3 3 3 0-3-1-6 2-9z'],
    flag:   ['M5 20V3.5M5 4c4-2 7 2 11 0v8c-4 2-7-2-11 0'],
    trophy: ['M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 3M17 6h3a3 3 0 0 1-3 3'],
    shield: ['M12 2l7 3v6c0 5-3 8-7 11-4-3-7-6-7-11V5zM9 12l2 2 4-4'],
  };
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
      {(paths[icon] || paths.star).map((d, i) => (
        <path key={i} d={d} fill="currentColor" fillRule={icon === 'target' ? 'evenodd' : 'nonzero'} />
      ))}
    </svg>
  );
}