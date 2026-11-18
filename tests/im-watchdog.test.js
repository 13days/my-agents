const test = require('node:test');
const assert = require('node:assert/strict');
const { createImWatchdog } = require('../core/im-watchdog');

test('the watchdog reconnects bots, alerts the owner on lasting problems from a working bot, and reports recovery once', async () => {
  const sent = [], phases = { cli_timi_x: 'connected', cli_extra_x: 'error' }; let starts = 0, machineOnline = true;
  const bots = { bots: () => Object.entries(phases).map(([appId, phase], i) => ({ appId, phase, enabled: true, primary: i === 0 })),
    bot: appId => ({ start: async () => { starts++; }, notify: async (to, text) => { if (phases[appId] !== 'connected') throw new Error('offline'); sent.push({ appId, to, text }); } }) };
  const dog = createImWatchdog({ bots, owner: () => 'ou_owner', machines: () => [{ id: 'mac', label: 'Mac', online: machineOnline, panelOnline: true }], boundMachines: () => ['mac'], log: {} });
  await dog.check(); assert.equal(sent.length, 0, 'one bad check is not alerted'); assert.equal(starts, 1, 'tries to reconnect');
  machineOnline = false; await dog.check();
  assert.equal(sent.length, 1); assert.equal(sent[0].appId, 'cli_timi_x'); assert.match(sent[0].text, /cli_extra_x/);
  await dog.check(); assert.equal(sent.length, 2, 'machine problem alerted after its second check'); assert.match(sent[1].text, /Mac/);
  await dog.check(); assert.equal(sent.length, 2, 'no repeated alerts');
  phases.cli_extra_x = 'connected'; machineOnline = true; await dog.check();
  assert.equal(sent.length, 3); assert.match(sent[2].text, /已恢复/);
  const followers = createImWatchdog({ bots, leadership: () => false, owner: () => 'ou_owner' });
  assert.equal((await followers.check()).skipped, true);
});
