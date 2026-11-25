"use client";
import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { driver, type Driver } from "driver.js";
import { TOUR_FLAG, TOUR_STEPS } from "@/lib/tour";

const Ctx = createContext<{ start: () => void }>({ start: () => {} });
export const useTour = () => useContext(Ctx);

const PIP_SVG = `<svg aria-hidden="true" width="44" height="44" viewBox="0 0 64 64" class="animate-bob" style="flex:none"><path d="M8 26 C8 10, 56 10, 56 26 Z" fill="#FF6A3D"/><line x1="10" y1="26" x2="28" y2="44" stroke="#9aa3b8" stroke-width="1.2"/><line x1="54" y1="26" x2="36" y2="44" stroke="#9aa3b8" stroke-width="1.2"/><circle cx="32" cy="50" r="10" fill="#131826" stroke="#3DFFB4" stroke-width="2.5"/><circle cx="29" cy="48.5" r="1" fill="#e8ecf4"/><circle cx="35" cy="48.5" r="1" fill="#e8ecf4"/><path d="M29 52 Q32 54.5 35 52" stroke="#e8ecf4" stroke-width="1" fill="none"/></svg>`;

function waitFor(selector: string, ms = 5000): Promise<Element | null> {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) return res(el);
      if (Date.now() - t0 > ms) return res(null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const d = useRef<Driver | null>(null);
  const idx = useRef(0);
  const pathRef = useRef(path);
  pathRef.current = path;

  const show = useCallback(async (i: number) => {
    const step = TOUR_STEPS[i];
    if (!step) { d.current?.destroy(); return; }
    idx.current = i;
    d.current?.destroy();
    if (pathRef.current !== step.route) router.push(step.route);
    const el = await waitFor(step.selector);
    d.current?.destroy();
    const drv = driver({
      popoverClass: "landed-tour",
      allowKeyboardControl: true,
      showProgress: true,
      progressText: `${i + 1} / ${TOUR_STEPS.length}`,
      overlayColor: "#05070b",
      overlayOpacity: 0.72,
      smoothScroll: true,
      stagePadding: 6,
      onDestroyStarted: () => { drv.destroy(); },
    });
    d.current = drv;
    drv.highlight({
      element: (el as HTMLElement) ?? undefined,
      popover: {
        title: step.title,
        description: step.text,
        showButtons: ["previous", "next", "close"],
        nextBtnText: i === TOUR_STEPS.length - 1 ? "Done" : "Next →",
        prevBtnText: "← Back",
        doneBtnText: "Done",
        onNextClick: () => (i === TOUR_STEPS.length - 1 ? drv.destroy() : void show(i + 1)),
        onPrevClick: () => (i === 0 ? undefined : void show(i - 1)),
        onPopoverRender: (pop) => {
          const head = document.createElement("div");
          head.style.cssText = "display:flex;gap:.6rem;align-items:center;margin-bottom:.25rem";
          head.innerHTML = PIP_SVG;
          pop.title.parentElement?.insertBefore(head, pop.title);
          head.appendChild(pop.title);
          pop.progress.textContent = `${i + 1} / ${TOUR_STEPS.length}`;
          pop.progress.style.display = "block";
          const skip = document.createElement("button");
          skip.textContent = "Skip tour";
          skip.onclick = () => drv.destroy();
          pop.footerButtons.prepend(skip);
        },
      },
    });
  }, [router]);

  const start = useCallback(() => {
    try { localStorage.setItem(TOUR_FLAG, "1"); } catch { /* */ }
    void show(0);
  }, [show]);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const forced = search.get("tour") === "1";
    if (search.get("demo") === "1" && !forced) return;
    let seen = false;
    try { seen = localStorage.getItem(TOUR_FLAG) === "1"; } catch { seen = true; }
    if (forced || (!seen && path === "/")) {
      const t = setTimeout(start, 900);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !(e.target instanceof HTMLInputElement)) start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start]);

  return <Ctx.Provider value={{ start }}>{children}</Ctx.Provider>;
}
