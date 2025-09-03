export default async function handler(req, res) {
  try {
    const {
      TWITTER_BEARER_TOKEN,
      TARGET_TWITTER_USERNAMES,
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID,
      UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN,
    } = process.env;

    // Optional query-driven debug/diagnostics controls
    const urlObj = (() => {
      try { return new URL(req?.url || "", "http://localhost"); } catch { return null; }
    })();
    const qp = (k) => {
      const v1 = req?.query?.[k];
      if (v1 != null) return Array.isArray(v1) ? v1[0] : v1;
      const v2 = urlObj?.searchParams?.get?.(k);
      return v2 != null ? v2 : undefined;
    };
    const truthy = (v) => ["1","true","yes","on"].includes(String(v).toLowerCase());
    const debugMode = truthy(qp("debug"));
    const dryRun = truthy(qp("dry"));
    const overrideUsernamesRaw = qp("usernames");
    const limitParam = qp("limit");
    const includeParam = qp("include"); // comma-separated: e.g. "retweets,replies"

    if (!TWITTER_BEARER_TOKEN || !TARGET_TWITTER_USERNAMES || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(400).json({ ok: false, error: "Missing required env vars" });
    }

    // Normalize Twitter bearer token to avoid duplicated prefix and set defaults
    const normalizedTwitterToken = String(TWITTER_BEARER_TOKEN || "").trim();
    const twitterAuthHeaderValue = normalizedTwitterToken.toLowerCase().startsWith("bearer ")
      ? normalizedTwitterToken
      : `Bearer ${normalizedTwitterToken}`;
    const TWITTER_API_BASE_URL = process.env.TWITTER_API_BASE_URL || "https://api.twitter.com/2";
    const defaultTwitterHeaders = {
      Authorization: twitterAuthHeaderValue,
      "User-Agent": "tweet-to-telegram/1.0"
    };
    // Coordinate Twitter rate limiting across invocations via Redis
    const tokenSuffix = normalizedTwitterToken.slice(-8) || "token";
    const RATE_LIMIT_KEY = `twitter_rate_limit_blocked_until:${tokenSuffix}`;

    async function getRateLimitBlockedUntilMs() {
      const raw = await redisGet(RATE_LIMIT_KEY);
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }

    async function setRateLimitBlockedUntilMs(msEpoch) {
      if (!msEpoch) return;
      await redisSet(RATE_LIMIT_KEY, String(msEpoch));
    }

    function parseRateLimitResetMsFromHeaders(headers) {
      try {
        const reset = Number(headers?.get?.("x-rate-limit-reset"));
        if (Number.isFinite(reset) && reset > 0) {
          return reset * 1000;
        }
        const retryAfter = Number(headers?.get?.("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          return Date.now() + retryAfter * 1000;
        }
      } catch {}
      // Fallback: 15 minutes
      return Date.now() + 15 * 60 * 1000;
    }

    let rateLimitedTriggered = false;

    const targetUsernamesStr = overrideUsernamesRaw ? String(overrideUsernamesRaw) : TARGET_TWITTER_USERNAMES;
    const usernames = Array.from(new Set(
      targetUsernamesStr
        .split(",")
        .map(u => u.trim().toLowerCase().replace(/^@+/, ""))
        .filter(u => u.length > 0)
    ));

    if (usernames.length === 0) {
      return res.status(400).json({ ok: false, error: "No valid usernames provided" });
    }
    // Pre-flight: if rate-limited, avoid hitting Twitter
    const preflightBlockedUntil = await getRateLimitBlockedUntilMs();
    if (preflightBlockedUntil && Date.now() < preflightBlockedUntil) {
      const iso = new Date(preflightBlockedUntil).toISOString();
      const results = usernames.map(username => ({ username, error: `Twitter rate limited until ${iso}` }));
      return res.status(200).json({ ok: true, rate_limited_until: iso, results });
    }

    // Redis get
    async function redisGet(key) {
      if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;
      const safeKey = encodeURIComponent(key);
      const r = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${safeKey}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
      });
      const j = await r.json().catch(() => null);
      return j?.result ?? null;
    }

    // Redis set
    async function redisSet(key, value) {
      if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return;
      const safeKey = encodeURIComponent(key);
      const safeVal = encodeURIComponent(String(value));
      await fetch(`${UPSTASH_REDIS_REST_URL}/set/${safeKey}/${safeVal}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
        method: "POST"
      }).catch(() => {});
    }

    // Simple sleep helper
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Fetch with retry/backoff for transient errors and rate limits
    async function fetchWithRetry(url, options = {}, retryConfig = {}) {
      const {
        retries = 3,
        initialDelayMs = 800,
        maxDelayMs = 10_000,
        jitter = true,
        retryOnStatuses = [429, 500, 502, 503, 504]
      } = retryConfig;

      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const r = await fetch(url, options);
          if (r?.status === 429) {
            const untilMs = parseRateLimitResetMsFromHeaders(r.headers);
            await setRateLimitBlockedUntilMs(untilMs);
            rateLimitedTriggered = true;
          }
          if (!r.ok && retryOnStatuses.includes(r.status) && attempt < retries) {
            attempt++;
            let delayMs = initialDelayMs * Math.pow(2, attempt - 1);
            const retryAfter = r.headers?.get?.("retry-after");
            if (retryAfter) {
              const retryAfterSeconds = Number(retryAfter);
              if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
                delayMs = Math.max(delayMs, retryAfterSeconds * 1000);
              }
            }
            if (jitter) {
              const rand = Math.random() * 0.25 + 0.9; // 0.9x - 1.15x
              delayMs = Math.floor(delayMs * rand);
            }
            if (delayMs > maxDelayMs) delayMs = maxDelayMs;
            await sleep(delayMs);
            continue;
          }
          return r;
        } catch (e) {
          if (attempt >= retries) throw e;
          attempt++;
          let delayMs = initialDelayMs * Math.pow(2, attempt - 1);
          if (jitter) {
            const rand = Math.random() * 0.25 + 0.9;
            delayMs = Math.floor(delayMs * rand);
          }
          if (delayMs > maxDelayMs) delayMs = maxDelayMs;
          await sleep(delayMs);
          continue;
        }
      }
    }

    // Batch user id resolver with Redis cache
    async function getUserIds(usernamesList) {
      const usernameToId = {};
      const missing = [];
      for (const name of usernamesList) {
        const cached = await redisGet(`twitter_user_id:${name}`);
        if (cached) {
          usernameToId[name] = cached;
        } else {
          missing.push(name);
        }
      }

      if (missing.length > 0) {
        const chunkSize = 100;
        for (let i = 0; i < missing.length; i += chunkSize) {
          const chunk = missing.slice(i, i + chunkSize);
          const params = new URLSearchParams({ usernames: chunk.join(",") });
          const url = `${TWITTER_API_BASE_URL}/users/by?${params}`;
          const r = await fetchWithRetry(url, {
            headers: defaultTwitterHeaders
          }, { retries: 4, initialDelayMs: 1200 });
          if (!r.ok) {
            const text = await r.text().catch(() => "");
            throw new Error(`Twitter user lookup failed (${r.status}) for @${chunk.join(",@")}: ${text}`);
          }
          const j = await r.json();
          const found = Array.isArray(j?.data) ? j.data : [];
          for (const u of found) {
            const key = String(u.username || "").toLowerCase();
            if (key) {
              usernameToId[key] = String(u.id);
              // Best-effort cache
              // no await to avoid serial latency, but maintain order with await Promise.all if needed
              // here we sequentially await to keep code simple and predictable
              await redisSet(`twitter_user_id:${key}`, String(u.id));
            }
          }
          // Mark not found ones explicitly as null
          const foundSet = new Set(found.map(u => String(u.username || "").toLowerCase()));
          for (const nm of chunk) {
            if (!foundSet.has(nm) && usernameToId[nm] == null) {
              usernameToId[nm] = null;
            }
          }
        }
      }

      return usernameToId;
    }

    // Tuning: include/exclude and limits
    const includeTokens = new Set(
      String(includeParam || "")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );
    let excludeList = ["replies","retweets"]; // default behavior: exclude both
    if (includeTokens.has("replies")) excludeList = excludeList.filter(x => x !== "replies");
    if (includeTokens.has("retweets")) excludeList = excludeList.filter(x => x !== "retweets");
    let desiredMaxResults = 5;
    if (limitParam != null) {
      const n = Number(limitParam);
      if (Number.isFinite(n) && n >= 1 && n <= 100) desiredMaxResults = Math.floor(n);
    }

    // Fetch tweets
    async function fetchTweets(userId, sinceId) {
      const params = new URLSearchParams({
        "max_results": String(desiredMaxResults)
      });
      if (excludeList.length > 0) params.set("exclude", excludeList.join(","));
      if (sinceId) params.set("since_id", sinceId);

      const url = `${TWITTER_API_BASE_URL}/users/${userId}/tweets?${params}`;
      const r = await fetchWithRetry(url, { headers: defaultTwitterHeaders }, { retries: 4, initialDelayMs: 1200 });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Twitter tweets fetch failed (${r.status}) for userId=${userId}: ${text}`);
      }
      const j = await r.json();
      return Array.isArray(j?.data) ? j.data : [];
    }

    // Send to Telegram
    async function sendToTelegram(text) {
      if (dryRun) return; // skip network call in dry-run
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" };
      const r = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }, { retries: 3, initialDelayMs: 800 });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Telegram sendMessage failed (${r.status}): ${text}`);
      }
    }

    let results = [];

    let usernameToId;
    try {
      usernameToId = await getUserIds(usernames);
    } catch (e) {
      const blockedUntil = await getRateLimitBlockedUntilMs();
      if (rateLimitedTriggered || (blockedUntil && Date.now() < blockedUntil)) {
        const iso = blockedUntil ? new Date(blockedUntil).toISOString() : undefined;
        const perUser = usernames.map(username => ({ username, error: `Twitter rate limited${iso ? ` until ${iso}` : ""}` }));
        return res.status(200).json({ ok: true, rate_limited_until: iso, results: perUser });
      }
      const perUser = usernames.map(username => ({ username, error: String(e?.message || e) }));
      return res.status(200).json({ ok: true, results: perUser });
    }

    for (const username of usernames) {
      if (rateLimitedTriggered) {
        const blockedUntil = await getRateLimitBlockedUntilMs();
        const iso = blockedUntil ? new Date(blockedUntil).toISOString() : undefined;
        results.push({ username, error: `Twitter rate limited${iso ? ` until ${iso}` : ""}` });
        continue;
      }
      try {
        const redisKey = `last_tweet_id:${username}`;
        const userId = usernameToId[username];
        if (!userId) {
          results.push({ username, error: `User not found or lookup failed` });
          continue;
        }
        const lastSeenId = await redisGet(redisKey);
        const tweets = await fetchTweets(userId, lastSeenId);

        if (tweets.length === 0) {
          results.push({ username, message: "No new tweets", debug: debugMode ? { exclude: excludeList, max_results: desiredMaxResults } : undefined });
          continue;
        }

        // sort oldest → newest using BigInt-safe comparison
        tweets.sort((a, b) => {
          try {
            const aId = BigInt(a.id);
            const bId = BigInt(b.id);
            if (aId === bId) return 0;
            return aId < bId ? -1 : 1;
          } catch {
            return a.id > b.id ? 1 : -1;
          }
        });

        let newestId = lastSeenId || "0";
        for (const t of tweets) {
          const tweetUrl = `https://twitter.com/${username}/status/${t.id}`;
          const text = `<b>@${username}</b> tweeted:\n\n${escapeHtml(t.text)}\n\n${tweetUrl}`;
          await sendToTelegram(text);
          try {
            if (BigInt(t.id) > BigInt(newestId)) newestId = t.id;
          } catch {
            if (t.id > newestId) newestId = t.id;
          }
        }

        await redisSet(redisKey, newestId);
        results.push({ username, posted: tweets.length, last_id: newestId, dry_run: dryRun || undefined, debug: debugMode ? { exclude: excludeList, max_results: desiredMaxResults } : undefined });
      } catch (userErr) {
        // surface more context in debug mode
        const baseErr = String(userErr?.message || userErr);
        const dbg = debugMode ? {
          exclude: excludeList,
          max_results: desiredMaxResults,
          telegram_chat_id: TELEGRAM_CHAT_ID ? (String(TELEGRAM_CHAT_ID).startsWith("@") ? TELEGRAM_CHAT_ID : "[numeric chat id provided]") : undefined
        } : undefined;
        results.push({ username, error: baseErr, debug: dbg });
      }
    }

    return res.status(200).json({ ok: true, results, dry_run: dryRun || undefined, debug: debugMode || undefined });

  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;");
}
