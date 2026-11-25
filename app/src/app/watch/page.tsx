"use client";
import { useState } from "react";
import chapters from "@/content/video-chapters.json";
import { cfg } from "@/lib/config";

function embedUrl(url: string, start = 0) {
  const yt = url.match(/(?:youtu\.be\/|v=)([\w-]{11})/);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}?autoplay=1&start=${start}`;
  const loom = url.match(/loom\.com\/share\/(\w+)/);
  if (loom) return `https://www.loom.com/embed/${loom[1]}?autoplay=1&t=${start}`;
  return url;
}

/** Lite embed: no third-party player JS until the viewer clicks. */
function Video({ title, url, chapters: ch }: { title: string; url: string; chapters: { t: number; label: string }[] }) {
  const [start, setStart] = useState<number | null>(null);
  const isFile = url.endsWith(".mp4") || url.startsWith("/videos/");
  return (
    <section className="card p-4">
      <h2 className="display mb-3 text-lg">{title}</h2>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-[var(--color-ink)]">
        {!url ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-[var(--color-muted)]">
            <span className="display text-base text-[var(--color-text)]">Video coming soon</span>
            <span>Scripts and b-roll are ready in docs/VIDEO_SCRIPTS.md.</span>
          </div>
        ) : isFile ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video controls preload="none" className="h-full w-full" src={url} />
        ) : start === null ? (
          <button className="flex h-full w-full items-center justify-center" onClick={() => setStart(0)} aria-label={`Play ${title}`}>
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-signal)]">
              <span className="ml-1 h-0 w-0 border-y-[12px] border-l-[20px] border-y-transparent border-l-[var(--color-ink)]" />
            </span>
          </button>
        ) : (
          <iframe title={title} src={embedUrl(url, start)} className="h-full w-full" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />
        )}
      </div>
      <ol className="mt-3 flex flex-wrap gap-2 text-xs">
        {ch.map((c) => (
          <li key={c.t}><button className="btn btn-ghost !min-h-8 !px-2 !py-0.5" disabled={!url || isFile} onClick={() => setStart(c.t)}>
            <span className="num">{Math.floor(c.t / 60)}:{String(c.t % 60).padStart(2, "0")}</span> {c.label}
          </button></li>
        ))}
      </ol>
    </section>
  );
}

export default function WatchPage() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="display text-2xl">Watch</h1>
      <Video title="Pitch (≤ 3:00) — user, problem, demo" url={cfg.pitchVideo} chapters={chapters.pitch} />
      <Video title="Technical walkthrough — architecture, transactions, tests" url={cfg.techVideo} chapters={chapters.tech} />
    </div>
  );
}
