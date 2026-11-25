export interface TourStep { route: string; selector: string; title: string; text: string }

/** Route-aware tour (§8.5). Pure data so it can be unit-tested. */
export const TOUR_STEPS: TourStep[] = [
  { route: "/", selector: "[data-tour=hero]", title: "This is the problem.", text: "On MagicBlock, a win settles in the rollup in ~10 ms — but the cash-out to Solana rides a post-commit action that can be silently dropped. Landed makes every win land." },
  { route: "/", selector: "[data-tour=stats]", title: "Read from chain right now.", text: "These numbers come from devnet accounts, not a database. 'Owed > 60 s' should always read 0." },
  { route: "/", selector: "[data-tour=watch]", title: "2–3 minute pitch.", text: "Prefer a video? The pitch and a technical walkthrough live here." },
  { route: "/", selector: "[data-tour=guest]", title: "No wallet needed.", text: "Play as guest makes a burner wallet in your browser, tops up a little gas and hands you 100 test dUSDC. Zero signatures." },
  { route: "/play", selector: "[data-tour=drops]", title: "One tap, zero fees, no popups.", text: "Each chip is an Ephemeral Rollup transaction: free and confirmed in milliseconds. Keys 1 2 3 4 work too." },
  { route: "/play", selector: "[data-tour=ring]", title: "VRF picks the winner.", text: "When the round closes, MagicBlock VRF delivers randomness on-chain. The needle's landing angle is computed from that randomness and the entries — anyone can reproduce it." },
  { route: "/play", selector: "[data-tour=cashout]", title: "Watch your money land on Solana.", text: "Cash out and the Settlement Rail shows Requested → Committed → Paid, with every transaction linked." },
  { route: "/lab", selector: "[data-tour=lab]", title: "Break a payout on purpose.", text: "Trigger a real failing payout on devnet. The naive pattern strands the funds; Landed rescues them — anyone can." },
  { route: "/verify", selector: "[data-tour=verify]", title: "Don't trust us.", text: "Re-run every invariant in your browser, straight from chain data. Or from your terminal." },
  { route: "/proof", selector: "[data-tour=proof]", title: "Program IDs, transactions, tests.", text: "Everything here links to an explorer or a test result. That's the tour — go land a win." },
];

export const TOUR_FLAG = "landed.tour.seen";
