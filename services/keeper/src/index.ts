/**
 * Landed keeper — OPTIONAL convenience. Every action here is permissionless
 * (anyone can run their own keeper, and the web page performs the same steps):
 *   watchdog  close / retry / void / settle the table when due (covers a silent crank, F4)
 *   rescue    owed > 8 s → request_commit if the commit is missing → finalize_withdraw (pays the OWNER)
 *   ack       mark paid ring slots Acked so they can be reused
 *   ingest    credit L1 deposit receipts in the ER
 *   top-ups   keep the action escrow funded (our own PDA)
 *   bots      two LABELED bots so a solo judge always has an opponent
 * State is derived from chain on every loop, so restarts are safe.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import pino from "pino";
import {
  CHIPS, CLOSED_BY, DISC, LANDED_PROGRAM_ID, LandedClient, ONE_DUSDC, RESCUE_AFTER_MS, SLOT_STATE, TABLE_STATUS,
  decodeLedger, decodeUserMeta, ix, pda, sleep,
} from "@landed/sdk";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const env = (k: string, d?: string) => process.env[k] ?? d;
const keyFrom = (v?: string) => {
  if (!v) return null;
  if (v.trim().startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(v)));
  if (v.endsWith(".json")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(v, "utf8"))));
  return Keypair.fromSecretKey(bs58.decode(v));
};

const keeper = keyFrom(env("KEEPER_KEYPAIR")) ?? Keypair.generate();
const bots = [keyFrom(env("BOT_1_KEYPAIR")), keyFrom(env("BOT_2_KEYPAIR"))].filter((k): k is Keypair => !!k);
const BOTS_ENABLED = env("BOTS_ENABLED", "true") === "true";
const BOTS_AUTOPLAY = env("BOTS_AUTOPLAY", "false") === "true";
const c = new LandedClient({ l1Url: env("LANDED_L1_RPC"), erUrl: env("LANDED_ER_RPC") });

const health = { startedAt: new Date().toISOString(), heartbeat: "", loops: 0, actions: {} as Record<string, number>, lastError: "", keeper: keeper.publicKey.toBase58(), bots: bots.map((b) => b.publicKey.toBase58()), keeperSol: 0, escrowSol: 0, feePayerErSol: 0 };
const count = (k: string) => (health.actions[k] = (health.actions[k] ?? 0) + 1);

let owners: PublicKey[] = [];
let ownersAt = 0;
async function refreshOwners() {
  if (Date.now() - ownersAt < 30_000) return owners;
  const accs = await c.l1.getProgramAccounts(LANDED_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(DISC.UserMeta) } }] });
  owners = accs.map((a) => decodeUserMeta(new Uint8Array(a.account.data)).owner);
  ownersAt = Date.now();
  return owners;
}

async function watchdog() {
  const t = await c.tick(keeper, CLOSED_BY.KEEPER);
  if (t.action !== "none" && t.action !== "no-table") {
    count(t.action);
    log.info({ action: t.action, ok: t.r?.ok, sig: t.r?.sig, err: t.r?.ok ? undefined : t.r?.err }, "watchdog");
  }
}

async function rescueAckIngest() {
  const os = await refreshOwners();
  for (let i = 0; i < os.length; i += 99) {
    const chunk = os.slice(i, i + 99);
    const [er, metas] = await Promise.all([
      c.er.getMultipleAccountsInfo(chunk.map((o) => pda.ledger(o))),
      c.l1.getMultipleAccountsInfo(chunk.map((o) => pda.user(o))),
    ]);
    for (let j = 0; j < chunk.length; j++) {
      const owner = chunk[j];
      const a = er[j];
      if (!a) continue;
      let l;
      try { l = decodeLedger(new Uint8Array(a.data)); } catch { continue; }
      const meta = metas[j] ? decodeUserMeta(new Uint8Array(metas[j]!.data)) : null;
      if (meta && meta.depositCount > l.ingestedCount) {
        await c.ingestAll(owner, keeper, 5_000).then(() => count("ingest")).catch((e) => log.debug({ e: String(e) }, "ingest pending"));
      }
      for (const s of l.ring) {
        if (s.state !== SLOT_STATE.PENDING) continue;
        if (Date.now() - Number(s.requestedTs) * 1000 < RESCUE_AFTER_MS) continue;
        const r = await c.ensurePaid(owner, s.nonce, keeper);
        if (r.r) { count(`rescue_${r.path}`); log.info({ owner: owner.toBase58(), nonce: String(s.nonce), path: r.path, sig: r.r.sig }, "rescue"); }
      }
      if (l.ring.some((s) => s.state === SLOT_STATE.PENDING)) {
        const r = await c.ackPaid(owner, keeper);
        if (r?.ok) count("ack");
      }
    }
  }
}

async function topUps() {
  const [k, esc, fp] = await Promise.all([c.l1.getBalance(keeper.publicKey), c.l1.getBalance(c.a.escrow), c.er.getBalance(c.a.escrowAuth).catch(() => 0)]);
  health.keeperSol = k / LAMPORTS_PER_SOL;
  health.escrowSol = esc / LAMPORTS_PER_SOL;
  health.feePayerErSol = fp / LAMPORTS_PER_SOL;
  if (esc < 0.05 * LAMPORTS_PER_SOL && k > 0.2 * LAMPORTS_PER_SOL) {
    const r = await c.send("L1", [ix.topUpEscrow(keeper.publicKey, c.a.escrowAuth, BigInt(0.1 * LAMPORTS_PER_SOL))], [keeper], "top_up_escrow");
    log.warn({ ok: r.ok, sig: r.sig }, "topped up action escrow");
  }
  if (fp && fp < 0.05 * LAMPORTS_PER_SOL) log.error({ feePayerErSol: health.feePayerErSol }, "ER fee payer low — top up with lamportsDelegatedTransferIx");
  if (k < 0.05 * LAMPORTS_PER_SOL) log.error({ keeperSol: health.keeperSol }, "keeper hot key low");
}

const botNext = new Map<string, number>();
async function botsLoop() {
  if (!BOTS_ENABLED || !bots.length) return;
  const t = await c.table("ER");
  if (!t || t.status !== TABLE_STATUS.OPEN) return;
  const botSet = new Set(bots.map((b) => b.publicKey.toBase58()));
  const humans = t.entries.filter((e) => !botSet.has(e.player.toBase58())).length;
  if (!humans && !BOTS_AUTOPLAY) return; // bots only keep humans company
  const now = Math.floor(Date.now() / 1000);
  if (t.closesTs > 0n && now >= Number(t.closesTs) - 2) return;
  for (const b of bots) {
    const k = b.publicKey.toBase58();
    if (t.entries.some((e) => e.player.equals(b.publicKey))) continue;
    if ((botNext.get(k) ?? 0) > Date.now()) continue;
    botNext.set(k, Date.now() + 1500 + Math.random() * 4000); // human-ish jitter
    const led = await c.ledger(b.publicKey, "ER");
    const chip = BigInt(CHIPS[Math.floor(Math.random() * 3)]) * ONE_DUSDC;
    if (!led || led.available < chip) {
      await c.onboard(b, 50n * ONE_DUSDC).then(() => log.info({ bot: k }, "bot refilled")).catch((e) => log.warn({ bot: k, e: String(e).slice(0, 200) }, "bot refill failed"));
      continue;
    }
    const r = await c.enter(b, b.publicKey, chip);
    if (r.ok) count("bot_enter");
  }
}

async function loop(name: string, everyMs: number, f: () => Promise<void>) {
  for (;;) {
    try { await f(); } catch (e) { health.lastError = `${name}: ${String(e).slice(0, 300)}`; log.warn({ loop: name, e: health.lastError }, "loop error"); }
    health.heartbeat = new Date().toISOString();
    health.loops++;
    await sleep(everyMs);
  }
}

createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(health));
}).listen(Number(env("PORT", "8787")));

log.info({ keeper: health.keeper, bots: health.bots, botsEnabled: BOTS_ENABLED }, "landed keeper starting");
void loop("watchdog", 1500, watchdog);
void loop("rescue", 4000, rescueAckIngest);
void loop("topups", 60_000, topUps);
void loop("bots", 1200, botsLoop);
