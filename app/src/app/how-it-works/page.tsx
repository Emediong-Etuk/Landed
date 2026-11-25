import Link from "next/link";

const FAILS = [
  ["F1", "Post-commit payout action fails → dropped, commit lands without it", "The player is debited in the rollup and never paid.", "Exactly-once withdrawal: a Pending entry in the committed ledger + a unique receipt PDA. Anyone can rescue it with finalize_withdraw, and the funds go to the owner."],
  ["F2", "Without a fee payer, commit 11 fails with 0xA0000000", "A player's 11th cash-out in one delegation session fails.", "A delegated fee-payer PDA + validator-scoped magic_fee_vault; 30+ cash-outs per session tested."],
  ["F3", "VRF callbacks have no age limit; unfulfilled requests get purged after ~120 s", "A late callback can land on a round that has moved on, and a round can hang forever.", "Round state machine with a nonce: retry after 20 s (new nonce makes old callbacks stale no-ops), void + full refund after 150 s."],
  ["F4", "A crank schedule can be accepted and never run", "On 1.1.1 task IDs collide globally; on 2.0 tasks need a running Hydra cranker. Rounds never close.", "Derived task IDs + a permissionless watchdog (page + keeper) that closes due rounds. The Proof page shows crank coverage."],
  ["F5", "#[action] handlers and cranked instructions are publicly callable", "A naive payout handler is a drain.", "Escrow signer pinned to our escrow authority PDA + source program check; every crankable instruction is state- and time-checked."],
  ["F6", "Accounts > 10,240 bytes can't be committed or undelegated", "A growing history account bricks the funds inside.", "Fixed-size ring buffers and compile-time size asserts (Table ≈ 3.7 KB, Ledger ≈ 0.6 KB)."],
  ["F7", "Two truths: the Solana copy of a delegated account is stale until a commit", "Balances disagree depending on where you look.", "The UI shows rollup, wallet and in-flight balances separately; the verifier reconciles both layers."],
];

export default function HowItWorks() {
  return (
    <article className="prose-invert flex max-w-4xl flex-col gap-8">
      <header>
        <h1 className="display text-2xl">How it works</h1>
        <p className="mt-3 text-[var(--color-muted)]">
          Game state lives in a MagicBlock Ephemeral Rollup (fast, free). Money lives on Solana (the dUSDC vault). They are connected by commits and Magic Actions,
          which run as separate steps. That gap only exists on this stack, and Landed closes it.
        </p>
      </header>

      <section>
        <h2 className="display text-xl">The settlement protocol</h2>
        <svg viewBox="0 0 760 250" className="mt-4 w-full" role="img" aria-label="Sequence: request_withdraw in the rollup commits the ledger and schedules settle_withdraw; if it is dropped, anyone calls finalize_withdraw; ack_withdrawal frees the ring slot.">
          {[["Player", 70], ["Rollup (ER)", 280], ["Solana (L1)", 500], ["Anyone", 690]].map(([l, x]) => (
            <g key={l as string}><text x={x as number} y="20" textAnchor="middle" fill="var(--color-muted)" fontSize="13">{l}</text><line x1={x as number} y1="30" x2={x as number} y2="240" stroke="var(--color-hairline)" /></g>
          ))}
          {[
            [70, 280, 50, "request_withdraw: debit, ring[n] = Pending", "var(--color-signal)"],
            [280, 500, 85, "commit ledger (+ post-commit settle_withdraw)", "var(--color-er)"],
            [500, 500, 115, "action ok → init WithdrawReceipt[n] → pay owner", "var(--color-mint)"],
            [690, 500, 150, "action dropped → finalize_withdraw (reads committed ledger)", "var(--color-amber)"],
            [690, 280, 185, "commit missing → request_commit", "var(--color-amber)"],
            [690, 280, 220, "ack_withdrawal: receipt seen → slot Acked", "var(--color-l1)"],
          ].map(([a, b, y, l, c], i) => (
            <g key={i}>
              <line x1={a as number} y1={y as number} x2={(b as number) + ((b as number) > (a as number) ? -6 : (b as number) < (a as number) ? 6 : 0)} y2={y as number} stroke={c as string} strokeWidth="2" markerEnd="url(#arr)" />
              <text x={Math.min(a as number, b as number) + Math.abs((b as number) - (a as number)) / 2 || (a as number) - 170} y={(y as number) - 6} textAnchor={(a as number) === (b as number) ? "start" : "middle"} fill="var(--color-text)" fontSize="11">{l}</text>
            </g>
          ))}
          <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--color-muted)" /></marker></defs>
        </svg>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-[var(--color-muted)]">
          <li><strong className="text-[var(--color-text)]">Deposits are ingested exactly once, in order:</strong> L1 creates DepositReceipt[owner, n]; the ER credits n only when n == ingested_count.</li>
          <li><strong className="text-[var(--color-text)]">Withdrawals are recorded before they are paid:</strong> the ledger (with the Pending entry) is committed to Solana, and amount and destination come only from that committed state, never from arguments.</li>
          <li><strong className="text-[var(--color-text)]">Exactly-once payment:</strong> paying requires creating the unique WithdrawReceipt[owner, n] PDA. The action and a rescue can race; whichever lands first wins and the other fails harmlessly.</li>
          <li><strong className="text-[var(--color-text)]">Never lost:</strong> if the action is dropped, anyone can call finalize_withdraw; if the commit itself is missing, anyone can call request_commit first. The page does it automatically after 8 s.</li>
          <li><strong className="text-[var(--color-text)]">Never overwritten:</strong> a ring slot is reused only after its receipt has been observed (ack). A 17th unpaid withdrawal is rejected with RingFull.</li>
          <li><strong className="text-[var(--color-text)]">Exits can't be blocked:</strong> pause stops entries and deposits, never withdrawals, rescues, commits or acks. The admin has no instruction that moves vault funds.</li>
        </ul>
      </section>

      <section>
        <h2 className="display text-xl">Silent failures that exist only on this stack</h2>
        <div className="mt-4 grid gap-3">
          {FAILS.map(([id, title, impact, fix]) => (
            <div key={id} className="card p-4">
              <div className="flex items-baseline gap-3"><span className="num text-sm text-[var(--color-signal)]">{id}</span><h3 className="font-semibold">{title}</h3></div>
              <p className="mt-1 text-sm text-[var(--color-danger)]">{impact}</p>
              <p className="mt-1 text-sm text-[var(--color-muted)]"><span className="text-[var(--color-mint)]">Landed:</span> {fix}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="display text-xl">Trust assumptions</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-[var(--color-muted)]">
          <li>The ER validator must commit eventually. Landed removes the <em>action</em> as a single point of failure, not the validator. Finality relies on MagicBlock&apos;s fraud-proof Security Committee.</li>
          <li>MagicBlock&apos;s VRF oracle produces randomness. We verify the callback provenance (scoped identity signer) and handle delay and non-delivery (retry / void), but can&apos;t force delivery.</li>
          <li>Entries are public: we deliberately don&apos;t use Private ERs — privacy doesn&apos;t fix settlement correctness.</li>
        </ul>
      </section>

      <section id="limitations">
        <h2 className="display text-xl">Honest limitations</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-[var(--color-muted)]">
          <li>Devnet only, test token (dUSDC), no real money. A real-money launch would need legal/gaming-license review, geofencing and responsible-gaming controls.</li>
          <li>Guest burner keys live in the browser (encrypted at rest with a non-extractable key, but browsers are adversarial). Session keys are scoped and capped; XSS remains a risk class.</li>
          <li>Bots are ours, labeled, and funded from the faucet so a solo judge always has an opponent.</li>
          <li>The keeper is a convenience; everything it does, anyone (including this page) can do.</li>
          <li>Commit costs grow after 25 commits per account with a fee payer (1,000,000 lamports each on validator 2.0).</li>
          <li>House fees accumulate in the treasury ledger; there is intentionally no admin withdrawal path in this MVP.</li>
        </ul>
        <p className="mt-4 text-sm"><Link href="/verify" className="text-[var(--color-signal)] underline">Re-run every check yourself →</Link></p>
      </section>
    </article>
  );
}
