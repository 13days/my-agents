const { createRelayClient } = require('../node/relay');

// Advertise only proxy-scoped capabilities. Provider keys and CLI logins stay
// with their owner; trusted cluster links carry requests to that owner's proxy.
function createAccountPool({ accounts, codex, identity, peers, relayClient = createRelayClient }) {
  const sources = new Map();
  let updating = null;
  const catalog = () => ({ claude: accounts.sharedCatalog(), codex: codex.catalog() });
  function install() {
    accounts.setShared([...sources].flatMap(([node, source]) => (source.catalog.claude?.accounts || []).map(account => ({
      id: `cluster:${node}:${account.id}`, name: `${account.name} · ${source.label}`, sourceNode: node, shared: true,
      enabled: true, authType: 'bearer', token: source.catalog.claude.token, url: source.url,
      delegateAccount: account.id, modelMap: account.modelMap || {}, env: {},
    }))));
  }
  async function refresh() {
    if (updating) return updating;
    updating = (async () => {
      const connected = peers();
      for (const id of sources.keys()) if (!connected.some(peer => peer.id === id)) sources.delete(id);
      await Promise.all(connected.map(async ({ id, label, peer }) => {
        try {
          const data = await peer.call('accounts.catalog', {}, { timeout: 3000 });
          const previous = sources.get(id);
          const relay = previous?.peer === peer ? previous.relay : relayClient(peer);
          sources.set(id, { catalog: data, label: label || id, peer, relay, url: await relay.url() });
        } catch { sources.delete(id); }
      }));
      install();
    })().finally(() => { updating = null; });
    return updating;
  }
  function codexRoute(mode, sessionId = '', excluded = []) {
    const local = codex.catalog();
    const candidates = [
      ...(local.modes?.includes(mode) ? [{ id: identity().id, label: identity().label, token: local.token }] : []),
      ...[...sources].filter(([, source]) => source.catalog.codex?.modes?.includes(mode)).map(([id, source]) => ({ id, label: source.label, url: source.url, token: source.catalog.codex.token })),
    ];
    for (let i = candidates.length - 1; i >= 0; i--) if (excluded.includes(candidates[i].id)) candidates.splice(i, 1);
    if (!candidates.length) return null;
    // Keep each CLI thread on the same account while the available set is stable.
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    let hash = 0; for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return candidates[hash % candidates.length];
  }
  function status() {
    const local = catalog();
    return [{ ...identity(), local: true, claudeAccounts: local.claude.accounts.length, codexModes: local.codex.modes }, ...[...sources].map(([id, source]) => ({ id, label: source.label, local: false, claudeAccounts: source.catalog.claude?.accounts?.length || 0, codexModes: source.catalog.codex?.modes || [] }))];
  }
  return { catalog, refresh, codexRoute, status };
}
module.exports = { createAccountPool };
