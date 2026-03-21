import { useEffect, useMemo, useState } from 'react';
import { request } from '../services/api';
// import './TrackerPage.css';
import '../styles/TrackerPage.css';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export default function TrackerPage({ user, onLogout }) {
  const [meals, setMeals] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [limit, setLimit] = useState(2000);
  const [limitInput, setLimitInput] = useState(2000);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mealFilter, setMealFilter] = useState('');
  const [workoutFilter, setWorkoutFilter] = useState('');

  useEffect(() => { setLimitInput(limit); }, [limit]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    request('/api/items')
      .then((data) => {
        setMeals(data.meals || []);
        setWorkouts(data.workouts || []);
        setLimit(data.calorieLimit || 2000);
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

  const syncError = (err) => setError(err?.message || 'Something went wrong');

  const addItem = async (type, name, calories) => {
    if (!name || !calories) return;
    try {
      const item = await request('/api/items', {
        method: 'POST',
        body: { type, name, calories: Number(calories) },
      });
      type === 'meal' ? setMeals(p => [item, ...p]) : setWorkouts(p => [item, ...p]);
    } catch (err) { syncError(err); }
  };

  const deleteItem = async (id, type) => {
    try {
      await request(`/api/items/${id}`, { method: 'DELETE' });
      type === 'meal'
        ? setMeals(p => p.filter(i => i.id !== id))
        : setWorkouts(p => p.filter(i => i.id !== id));
    } catch (err) { syncError(err); }
  };

  const resetAll = async () => {
    if (!window.confirm('Reset will delete all meals and workouts. Continue?')) return;
    try {
      await request('/api/items', { method: 'DELETE' });
      setMeals([]);
      setWorkouts([]);
    } catch (err) { syncError(err); }
  };

  const updateLimit = async (val) => {
    if (val === '' || val === null || val === undefined) return;
    const parsed = Number(val);
    if (Number.isNaN(parsed) || parsed < 0) return;
    try {
      await request('/api/user/limit', { method: 'PATCH', body: { calorieLimit: parsed } });
      setLimit(parsed);
    } catch (err) { syncError(err); }
  };

  const filteredMeals    = meals.filter(m => m.name.toLowerCase().includes(mealFilter.toLowerCase()));
  const filteredWorkouts = workouts.filter(w => w.name.toLowerCase().includes(workoutFilter.toLowerCase()));

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

            <div className="tr-panel">
              <div className="tr-panel-head">
                <span className="tr-panel-title">Add Meal</span>
                <span className="tr-badge tr-badge-meal">Meal</span>
              </div>
              <div className="tr-panel-body">
                <ItemForm label="Meal" onAdd={(name, cal) => addItem('meal', name, cal)} />
              </div>
            </div>

            <div className="tr-panel">
              <div className="tr-panel-head">
                <span className="tr-panel-title">Add Workout</span>
                <span className="tr-badge tr-badge-workout">Workout</span>
              </div>
              <div className="tr-panel-body">
                <ItemForm label="Workout" onAdd={(name, cal) => addItem('workout', name, cal)} />
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

function ItemForm({ label, onAdd }) {
  const [name, setName] = useState('');
  const [calories, setCalories] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim() || !calories) return;
    onAdd(name.trim(), Number(calories));
    setName('');
    setCalories('');
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="tr-form-row">
        <input
          type="text"
          className="tr-input name"
          placeholder={`${label} name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
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
