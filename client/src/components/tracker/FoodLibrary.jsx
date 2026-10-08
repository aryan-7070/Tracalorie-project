/** Saved-foods library with meal/workout tabs and one-tap quick add. */
export default function FoodLibrary({ foods, loading, foodTab, onTabChange, onQuickAdd, onDelete }) {
  const tabFoods = foods.filter((f) => f.type === foodTab).slice(0, 6);

  return (
    <div className="tr-panel">
      <div className="tr-panel-head tr-foods-head">
        <span className="tr-panel-title">My Foods</span>
        <div className="tr-tabs">
          <button
            className={`tr-tab ${foodTab === 'meal' ? 'active' : ''}`}
            onClick={() => onTabChange('meal')}
          >
            Meals
          </button>
          <button
            className={`tr-tab ${foodTab === 'workout' ? 'active' : ''}`}
            onClick={() => onTabChange('workout')}
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
                  onClick={() => onQuickAdd(food)}
                  title="Quick add to selected day"
                >
                  +
                </button>
                <button className="tr-del-btn" onClick={() => onDelete(food.id)} title="Remove from library">
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
  );
}
