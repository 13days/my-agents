function cliResultError(result) {
  if (!result.is_error && !String(result.subtype || '').startsWith('error_')) return '';
  const errors = (Array.isArray(result.errors) ? result.errors : []).map(error => typeof error === 'string' ? error : error?.message || JSON.stringify(error)).filter(Boolean);
  if (typeof result.result === 'string' && result.result.trim()) errors.push(result.result.trim());
  return [...new Set(errors)].join('\n') || `Claude Code 执行失败（${result.subtype || 'unknown'}）`;
}
module.exports = { cliResultError };
