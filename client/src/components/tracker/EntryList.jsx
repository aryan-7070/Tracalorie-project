 import { useState } from 'react';
import ItemRow from './ItemRow';

/** Meals or workouts panel: search filter + rows (or loading/empty states). */
export default function EntryList({ title, type, items, loading, emptyHint, onDelete, onEdit }) {
  const [filter, setFilter] = useState('');
  const filtered = items.filter((i) => i.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="tr-panel">
      <div className="tr-list-head">
        <span className="tr-panel-title">{title}</span>
        <input
          type="text"
          className="tr-filter-input"
          placeholder={`Search ${title.toLowerCase()}…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="tr-list-body">
        {loading ? (
          <div className="tr-spinner-wrap"><div className="tr-spinner" /></div>
        ) : filtered.length === 0 ? (
          <div className="tr-empty">{emptyHint}</div>
        ) : (
          filtered.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              type={type}
              onDelete={() => onDelete(item.id, type)}
              onEdit={(fields) => onEdit(item.id, type, fields)}
            />
          ))
        )}
      </div>
    </div>
  );
}
