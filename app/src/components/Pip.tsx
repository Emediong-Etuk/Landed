"use client";
import { motion, useReducedMotion } from "motion/react";

/** Pip — a parachuting chip. Decorative; hidden from assistive tech. */
export function Pip({ size = 56, wave = 0 }: { size?: number; wave?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 64 64"
      animate={reduce ? undefined : { y: [0, -5, 0], rotate: [-3, 3, -3] }}
      transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
    >
      <path d="M8 26 C8 10, 56 10, 56 26 Z" fill="#FF6A3D" />
      <path d="M8 26 C14 20, 20 20, 24 26 C28 20, 36 20, 40 26 C44 20, 50 20, 56 26" fill="#ff8a66" />
      <line x1="10" y1="26" x2="28" y2="44" stroke="#9aa3b8" strokeWidth="1.2" />
      <line x1="54" y1="26" x2="36" y2="44" stroke="#9aa3b8" strokeWidth="1.2" />
      <line x1="32" y1="26" x2="32" y2="42" stroke="#9aa3b8" strokeWidth="1.2" />
      <motion.g animate={reduce ? undefined : { rotate: wave ? [0, -12, 10, 0] : 0 }} key={wave} transition={{ duration: 0.6 }} style={{ originX: "32px", originY: "50px" }}>
        <circle cx="32" cy="50" r="10" fill="#131826" stroke="#3DFFB4" strokeWidth="2.5" />
        <circle cx="32" cy="50" r="5.5" fill="none" stroke="#3DFFB4" strokeWidth="1.2" strokeDasharray="2 2" />
        <circle cx="29" cy="48.5" r="1" fill="#e8ecf4" />
        <circle cx="35" cy="48.5" r="1" fill="#e8ecf4" />
        <path d="M29 52 Q32 54.5 35 52" stroke="#e8ecf4" strokeWidth="1" fill="none" />
      </motion.g>
    </motion.svg>
  );
}

export function Logo() {
  return (
    <svg aria-hidden width="26" height="26" viewBox="0 0 64 64">
      <path d="M6 28 C6 8, 58 8, 58 28 Z" fill="#FF6A3D" />
      <line x1="8" y1="28" x2="28" y2="48" stroke="#9aa3b8" strokeWidth="2" />
      <line x1="56" y1="28" x2="36" y2="48" stroke="#9aa3b8" strokeWidth="2" />
      <circle cx="32" cy="52" r="9" fill="#0b0e14" stroke="#3DFFB4" strokeWidth="3" />
    </svg>
  );
}
