const RETRYABLE = new Set([401,402,403,408,429,500,502,503,504,529]);
const retryableStatus = status => RETRYABLE.has(Number(status));
function cooldownSeconds(status, retryAfter, now = Date.now()) {
  const seconds = Number(retryAfter), date = typeof retryAfter === 'string' ? Date.parse(retryAfter) : NaN;
  if (retryAfter !== undefined && Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 900);
  if (Number.isFinite(date) && date > now) return Math.min((date - now) / 1000, 900);
  return status === 429 || status === 402 ? 60 : status === 401 || status === 403 ? 300 : 15;
}
module.exports = { retryableStatus, cooldownSeconds };
