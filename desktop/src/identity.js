import 'reflect-metadata';
import fs from 'node:fs';
import { randomUUID, randomBytes, webcrypto, X509Certificate, createHash, createPrivateKey } from 'node:crypto';
import { cryptoProvider, X509CertificateGenerator } from '@peculiar/x509';

cryptoProvider.set(webcrypto);
export const fingerprint = (raw) => createHash('sha256').update(raw).digest('hex');

export async function createIdentity() {
  const id = randomUUID();
  const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'), name: `CN=ct45-${id}`,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 10 * 365.25 * 86_400_000),
    signingAlgorithm: algorithm, keys,
  });
  const der = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const key = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' });
  return { id, key, cert: cert.toString('pem') };
}

// Keep this identity across restarts and address changes. Never silently replace a bad file:
// paired scanners must not be taught to trust a replacement certificate over the network.
export async function loadIdentity(file) {
  let identity;
  try { identity = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    identity = await createIdentity();
    fs.writeFileSync(file, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
  }
  const cert = new X509Certificate(identity.cert);
  if (!identity.id || !cert.checkPrivateKey(createPrivateKey(identity.key))) throw new Error('Invalid computer identity');
  return { ...identity, fingerprint: fingerprint(cert.raw) };
}
