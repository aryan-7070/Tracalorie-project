import { useMemo, useState } from 'react';

/** Add-entry form with typeahead over the user's saved foods. */
export default function ItemForm({ label, suggestions = [], onAdd }) {
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
