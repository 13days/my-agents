const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionHint } = require('../node/connection-hint');
const interfaces = { utun1: [{ address: '10.99.0.1', family: 'IPv4' }], lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], en0: [{ address: '192.168.1.20', family: 'IPv4' }] };
test('node hint fills this machine address, prioritizes LAN over tunnels and flags loopback listening', () => {
  const data = connectionHint({ port: 4321, bindHost: '127.0.0.1', interfaces });
  assert.match(data.hint, /ws:\/\/192\.168\.1\.20:4321/); assert.equal(data.loopback, true);
  assert.equal(connectionHint({ port: 1234, bindHost: '0.0.0.0', interfaces }).loopback, false);
  assert.match(connectionHint({ port: 1234, bindHost: '2001:db8::1', interfaces }).hint, /ws:\/\/\[2001:db8::1\]:1234/);
  assert.match(connectionHint({ port: 4321, bindHost: '127.0.0.1', interfaces: {} }).hint, /127\.0\.0\.1/);
});
