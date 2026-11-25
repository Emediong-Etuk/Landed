"use client";
import { AnimatePresence, motion } from "motion/react";
import { useApp } from "@/lib/store";

/** One sentence of what happened + one recovery button. Never a dead end. */
export function ErrorBanner() {
  const { error, erSlow, set } = useApp();
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex flex-col items-center gap-2 px-3">
      <AnimatePresence>
        {erSlow && (
          <motion.div key="slow" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="pointer-events-auto card max-w-xl px-4 py-2.5 text-sm">
            <span className="text-[var(--color-amber)]">The rollup is slow to respond.</span> Your funds are safe; cash-outs and rescues still work on Solana.
          </motion.div>
        )}
        {error && (
          <motion.div key="err" role="alert" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="pointer-events-auto card flex max-w-xl items-center gap-3 px-4 py-3 text-sm">
            <span className="flex-1">{error.message}</span>
            {error.action && <button className="btn btn-primary !min-h-9 !py-1.5" onClick={() => { set({ error: null }); error.action!.run(); }}>{error.action.label}</button>}
            <button className="btn btn-ghost !min-h-9 !py-1.5" onClick={() => set({ error: null })} aria-label="Dismiss">✕</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
