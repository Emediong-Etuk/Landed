export type Layer = "L1" | "ER";

const ER_URL = "https://devnet-eu.magicblock.app";

export function txUrl(sig: string, layer: Layer, erUrl = ER_URL): string {
  if (layer === "L1") return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(erUrl)}`;
}
export function addressUrl(addr: string, layer: Layer = "L1", erUrl = ER_URL): string {
  if (layer === "L1") return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
  return `https://explorer.solana.com/address/${addr}?cluster=custom&customUrl=${encodeURIComponent(erUrl)}`;
}
export const short = (s: string, n = 4) => (s.length <= 2 * n + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
export const fmtD = (micro: bigint | number, digits = 2) => (Number(micro) / 1_000_000).toFixed(digits);
