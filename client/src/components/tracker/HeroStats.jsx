import { clamp } from './helpers';

/** Four headline numbers for the selected day plus the progress bar. */
export default function HeroStats({ consumed, burned, limit, mealCount, workoutCount }) {
  const net = consumed - burned;
  const remaining = limit - net;
  const progressPercent = limit <= 0 ? 0 : clamp((net / limit) * 100, 0, 100);

  return (
    <>
      <div className="tr-hero">
        <div className="tr-stat-card accent-green">
          <div className="tr-stat-label">Net Calories</div>
          <div className={`tr-stat-value ${remaining < 0 ? 'danger' : ''}`}>{net}</div>
          <div className="tr-stat-sub">of {limit} limit</div>
        </div>
        <div className="tr-stat-card accent-blue">
          <div className="tr-stat-label">Consumed</div>
          <div className="tr-stat-value">{consumed}</div>
          <div className="tr-stat-sub">{mealCount} meal{mealCount !== 1 ? 's' : ''}</div>
        </div>
        <div className="tr-stat-card accent-orange">
          <div className="tr-stat-label">Burned</div>
          <div className="tr-stat-value">{burned}</div>
          <div className="tr-stat-sub">{workoutCount} workout{workoutCount !== 1 ? 's' : ''}</div>
        </div>
        <div className="tr-stat-card accent-red">
          <div className="tr-stat-label">Remaining</div>
          <div className={`tr-stat-value ${remaining < 0 ? 'danger' : 'success'}`}>{remaining}</div>
          <div className="tr-stat-sub">{remaining < 0 ? 'over limit' : 'to goal'}</div>
        </div>
      </div>

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
    </>
  );
}
