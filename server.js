
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
  }
}

async function fetchPageStatus(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "falloutfanatics-fonline-api/1.0",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });
    const html = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      title: extractHtmlTitle(html)
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSteamCurrentPlayers(appId = FALLOUT76_STEAM_APP_ID) {
  const payload = await fetchJson(
    `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`,
    "Steam current players API"
  );

  return normalizeOptionalInteger(payload?.response?.player_count, 0, 50000000);
}

function extractPlainTextFromHtml(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .trim();
}

function extractHtmlTitle(html) {
  const match = String(html || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return sanitizeDisplayText(match ? extractPlainTextFromHtml(match[1]) : "", 160);
}

function parseFonlineStatusSnapshot(html) {
  const text = extractPlainTextFromHtml(html);

  return payload;
}

function getFallout76StateFromStatus(ok, hasValue = true) {
  if (ok === true && hasValue) {
    return "online";
  }

  if (ok === false) {
    return "offline";
  }

  return "unknown";
}

async function getFallout76StatusPayload() {
  const cacheKey = "fallout76:status";
  const cached = getCachedPayload(cacheKey, FALLOUT76_STATUS_CACHE_TTL_MS);

  if (cached?.items && Array.isArray(cached.items)) {
    return {
      ...cached,
      cached: true
    };
  }

  const [steamResult, officialResult, hubResult, supportResult] = await Promise.allSettled([
    fetchSteamCurrentPlayers(),
    fetchPageStatus(FALLOUT76_OFFICIAL_SITE_URL, "Fallout 76 official site"),
