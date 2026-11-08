const os = require('os');
const net = require('net');

// Use addresses on this machine, never the request Host header or a caller's IP.
function connectionHint({ port, bindHost, token, interfaces = os.networkInterfaces() }) {
  const addresses = Object.entries(interfaces).flatMap(([name, rows]) =>
    rows.filter(row => !row.internal && (row.family === 'IPv4' || row.family === 4))
      .map(row => ({ name, address: row.address })));
  addresses.sort((a, b) => Number(/^(utun|tun|tap|docker|veth|bridge)/.test(a.name)) - Number(/^(utun|tun|tap|docker|veth|bridge)/.test(b.name)));
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(bindHost);
  const address = !loopback && !['0.0.0.0', '::'].includes(bindHost) ? bindHost : addresses[0]?.address || '127.0.0.1';
  const host = net.isIP(address) === 6 ? `[${address}]` : address;
  return { hint: `my-agents node --hub ws://${host}:${port} --token ${token || '<panel-token>'}`, address, loopback };
}
module.exports = { connectionHint };
