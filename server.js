import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PORT = clampInteger(process.env.PORT, 3000, 1, 65535);
const REQUEST_TIMEOUT_MS = clampInteger(process.env.REQUEST_TIMEOUT_MS, 10000, 2000, 30000);
const FONLINE_STATUS_TIMEOUT_MS = clampInteger(process.env.FONLINE_STATUS_TIMEOUT_MS, 5000, 1000, 20000);
const FONLINE_STATUS_CACHE_TTL_MS = clampInteger(process.env.FONLINE_STATUS_CACHE_TTL_MS, 45000, 1000, 300000);
const FALLOUT76_STATUS_CACHE_TTL_MS = clampInteger(process.env.FALLOUT76_STATUS_CACHE_TTL_MS, 60000, 1000, 300000);
const FONLINE_SERVERS_CONFIG_PATH = path.join(__dirname, "fonline-servers.json");
const FALLOUT76_STEAM_APP_ID = 1151340;
const FALLOUT76_STEAM_STORE_URL = "https://store.steampowered.com/app/1151340/Fallout_76/";
const FALLOUT76_OFFICIAL_SITE_URL = "https://fallout.bethesda.net/en/games/fallout-76";
const FALLOUT76_HUB_URL = "https://bethesda.net/en/game/fallout-76";
const FALLOUT76_SUPPORT_URL = "https://help.bethesda.net/";

const app = express();
const responseCache = new Map();
const MASTERLIST_TEXT_COLLATOR = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true
});

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeDisplayText(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeHost(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized) {
    return "";
  }

  return /^[a-z0-9.-]+$/i.test(normalized) ? normalized : "";
}

function sanitizeExternalUrl(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  try {
    const parsed = new URL(normalized);
    return /^(https?):$/i.test(parsed.protocol) ? parsed.toString() : "";
  } catch (_) {
    return "";
  }
}

function normalizeFonlineSourceMode(value) {
  const normalized = String(value || "tcp+html").trim().toLowerCase();
  return new Set(["tcp+api", "api-only", "tcp+html", "tcp+widget", "html-only", "widget-only", "site-only"]).has(normalized)
    ? normalized
    : "tcp+html";
}

function normalizeFonlineTags(rawValue) {
