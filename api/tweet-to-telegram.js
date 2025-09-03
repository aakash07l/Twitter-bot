// Serverless function that polls Twitter (X) for a username's latest tweets
// and forwards new ones to a Telegram channel.
//
// ENV VARS to set in Vercel Project Settings:
//   TWITTER_BEARER_TOKEN=...        (from https://developer.x.com/ )
//   TARGET_TWITTER_USERNAME=jack    (the handle you want to track, without @)
//   TELEGRAM_BOT_TOKEN=...          (create bot via @BotFather)
//   TELEGRAM_CHAT_ID=...            (channel ID, e.g. -1001234567890; add bot as admin)
// Optional (recommended for persistence):
//   UPSTASH_REDIS_REST_URL=...      (Vercel integration: Upstash Redis)
//   UPSTASH_REDIS_REST_TOKEN=...

export default async function handler(req, res) {
  try {
    const {
      TWITTER_BEARER_TOKEN,
      TARGET_TWITTER_USERNAME,
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID,
      UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN,
    } = process.env;

    if (!TWITTER_BEARER_TOKEN || !TARGET_TWITTER_USERNAME || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(400).json({ ok: false, error: "Missing required env vars." });
    }

    // --- Simple Upstash REST helpers (optional) ---
    const redisKey = `last_tweet_id:${TARGET_TWITTER_USERNAME.toLowerCase()}`;

    async function redisGet(key) {
      if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;
      const r = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
        cache: "no-store"
      });
      const data = await r.json().catch(() => ({}));
      return data?.result ?? null;
    }

    async function redisSet(key, value) {
      if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return;
      await fetch(`${UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
        method: "POST"
      });
    }

    // --- 1) Resolve username -> user id ---
    async function getUserId(username) {
      const url = `https://api.twitter.com/2/users/by/username/${encodeURIComponent(username)}?user.fields=id`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` }
      });
      if (!r.ok) throw new Error(`Twitter getUserId failed: ${r.status}`);
      const j = await r.json();
      if (!j?.data?.id) throw new Error(`No user id for @${username}`);
      return j.data.id;
    }

    // --- 2) Fetch tweets since last seen ---
    async function fetchTweets(userId, sinceId) {
      const params = new URLSearchParams({
        "max_results": "5",
        "exclude": "replies,retweets",
        "tweet.fields": "created_at"
      });
      if (sinceId) params.set("since_id", sinceId);

      const url = `https://api.twitter.com/2/users/${userId}/tweets?` + params.toString();
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
        cache: "no-store"
      });
      if (!r.ok) throw new Error(`Twitter fetchTweets failed: ${r.status}`);
      const j = await r.json();
      return Array.isArray(j?.data) ? j.data : [];
    }

    // --- 3) Send to Telegram ---
    async function sendToTelegram(text, disableWebPagePreview = false) {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      const body = {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: disableWebPagePreview
      };
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`Telegram sendMessage failed: ${r.status} ${errText}`);
      }
    }

    const userId = await getUserId(TARGET_TWITTER_USERNAME);
    const lastSeenId = await redisGet(redisKey);

    const tweets = await fetchTweets(userId, lastSeenId);
    if (tweets.length === 0) {
      return res.status(200).json({ ok: true, message: "No new tweets." });
    }

    // Sort oldest -> newest so Telegram channel stays chronological
    tweets.sort((a, b) => (a.id > b.id ? 1 : -1));

    // Post each tweet
    let newestId = lastSeenId || "0";
    for (const t of tweets) {
      const tweetUrl = `https://twitter.com/${TARGET_TWITTER_USERNAME}/status/${t.id}`;
      const text = [
        `<b>@${TARGET_TWITTER_USERNAME}</b> tweeted:`,
        "",
        escapeHtml(t.text || ""),
        "",
        tweetUrl
      ].join("\n");

      await sendToTelegram(text, false);
      if (t.id > newestId) newestId = t.id;
    }

    // Persist the newest id (if Upstash configured)
    await redisSet(redisKey, newestId);

    return res.status(200).json({ ok: true, posted: tweets.length, last_id: newestId });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

// Simple HTML escape for Telegram HTML parse_mode
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
