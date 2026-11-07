const dns = require('dns');
// Prefer IPv4 on dual-stack networks while retaining IPv6-only support and
// automatic fallback. Some networks resolve AAAA records without IPv6 routing.
const upstreamNetwork = {
  autoSelectFamily: true,
  // 250 ms can abandon working IPv4 connections on higher-latency networks,
  // then leave the final attempt stuck on an unroutable IPv6 address.
  autoSelectFamilyAttemptTimeout: 2000,
  lookup: (hostname, options, callback) => dns.lookup(hostname, { ...options, verbatim: false }, callback),
};
module.exports = { upstreamNetwork };
