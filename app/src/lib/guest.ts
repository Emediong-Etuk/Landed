/**
 * Guest burner wallet. Generated in the browser; stored in IndexedDB encrypted
 * with a NON-EXTRACTABLE AES-GCM WebCrypto key (the key object itself lives in
 * IndexedDB and can never be exported by script). Every storage access is
 * wrapped so private mode / blocked storage falls back to an in-memory key.
 */
import { Keypair } from "@solana/web3.js";

const DB = "landed-guest";
const STORE = "kv";
let memory: Keypair | null = null;

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) {
      rej(e);
    }
  });
}
async function get<T>(k: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readonly").objectStore(STORE).get(k);
    t.onsuccess = () => res(t.result as T);
    t.onerror = () => rej(t.error);
  });
}
async function put(k: string, v: unknown) {
  const db = await idb();
  return new Promise<void>((res, rej) => {
    const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(v, k);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function key(): Promise<CryptoKey> {
  const existing = await get<CryptoKey>("wrap-key");
  if (existing) return existing;
  const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await put("wrap-key", k);
  return k;
}

export async function loadGuest(): Promise<Keypair | null> {
  if (memory) return memory;
  try {
    const blob = await get<{ iv: Uint8Array; ct: ArrayBuffer }>("burner");
    if (!blob) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.iv as BufferSource }, await key(), blob.ct);
    memory = Keypair.fromSecretKey(new Uint8Array(pt));
    return memory;
  } catch {
    return memory;
  }
}

export async function createGuest(): Promise<Keypair> {
  const kp = Keypair.generate();
  memory = kp;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), kp.secretKey as BufferSource);
    await put("burner", { iv, ct });
  } catch {
    /* in-memory only (private window); the guest still works for this tab */
  }
  return kp;
}

export function exportGuestKey(kp: Keypair): string {
  return JSON.stringify(Array.from(kp.secretKey));
}

export async function forgetGuest() {
  memory = null;
  try {
    await put("burner", undefined);
  } catch {
    /* ignore */
  }
}
