/** macOS stops freeing network connections at about 49.7 days up, so warn well before that. */
export const UPTIME_WARN_DAYS = 40;

/** @returns {string | null} the owner-facing warning, or null while the uptime is fine. */
export function uptimeWarning(uptimeSec, days = UPTIME_WARN_DAYS) {
  if (!Number.isFinite(uptimeSec) || uptimeSec < days * 86_400) return null;
  const up = Math.floor(uptimeSec / 86_400);
  return `The Mac has been up ${up} days. Restart it soon: past about 49.7 days macOS stops freeing network connections and nothing can reach GitHub.`;
}

/** The warning is about macOS's connection leak, so other platforms never get it. */
export const uptimeWarningOn = (platform, uptimeSec) => (platform === 'darwin' ? uptimeWarning(uptimeSec) : null);
