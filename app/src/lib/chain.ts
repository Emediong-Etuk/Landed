"use client";
import { LandedClient } from "@landed/sdk";
import { cfg, l1Url } from "./config";

let client: LandedClient | null = null;
export function getClient(): LandedClient {
  if (!client) client = new LandedClient({ l1Url: l1Url(), erUrl: cfg.erUrl, erWsUrl: cfg.erWsUrl });
  return client;
}
