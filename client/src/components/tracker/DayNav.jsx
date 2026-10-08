import { addDays, dayLabel, toYYYYMMDD } from './helpers';

/**
 * Day navigator: prev / date picker / next.
 *
 * Bounds mirror the server's `resolveEntryDate` rules — no days after today,
 * nothing older than 365 days — so a navigation the UI offers can never be
 * rejected by the API.
 */
export default function DayNav({ selectedDate, onChange }) {
  const today = toYYYYMMDD(new Date());
  const minDate = addDays(today, -365);
  const atToday = selectedDate >= today;
  const atMin = selectedDate <= minDate;

  return (
    <div className="tr-daynav">
      <button
        className="tr-btn tr-btn-ghost"
        onClick={() => onChange(addDays(selectedDate, -1))}
        disabled={atMin}
        aria-label="Previous day"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="tr-daynav-center">
        <input
          type="date"
          className="tr-input tr-daynav-input"
          value={selectedDate}
          min={minDate}
          max={today}
          onChange={(e) => e.target.value && onChange(e.target.value)}
          aria-label="Select day"
        />
        <span className="tr-daynav-label">{dayLabel(selectedDate)}</span>
      </div>

      <button
        className="tr-btn tr-btn-ghost"
        onClick={() => onChange(addDays(selectedDate, 1))}
        disabled={atToday}
        aria-label="Next day"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {selectedDate !== today && (
        <button className="tr-btn tr-btn-ghost tr-daynav-today" onClick={() => onChange(today)}>
          Today
        </button>
      )}
    </div>
  );
}
