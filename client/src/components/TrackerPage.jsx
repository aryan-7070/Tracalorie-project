import { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../services/api';
import { toYYYYMMDD } from './tracker/helpers';
import DayNav from './tracker/DayNav';
import HeroStats from './tracker/HeroStats';
import ItemForm from './tracker/ItemForm';
import EntryList from './tracker/EntryList';
import FoodLibrary from './tracker/FoodLibrary';
import WeekPanel from './tracker/WeekPanel';
import '../styles/TrackerPage.css';

/**
 * Tracker shell: owns all server state and the selected day, and composes the
 * presentational panels. Every entry is loaded for `selectedDate` via
 * `GET /api/items?date=`, so totals, lists and forms all speak about one day.
 */
export default function TrackerPage({ user, onLogout, onShowSecurity, showSecurity }) {
  const [selectedDate, setSelectedDate] = useState(() => toYYYYMMDD(new Date()));
  const [meals, setMeals] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [foods, setFoods] = useState([]);
  const [foodTab, setFoodTab] = useState('meal');
  const [stats, setStats] = useState(null);
  const [limit, setLimit] = useState(2000);
  const [limitInput, setLimitInput] = useState(2000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  // Load one day's entries. Kept as a callback so the date effect below only
  // re-runs when the day actually changes.
  const loadDay = useCallback((date) => {
    setLoading(true);
    setError(null);
    return request(`/api/items?date=${date}`)
      .then((items) => {
        setMeals(items.meals || []);
        setWorkouts(items.workouts || []);
        setLimit(items.calorieLimit || 2000);
      })
      .catch((err) => setError(err?.message || 'Unable to load data'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadDay(selectedDate);
  }, [selectedDate, loadDay]);

  // One-time bootstrap: foods library + week stats; the day itself is loaded
  // by the effect above, so it is not fetched twice here.
  useEffect(() => {
    Promise.all([request('/api/foods'), request('/api/stats')])
      .then(([foodsData, statsData]) => {
        setFoods(foodsData || []);
        setStats(statsData || null);
      })
      .catch((err) => setError(err?.message || 'Unable to load data'));
  }, []);

  const caloriesConsumed = useMemo(() => meals.reduce((t, m) => t + m.calories, 0), [meals]);
  const caloriesBurned = useMemo(() => workouts.reduce((t, w) => t + w.calories, 0), [workouts]);

  const addItem = async (type, name, calories) => {
    if (!name || !calories) return;
    try {
      const item = await request('/api/items', {
        method: 'POST',
        body: { type, name, calories: Number(calories), entryDate: selectedDate },
      });
      type === 'meal' ? setMeals((p) => [item, ...p]) : setWorkouts((p) => [item, ...p]);
      refreshFoods();
      refreshStats();
    } catch (err) { syncError(err); }
  };

  const editItem = async (id, type, fields) => {
    try {
      const updated = await request(`/api/items/${id}`, { method: 'PATCH', body: fields });
      const apply = (list) => list.map((i) => (i.id === id ? { ...i, ...updated } : i));
      type === 'meal' ? setMeals(apply) : setWorkouts(apply);
      return true;
    } catch (err) {
      syncError(err);
      return false;
    }
  };

  const deleteItem = async (id, type) => {
    try {
      await request(`/api/items/${id}`, { method: 'DELETE' });
      type === 'meal'
        ? setMeals((p) => p.filter((i) => i.id !== id))
        : setWorkouts((p) => p.filter((i) => i.id !== id));
      refreshStats();
    } catch (err) { syncError(err); }
  };

  const deleteFood = async (id) => {
    try {
      await request(`/api/foods/${id}`, { method: 'DELETE' });
      setFoods((p) => p.filter((f) => f.id !== id));
    } catch (err) { syncError(err); }
  };

  const clearDay = async () => {
    const label = selectedDate === toYYYYMMDD(new Date()) ? 'today' : selectedDate;
    if (!window.confirm(`Delete all entries for ${label}?`)) return;
    try {
      await request(`/api/items?date=${selectedDate}`, { method: 'DELETE' });
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

  const mealSuggestions = foods.filter((f) => f.type === 'meal');
  const workoutSuggestions = foods.filter((f) => f.type === 'workout');

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
          <button className="tr-btn tr-btn-ghost" onClick={clearDay}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M2 8a6 6 0 1 0 1.5-4M2 4v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Clear day
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

        <DayNav selectedDate={selectedDate} onChange={setSelectedDate} />

        <HeroStats
          consumed={caloriesConsumed}
          burned={caloriesBurned}
          limit={limit}
          mealCount={meals.length}
          workoutCount={workouts.length}
        />

        <WeekPanel stats={stats} selectedDate={selectedDate} />

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

            <FoodLibrary
              foods={foods}
              loading={loading}
              foodTab={foodTab}
              onTabChange={setFoodTab}
              onQuickAdd={(food) => addItem(food.type, food.name, food.calories)}
              onDelete={deleteFood}
            />
          </div>

          {/* Right — lists */}
          <div>
            <EntryList
              title="Meals"
              type="meal"
              items={meals}
              loading={loading}
              emptyHint="No meals yet for this day — add one on the left."
              onDelete={deleteItem}
              onEdit={editItem}
            />

            <EntryList
              title="Workouts"
              type="workout"
              items={workouts}
              loading={loading}
              emptyHint="No workouts yet for this day — add one on the left."
              onDelete={deleteItem}
              onEdit={editItem}
            />
          </div>

        </div>
      </div>
    </div>
  );
}
