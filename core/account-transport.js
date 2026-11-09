const crypto = require('crypto');

// Use ephemeral X25519 keys for the credential payload in addition to cluster
// authentication. The cluster bearer token itself can travel over ws://; it
// must not be sufficient to decrypt a recorded credential exchange.
function createAccountTransport(secret) {
  const pair = crypto.generateKeyPairSync('x25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  function keyFor(encoded) {
    if (typeof encoded !== 'string' || encoded.length > 256) throw new Error('共享账号交换密钥无效');
    const remote = crypto.createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    if (remote.asymmetricKeyType !== 'x25519') throw new Error('共享账号交换密钥无效');
    const key = crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: remote });
    return crypto.hkdfSync('sha256', key, Buffer.from(secret), Buffer.from('my-agents/credential-exchange/v1'), 32);
  }
  function seal(value, remote) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', keyFor(remote), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
  }
  function open(box, remote) {
    try {
      if (!box || typeof box.body !== 'string' || box.body.length > 12 * 1024 * 1024) throw new Error();
      const cipher = crypto.createDecipheriv('aes-256-gcm', keyFor(remote), Buffer.from(box.iv, 'base64'));
      cipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(box.body, 'base64')), cipher.final()]).toString());
    } catch { throw new Error('共享账号交换解密失败'); }
  }
  return { publicKey, seal, open };
}
module.exports = { createAccountTransport };
