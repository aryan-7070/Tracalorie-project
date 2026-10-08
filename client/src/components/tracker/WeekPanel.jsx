import { clamp } from './helpers';

/** Rolling 7-day chart, streaks, and badge tiles from /api/stats. */
export default function WeekPanel({ stats, selectedDate }) {
  if (!stats) return null;

  return (
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
            <DayBar key={day.date} day={day} selected={day.date === selectedDate} />
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
  );
}

function DayBar({ day, selected }) {
  const height = day.limit > 0 ? clamp((day.consumed / day.limit) * 100, 3, 100) : 3;
  return (
    <div className={`tr-daycol ${day.underLimit ? 'under' : 'over'} ${selected ? 'today' : ''}`}>
      <div className="tr-daynet">{day.net}</div>
      <div className="tr-daytrack">
        <div className="tr-daybar" style={{ height: `${height}%` }} />
      </div>
      <div className="tr-daylabel">{day.label}</div>
      {selected && <div className="tr-daytoday">selected</div>}
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
