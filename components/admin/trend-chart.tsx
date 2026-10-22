import type { AdminTrendDay } from "@/lib/admin-analytics";
import styles from "@/app/admin/admin.module.css";

export function TrendChart({ days }: { days: AdminTrendDay[] }) {
  const max = Math.max(1, ...days.map((day) =>
    Math.max(day.smsInbound, day.voiceCalls, day.comicsCompleted)));
  const hasActivity = days.some((day) =>
    day.smsInbound || day.voiceCalls || day.comicsCompleted);

  if (!hasActivity) {
    return (
      <div className={styles.trendEmpty}>
        <strong>Waiting for the first story.</strong>
        <p>The last 14 days of SMS, calls, and finished comics will chart here.</p>
      </div>
    );
  }

  return (
    <div className={styles.trendPlot} role="img" aria-label={
      `Daily activity for ${days.length} days. ` +
      days.map((day) => `${day.day}: ${day.smsInbound} texts, ${day.voiceCalls} calls, ${day.comicsCompleted} comics`).join("; ")
    }>
      {days.map((day, index) => (
        <div className={styles.trendGroup} key={day.day}>
          <div className={styles.trendBarArea}>
            <span className={styles.smsBar} style={{ height: `${day.smsInbound / max * 100}%` }} />
            <span className={styles.voiceBar} style={{ height: `${day.voiceCalls / max * 100}%` }} />
            <span className={styles.comicBar} style={{ height: `${day.comicsCompleted / max * 100}%` }} />
          </div>
          <span className={styles.trendDay}>{index % 2 === 0 ? day.day.slice(5) : ""}</span>
        </div>
      ))}
    </div>
  );
}
