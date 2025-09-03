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

    if (!TWITTER_BEARER_TOKEN || !TARGET_TWITTER_USERNAMES || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(400).json({ ok: false, error: "Missing required env vars" });
    }

    const usernames = TARGET_TWITTER_USERNAMES.split(",").map(u => u.trim().toLowerCase());

    // Redis get
    async function redisGet(key) {
      if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;
      const r = await fetch(`${UPSTASH_REDIS_REST_URL}/get/${key}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
      });
      const j = await r.json();
      return j?.result ?? null;
    }

    // Redis set
    async function redisSet(key, value) {
      if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return;
      await fetch(`${UPSTASH_REDIS_REST_URL}/set/${key}/${value}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
        method: "POST"
      });
    }

    // Get user id
    async function getUserId(username) {
      const r = await fetch(`https://api.twitter.com/2/users/by/username/${username}`, {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` }
      });
      const j = await r.json();
      if (!j?.data?.id) throw new Error("User not found: " + username);
      return j.data.id;
    }

    // Fetch tweets
    async function fetchTweets(userId, sinceId) {
      const params = new URLSearchParams({
        "max_results": "5",
        "exclude": "replies,retweets"
      });
      if (sinceId) params.set("since_id", sinceId);

      const url = `https://api.twitter.com/2/users/${userId}/tweets?${params}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` } });
      const j = await r.json();
      return Array.isArray(j?.data) ? j.data : [];
    }

    // Send to Telegram
    async function sendToTelegram(text) {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" };
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }

    let results = [];

    for (const username of usernames) {
      const redisKey = `last_tweet_id:${username}`;
      const userId = await getUserId(username);
      const lastSeenId = await redisGet(redisKey);
      const tweets = await fetchTweets(userId, lastSeenId);

      if (tweets.length === 0) {
        results.push({ username, message: "No new tweets" });
        continue;
      }

      // sort oldest → newest
      tweets.sort((a, b) => (a.id > b.id ? 1 : -1));

      let newestId = lastSeenId || "0";
      for (const t of tweets) {
        const tweetUrl = `https://twitter.com/${username}/status/${t.id}`;
        const text = `<b>@${username}</b> tweeted:\n\n${escapeHtml(t.text)}\n\n${tweetUrl}`;
        await sendToTelegram(text);
        if (t.id > newestId) newestId = t.id;
      }

      await redisSet(redisKey, newestId);
      results.push({ username, posted: tweets.length, last_id: newestId });
    }

    return res.status(200).json({ ok: true, results });

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
