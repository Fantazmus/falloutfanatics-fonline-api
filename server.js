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
const FONLINE_SERVERS_CONFIG_PATH = path.join(__dirname, "fonline-servers.json");

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
  const values = Array.isArray(rawValue)
    ? rawValue
    : rawValue === undefined || rawValue === null
      ? []
      : [rawValue];

  return [...new Set(
    values
      .map((value) => sanitizeDisplayText(value, 40).toLowerCase())
      .map((value) => value.replace(/[^a-z0-9а-яё-]+/gi, "-").replace(/^-+|-+$/g, ""))
      .filter(Boolean)
  )].slice(0, 8);
}

function buildFonlineServerDefinition(rawEntry = {}, index = 0) {
  const fallbackKey = `fonline-${index + 1}`;
  const key = sanitizeDisplayText(rawEntry.key || rawEntry.name || fallbackKey, 80)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallbackKey;
  const name = sanitizeDisplayText(rawEntry.name || rawEntry.title || rawEntry.key || fallbackKey, 120);

  if (!name) {
    return null;
  }

  const rawAddress = sanitizeDisplayText(rawEntry.address, 120);
  let gameHost = sanitizeHost(rawEntry.gameHost || rawEntry.host);
  let gamePort = normalizeOptionalInteger(rawEntry.gamePort ?? rawEntry.port, 1, 65535);

  if (rawAddress && (!gameHost || !gamePort)) {
    const [addressHost = "", addressPort = ""] = rawAddress.split(":");

    if (!gameHost) {
      gameHost = sanitizeHost(addressHost);
    }

    if (!gamePort) {
      gamePort = normalizeOptionalInteger(addressPort, 1, 65535);
    }
  }

  return {
    key,
    name,
    sourceLabel: sanitizeDisplayText(rawEntry.sourceLabel, 80),
    description: sanitizeDisplayText(rawEntry.description, 320),
    websiteUrl: sanitizeExternalUrl(rawEntry.websiteUrl || rawEntry.siteUrl),
    statusPageUrl: sanitizeExternalUrl(rawEntry.statusPageUrl || rawEntry.statusUrl),
    statusApiUrl: sanitizeExternalUrl(rawEntry.statusApiUrl || rawEntry.liveStatusUrl || rawEntry.apiUrl),
    statusImageUrl: sanitizeExternalUrl(rawEntry.statusImageUrl || rawEntry.widgetUrl),
    statsUrl: sanitizeExternalUrl(rawEntry.statsUrl || rawEntry.moreStatsUrl),
    downloadUrl: sanitizeExternalUrl(rawEntry.downloadUrl),
    discordUrl: sanitizeExternalUrl(rawEntry.discordUrl),
    gameHost,
    gamePort,
    preferredSource: normalizeFonlineSourceMode(rawEntry.preferredSource),
    tags: normalizeFonlineTags(rawEntry.tags)
  };
}

async function loadFonlineServerDefinitions() {
  const source = await fs.readFile(FONLINE_SERVERS_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(source);
  const items = Array.isArray(parsed)
    ? parsed.map((entry, index) => buildFonlineServerDefinition(entry, index)).filter(Boolean)
    : [];

  if (!items.length) {
    throw new Error("fonline-servers.json is empty.");
  }

  return items;
}

function getCachedPayload(key, ttlMs) {
  const cached = responseCache.get(key);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > ttlMs) {
    responseCache.delete(key);
    return null;
  }

  return cached.payload;
}

function setCachedPayload(key, payload) {
  responseCache.set(key, {
    payload,
    createdAt: Date.now()
  });
}

async function fetchText(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "falloutfanatics-fonline-api/1.0",
        Accept: "*/*"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${sourceLabel} returned HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJson(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "falloutfanatics-fonline-api/1.0",
        Accept: "application/json"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${sourceLabel} returned HTTP ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractPlainTextFromHtml(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseFonlineStatusSnapshot(html) {
  const text = extractPlainTextFromHtml(html);

  if (!text) {
    return null;
  }

  const statusMatch = text.match(/\bSTATUS:\s*(ONLINE|OFFLINE|MAINTENANCE|TESTING|UNKNOWN)\b/i);
  const ipMatch = text.match(/\bIP:\s*([a-z0-9.-]+)\b/i);
  const portMatch = text.match(/\bPort:\s*(\d{2,5})\b/i);
  const playersWithCapMatch = text.match(/\bPlayers:\s*(\d+)\s*(?:\/|of)\s*(\d+)\b/i);
  const playersSingleMatch = playersWithCapMatch ? null : text.match(/\bPlayers:\s*(\d+)\b/i);
  const uptimeMatch = text.match(/\bUptime:\s*([^\n\r]+)/i);
  const seasonMatch = text.match(/\bSeason\s+#?(\d+)\b/i);

  const statusText = statusMatch ? sanitizeDisplayText(statusMatch[1], 40).toUpperCase() : "";
  const online = statusText === "ONLINE"
    ? true
    : statusText === "OFFLINE"
      ? false
      : null;

  return {
    statusText,
    online,
    ip: sanitizeHost(ipMatch ? ipMatch[1] : ""),
    port: normalizeOptionalInteger(portMatch ? portMatch[1] : null, 1, 65535),
    playersOnline: normalizeOptionalInteger(
      playersWithCapMatch ? playersWithCapMatch[1] : playersSingleMatch ? playersSingleMatch[1] : null,
      0,
      500000
    ),
    maxPlayers: normalizeOptionalInteger(playersWithCapMatch ? playersWithCapMatch[2] : null, 0, 500000),
    uptime: sanitizeDisplayText(uptimeMatch ? uptimeMatch[1] : "", 120),
    seasonLabel: seasonMatch ? `Season ${seasonMatch[1]}` : ""
  };
}

function formatFonlineUptime(seconds) {
  const totalSeconds = normalizeOptionalInteger(seconds, 0, 315360000);

  if (totalSeconds === null) {
    return "";
  }

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}д ${String(hours).padStart(2, "0")}ч ${String(minutes).padStart(2, "0")}м`;
  }

  if (hours > 0) {
    return `${hours}ч ${String(minutes).padStart(2, "0")}м`;
  }

  return `${minutes}м`;
}

function formatCheckedAt(value) {
  const numeric = normalizeOptionalInteger(value, 0, 32503680000);

  if (numeric === null) {
    return "";
  }

  const timestamp = numeric > 9999999999 ? numeric : numeric * 1000;
  const date = new Date(timestamp);

  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function parseFonlineStatusApiPayload(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  const online = typeof data.online === "boolean"
    ? data.online
    : null;

  return {
    statusText: online === true
      ? "ONLINE"
      : online === false
        ? "OFFLINE"
        : "UNKNOWN",
    online,
    ip: sanitizeHost(data.host || data.ip || ""),
    port: normalizeOptionalInteger(data.port, 1, 65535),
    playersOnline: normalizeOptionalInteger(data.players ?? data.playersOnline, 0, 500000),
    maxPlayers: normalizeOptionalInteger(data.maxPlayers ?? data.max_players ?? data.capacity, 0, 500000),
    uptime: formatFonlineUptime(data.uptime_seconds ?? data.uptimeSeconds ?? data.uptime),
    checkedAt: formatCheckedAt(data.checked_at ?? data.checkedAt),
    errorText: sanitizeDisplayText(data.error || data.message, 160)
  };
}

function getFonlineSourceLabel(mode) {
  switch (mode) {
    case "tcp+api":
      return "Официальный live-источник";
    case "api-only":
      return "Официальный live-источник";
    case "tcp+widget":
      return "Официальный виджет";
    case "widget-only":
      return "Официальный виджет";
    case "html-only":
      return "Официальная страница";
    case "site-only":
      return "Кураторский список";
    default:
      return "Страница статуса";
  }
}

function probeTcpTarget(host, port, timeoutMs = FONLINE_STATUS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    function finalize(error) {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();

      if (error) {
        reject(error);
        return;
      }

      resolve({
        online: true,
        latencyMs: Date.now() - startedAt
      });
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalize(null));
    socket.once("timeout", () => finalize(new Error(`TCP probe timed out after ${timeoutMs}ms.`)));
    socket.once("error", (error) => finalize(error));
    socket.connect(port, host);
  });
}

async function fetchFonlineStatusSnapshot(definition) {
  const targetUrl = definition.statusPageUrl || definition.websiteUrl;

  if (!targetUrl) {
    return null;
  }

  const html = await fetchText(targetUrl, `${definition.name} status page`);
  return parseFonlineStatusSnapshot(html);
}

async function fetchFonlineStatusApi(definition) {
  if (!definition.statusApiUrl) {
    return null;
  }

  const payload = await fetchJson(definition.statusApiUrl, `${definition.name} status API`);
  return parseFonlineStatusApiPayload(payload);
}

async function buildFonlineServerPayload(definition) {
  const notes = [];
  let apiSnapshot = null;
  let snapshot = null;
  let probeResult = null;
  let apiError = null;
  let probeError = null;
  let snapshotError = null;

  if (definition.statusApiUrl) {
    try {
      apiSnapshot = await fetchFonlineStatusApi(definition);
    } catch (error) {
      apiError = error;
    }
  }

  if (definition.statusPageUrl || definition.websiteUrl) {
    try {
      snapshot = await fetchFonlineStatusSnapshot(definition);
    } catch (error) {
      snapshotError = error;
    }
  }

  if (definition.gameHost && definition.gamePort) {
    try {
      probeResult = await probeTcpTarget(definition.gameHost, definition.gamePort, FONLINE_STATUS_TIMEOUT_MS);
    } catch (error) {
      probeError = error;
    }
  }

  if (definition.statusImageUrl) {
    notes.push("Доступен официальный статус-виджет.");
  }

  if (definition.statusApiUrl && apiSnapshot) {
    if (apiSnapshot.online === true) {
      notes.push("Официальный live-источник сообщает, что сервер онлайн.");
    } else if (apiSnapshot.online === false) {
      notes.push("Официальный live-источник сообщает, что сервер недоступен.");
    } else {
      notes.push("Официальный live-источник не дал точный статус.");
    }

    if (apiSnapshot.playersOnline !== null) {
      notes.push(`Игроков сейчас: ${apiSnapshot.playersOnline}.`);
    }
  }

  if (snapshot?.statusText) {
    notes.push(`Страница проекта сообщает: ${snapshot.statusText}.`);
  }

  if (probeResult?.online) {
    notes.push(`TCP-проверка ${definition.gameHost}:${definition.gamePort} успешна.`);
  } else if (probeError) {
    notes.push(`TCP-проверка не прошла: ${sanitizeDisplayText(probeError.message, 120)}`);
  }

  if (apiError) {
    notes.push(`Live-источник недоступен: ${sanitizeDisplayText(apiError.message, 120)}`);
  }

  if (snapshotError) {
    notes.push(`Страница статуса недоступна: ${sanitizeDisplayText(snapshotError.message, 120)}`);
  }

  const resolvedHost = apiSnapshot?.ip || snapshot?.ip || definition.gameHost || "";
  const resolvedPort = apiSnapshot?.port || snapshot?.port || definition.gamePort || null;
  const address = resolvedHost && resolvedPort
    ? `${resolvedHost}:${resolvedPort}`
    : resolvedHost
      ? resolvedHost
      : "";

  let online = null;

  if (probeResult?.online) {
    online = true;
  } else if (typeof apiSnapshot?.online === "boolean") {
    online = apiSnapshot.online;
  } else if (probeError && definition.gameHost && definition.gamePort) {
    online = false;
  } else if (typeof snapshot?.online === "boolean") {
    online = snapshot.online;
  }

  return {
    ...definition,
    sourceLabel: definition.sourceLabel || getFonlineSourceLabel(definition.preferredSource),
    address,
    online,
    latencyMs: probeResult?.latencyMs ?? null,
    playersOnline: apiSnapshot?.playersOnline ?? snapshot?.playersOnline ?? null,
    maxPlayers: apiSnapshot?.maxPlayers ?? snapshot?.maxPlayers ?? null,
    uptime: apiSnapshot?.uptime || snapshot?.uptime || "",
    seasonLabel: snapshot?.seasonLabel || "",
    rawStatusText: apiSnapshot?.statusText || snapshot?.statusText || "",
    checkedAt: apiSnapshot?.checkedAt || "",
    sourceUrl: definition.statusPageUrl || definition.websiteUrl || "",
    fetchedAt: new Date().toISOString(),
    message: notes.join(" "),
    liveSourceOk: Boolean(apiSnapshot),
    tcpProbeSucceeded: Boolean(probeResult?.online),
    tcpProbeError: probeError ? sanitizeDisplayText(probeError.message, 140) : "",
    apiError: apiError ? sanitizeDisplayText(apiError.message, 140) : "",
    snapshotError: snapshotError ? sanitizeDisplayText(snapshotError.message, 140) : ""
  };
}

async function getFonlineServersPayload() {
  const cacheKey = "fonline:servers";
  const cached = getCachedPayload(cacheKey, FONLINE_STATUS_CACHE_TTL_MS);

  if (cached?.items && Array.isArray(cached.items)) {
    return {
      ...cached,
      cached: true
    };
  }

  const definitions = await loadFonlineServerDefinitions();
  const items = await Promise.all(definitions.map((definition) => buildFonlineServerPayload(definition)));
  const sortedItems = items.slice().sort((left, right) => {
    const leftWeight = left.online === true ? 0 : left.online === false ? 1 : 2;
    const rightWeight = right.online === true ? 0 : right.online === false ? 1 : 2;

    if (leftWeight !== rightWeight) {
      return leftWeight - rightWeight;
    }

    return MASTERLIST_TEXT_COLLATOR.compare(left.name || "", right.name || "");
  });

  const payload = {
    source: "curated-official",
    configPath: "fonline-servers.json",
    totalServers: sortedItems.length,
    onlineCount: sortedItems.filter((item) => item.online === true).length,
    offlineCount: sortedItems.filter((item) => item.online === false).length,
    unknownCount: sortedItems.filter((item) => item.online === null).length,
    widgetCount: sortedItems.filter((item) => item.statusImageUrl).length,
    fetchedAt: new Date().toISOString(),
    cached: false,
    items: sortedItems
  };

  setCachedPayload(cacheKey, payload);
  return payload;
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("FalloutFanatics FOnline API is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "falloutfanatics-fonline-api",
    time: new Date().toISOString()
  });
});

app.get("/api/fonline-servers", async (_req, res) => {
  try {
    const payload = await getFonlineServersPayload();
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      error: "FONLINE_STATUS_FETCH_FAILED",
      message: error?.message || "Unable to build FOnline server list.",
      fetchedAt: new Date().toISOString(),
      items: []
    });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`FOnline API listening on http://${HOST}:${PORT}`);
});
