/**
 * End-to-end encryption for Uninet chat (browser, WebCrypto only).
 *
 * Scheme ("X3DH-lite", see mobile-app/lib/features/chat/e2ee_service.dart for the identical Dart implementation):
 *   - identity key      ECDSA P-256 (signs)
 *   - signed prekey     ECDH P-256, signed by the identity key
 *   - to send           verify the recipient's prekey signature, generate an ephemeral ECDH key, derive
 *                       AES-256-GCM via ECDH -> HKDF-SHA256, encrypt with AAD "<sender>><recipient>", and sign
 *                       (ephemeral public key || ciphertext) with the sender identity key
 *   - to receive        ECDH(own signed prekey, ephemeral key) -> same AES key; verify the sender signature
 *
 * The server only ever sees base64 ciphertext, public keys and signatures. Private keys are generated as
 * non-extractable CryptoKeys and persisted in IndexedDB. This provides per-message keys but, unlike the Signal
 * Double Ratchet, no forward secrecy beyond signed-prekey rotation; use libsignal for that level of assurance.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toB64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromB64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface PeerBundle {
  identity_key: string;
  signed_prekey: string;
  signed_prekey_signature: string;
}

export interface LocalKeys {
  identity: CryptoKeyPair;
  signedPrekey: CryptoKeyPair;
  identityPub: string;
  signedPrekeyPub: string;
  signedPrekeySig: string;
  createdAt: number;
}

export interface EncryptedPayload {
  header: string; // JSON {v, epk, sig}
  ciphertext: string; // base64(iv || aes-gcm ciphertext)
}

/* ---------------------------- key storage ---------------------------- */

const DB_NAME = 'uninet-e2ee';
const STORE = 'keys';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Loads this user's keys from IndexedDB, generating and persisting them on first use. */
export async function ensureKeys(userId: string): Promise<LocalKeys> {
  const storageKey = `keys:${userId}`;
  const existing = await idbGet<LocalKeys>(storageKey);
  if (existing) return existing;

  const identity = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const signedPrekey = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;

  const identityPub = new Uint8Array(await crypto.subtle.exportKey('raw', identity.publicKey));
  const signedPrekeyPub = new Uint8Array(await crypto.subtle.exportKey('raw', signedPrekey.publicKey));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, signedPrekeyPub));

  const keys: LocalKeys = {
    identity,
    signedPrekey,
    identityPub: toB64(identityPub),
    signedPrekeyPub: toB64(signedPrekeyPub),
    signedPrekeySig: toB64(signature),
    createdAt: Date.now(),
  };
  await idbPut(storageKey, keys);
  return keys;
}

export function publicBundle(keys: LocalKeys): PeerBundle {
  return {
    identity_key: keys.identityPub,
    signed_prekey: keys.signedPrekeyPub,
    signed_prekey_signature: keys.signedPrekeySig,
  };
}

/* ------------------------------ crypto ------------------------------ */

async function importIdentityPublic(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64(raw), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}

async function importEcdhPublic(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function deriveAesKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode('uninet-e2ee-v1') },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Verifies that the peer's signed prekey was signed by their identity key. */
export async function verifyBundle(bundle: PeerBundle): Promise<boolean> {
  try {
    const identity = await importIdentityPublic(bundle.identity_key);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      identity,
      fromB64(bundle.signed_prekey_signature),
      fromB64(bundle.signed_prekey),
    );
  } catch {
    return false;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export async function encryptFor(keys: LocalKeys, myId: string, peerId: string, bundle: PeerBundle, plaintext: string): Promise<EncryptedPayload> {
  if (!(await verifyBundle(bundle))) throw new Error("The recipient's key bundle failed verification");

  const ephemeral = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
  const epkRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const recipientPrekey = await importEcdhPublic(fromB64(bundle.signed_prekey));
  const aesKey = await deriveAesKey(ephemeral.privateKey, recipientPrekey);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`${myId}>${peerId}`) },
      aesKey,
      encoder.encode(plaintext),
    ),
  );
  const ciphertext = concat(iv, sealed);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.identity.privateKey, concat(epkRaw, ciphertext)),
  );

  return {
    header: JSON.stringify({ v: 1, epk: toB64(epkRaw), sig: toB64(signature) }),
    ciphertext: toB64(ciphertext),
  };
}

export interface DecryptResult {
  text: string;
  /** true: signature valid; false: invalid signature; null: could not check (sender keys unavailable) */
  verified: boolean | null;
}

export async function decryptFrom(
  keys: LocalKeys,
  myId: string,
  senderId: string,
  payload: EncryptedPayload,
  senderIdentityKey: string | null,
): Promise<DecryptResult> {
  const header = JSON.parse(payload.header) as { v: number; epk: string; sig: string };
  if (header.v !== 1) throw new Error('Unsupported message version');

  const epkRaw = fromB64(header.epk);
  const ciphertext = fromB64(payload.ciphertext);
  if (ciphertext.length < 13) throw new Error('Ciphertext is too short');

  const aesKey = await deriveAesKey(keys.signedPrekey.privateKey, await importEcdhPublic(epkRaw));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ciphertext.slice(0, 12), additionalData: encoder.encode(`${senderId}>${myId}`) },
    aesKey,
    ciphertext.slice(12),
  );

  let verified: boolean | null = null;
  if (senderIdentityKey) {
    try {
      verified = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        await importIdentityPublic(senderIdentityKey),
        fromB64(header.sig),
        concat(epkRaw, ciphertext),
      );
    } catch {
      verified = false;
    }
  }
  return { text: decoder.decode(plain), verified };
}
