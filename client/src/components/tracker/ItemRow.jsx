import { useState } from 'react';

/**
 * One logged entry. Doubles as an inline editor: the pencil swaps the row for
 * name/kcal inputs, and save sends a partial PATCH (only the changed fields
 * would be sent by the caller).
 */
export default function ItemRow({ item, type, onDelete, onEdit }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [calories, setCalories] = useState(item.calories);

  const save = async () => {
    const trimmed = name.trim();
    const kcal = Number(calories);
    if (!trimmed || Number.isNaN(kcal)) return;
    const ok = await onEdit({ name: trimmed, calories: kcal });
    if (ok !== false) setEditing(false);
  };

  if (editing) {
    return (
      <div className="tr-item tr-item-editing">
        <input
          type="text"
          className="tr-input tr-edit-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Entry name"
        />
        <input
          type="number"
          className="tr-input tr-edit-cal"
          value={calories}
          onChange={(e) => setCalories(e.target.value)}
          aria-label="Calories"
          min={0}
        />
        <div className="tr-item-right">
          <button className="tr-btn tr-btn-primary tr-btn-mini" onClick={save} title="Save">
            Save
          </button>
          <button
            className="tr-btn tr-btn-ghost tr-btn-mini"
            onClick={() => {
              setName(item.name);
              setCalories(item.calories);
              setEditing(false);
            }}
            title="Cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tr-item">
      <span className="tr-item-name">{item.name}</span>
      <div className="tr-item-right">
        <span className={`tr-badge tr-badge-${type}`}>{item.calories} kcal</span>
        <button
          className="tr-del-btn"
          onClick={() => {
            setName(item.name);
            setCalories(item.calories);
            setEditing(true);
          }}
          title="Edit"
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path
              d="M8.5 1.5 10.5 3.5 4 10H2V8l6.5-6.5ZM7.5 2.5l2 2"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button className="tr-del-btn" onClick={onDelete} title="Delete">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
