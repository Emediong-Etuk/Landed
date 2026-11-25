"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "@/lib/store";
import { Logo } from "./Pip";
import { useTour } from "./Tour";

const NAV = [
  ["/play", "Play"],
  ["/lab", "Fault Lab"],
  ["/verify", "Verify"],
  ["/proof", "Proof"],
  ["/how-it-works", "How it works"],
  ["/watch", "Watch"],
] as const;

export function Header() {
  const path = usePathname();
  const { start } = useTour();
  const { judge, technical, set } = useApp();
  return (
    <header className="sticky top-0 z-40 border-b hair bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 sm:px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="Landed home">
          <Logo />
          <span className="display text-base font-semibold">Landed</span>
        </Link>
        <nav aria-label="Main" className="ml-2 hidden gap-1 md:flex">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} aria-current={path === href ? "page" : undefined}
              className={`rounded-lg px-2.5 py-1.5 text-sm ${path === href ? "bg-[var(--color-raised-2)] text-[var(--color-text)]" : "text-[var(--color-muted)] hover:text-[var(--color-text)]"}`}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <label className="hidden items-center gap-2 text-xs text-[var(--color-muted)] sm:flex">
            <input type="checkbox" className="accent-[var(--color-signal)]" checked={technical}
              onChange={(e) => { set({ technical: e.target.checked }); try { localStorage.setItem("landed.technical", e.target.checked ? "1" : "0"); } catch { /* */ } }} />
            Technical details
          </label>
          <button className="btn btn-ghost !min-h-9 !px-3 !py-1 text-xs" aria-pressed={judge}
            onClick={() => { set({ judge: !judge, technical: true }); if (!judge) start(); }}>
            Judge mode
          </button>
          <button className="btn btn-ghost !min-h-9 !w-9 !p-0" aria-label="Start the guided tour (?)" onClick={() => start()} data-tour="help">
            ?
          </button>
        </div>
      </div>
      <nav aria-label="Main mobile" className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} aria-current={path === href ? "page" : undefined}
            className={`shrink-0 rounded-lg px-2.5 py-1.5 text-sm ${path === href ? "bg-[var(--color-raised-2)]" : "text-[var(--color-muted)]"}`}>
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
