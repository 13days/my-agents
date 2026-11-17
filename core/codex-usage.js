// Codex subscription quota as reported by the provider (the same source the CLI's /status uses).
// "Available" credentials say nothing about quota; this tells exhausted, revoked and healthy apart.
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

async function fetchUsage(headers, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  try {
    const response = await fetchImpl(USAGE_URL, { headers: { ...headers, originator: 'codex_cli_rs', 'user-agent': 'codex_cli_rs' }, signal: controller.signal });
    let body = null; try { body = await response.json(); } catch {}
    return { status: response.status, body };
  } finally { clearTimeout(timer); }
}

function summarizeUsage({ status, body }, at = Date.now()) {
  if (status === 401 || status === 403) return { checkedAt: at, status, revoked: true, code: String(body?.error?.code || '') };
  if (status !== 200 || !body || typeof body !== 'object') return { checkedAt: at, status, error: true };
  const limit = body.rate_limit || {}, primary = limit.primary_window || {}, secondary = limit.secondary_window || null;
  const percent = value => Math.max(0, Math.min(100, Number(value) || 0));
  return {
    checkedAt: at, status,
    workspace: String(body.account_id || ''), plan: String(body.plan_type || ''),
    usedPercent: percent(primary.used_percent), resetAt: Number(primary.reset_at) > 0 ? Number(primary.reset_at) * 1000 : 0,
    secondaryUsedPercent: secondary ? percent(secondary.used_percent) : null,
    limitReached: !!limit.limit_reached || limit.allowed === false,
    hasCredits: !!(body.credits?.has_credits || body.credits?.unlimited),
  };
}

module.exports = { USAGE_URL, fetchUsage, summarizeUsage };
