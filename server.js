import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import crypto from "crypto";

// --- Config ---
const PORT = process.env.PORT || 9533;
const CONSUMER_KEY = process.env.TWITTER_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.TWITTER_CONSUMER_SECRET;
const ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.TWITTER_ACCESS_TOKEN_SECRET;
const API_BASE = "https://api.twitter.com";

if (!CONSUMER_KEY || !CONSUMER_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error("Missing Twitter credentials in env");
  process.exit(1);
}

// --- OAuth 1.0a signing ---
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, "%21").replace(/\*/g, "%2A")
    .replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function generateNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function oauthSign(method, url, params = {}) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = generateNonce();

  const oauthParams = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: ACCESS_TOKEN,
    oauth_version: "1.0",
  };

  // Combine all params for signature base
  const allParams = { ...oauthParams, ...params };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys.map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`).join("&");

  const signatureBase = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(CONSUMER_SECRET)}&${percentEncode(ACCESS_TOKEN_SECRET)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(signatureBase).digest("base64");

  oauthParams.oauth_signature = signature;

  const authHeader = "OAuth " + Object.keys(oauthParams)
    .sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");

  return authHeader;
}

// --- API helper ---
async function twitterAPI(method, path, { query, body } = {}) {
  const url = new URL(path, API_BASE);
  const queryParams = {};
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
      queryParams[k] = v;
    }
  }

  // For GET requests, include query params in OAuth signature
  // For POST/DELETE with JSON body, don't include body params in signature
  const signParams = method === "GET" ? queryParams : {};
  const authHeader = oauthSign(method, url.origin + url.pathname, signParams);

  const headers = { Authorization: authHeader };
  const fetchOpts = { method, headers };

  if (body) {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), fetchOpts);
  const text = await res.text();

  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const errMsg = data?.detail || data?.errors?.[0]?.message || data?.title || text;
    throw new Error(`Twitter API ${res.status}: ${errMsg}`);
  }
  return data;
}

// --- Media upload (v1.1) ---
const UPLOAD_BASE = "https://upload.twitter.com";

async function uploadMedia(imageBuffer, mimeType = "image/png") {
  const url = `${UPLOAD_BASE}/1.1/media/upload.json`;
  const authHeader = oauthSign("POST", url, {});

  const boundary = `----NodeFormBoundary${crypto.randomBytes(8).toString("hex")}`;
  const b64 = imageBuffer.toString("base64");
  const category = mimeType === "image/gif" ? "tweet_gif" : "tweet_image";

  const bodyStr = [
    `--${boundary}\r\nContent-Disposition: form-data; name="media_data"\r\n\r\n${b64}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="media_category"\r\n\r\n${category}\r\n`,
    `--${boundary}--\r\n`
  ].join("");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyStr,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const errMsg = data?.errors?.[0]?.message || data?.error || text;
    throw new Error(`Media upload ${res.status}: ${errMsg}`);
  }
  return data.media_id_string;
}

async function fetchImageBuffer(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const contentType = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: contentType };
}

// --- Cache user ID ---
let cachedUserId = null;
let cachedUsername = null;

async function getMe() {
  if (cachedUserId) return { id: cachedUserId, username: cachedUsername };
  const data = await twitterAPI("GET", "/2/users/me", {
    query: { "user.fields": "id,name,username,description,public_metrics" }
  });
  cachedUserId = data.data.id;
  cachedUsername = data.data.username;
  return data.data;
}

// --- MCP Server ---
const server = new McpServer({ name: "twitter-mcp-server", version: "1.0.0" });

// 1. Post tweet
server.tool("twitter_post_tweet", "Post a tweet (max 280 chars). Optionally attach images by media_ids (from twitter_upload_media).",
  {
    text: z.string().max(280).describe("Tweet text content"),
    media_ids: z.array(z.string()).max(4).optional().describe("Array of media IDs from twitter_upload_media (max 4)")
  },
  async ({ text, media_ids }) => {
    try {
      const body = { text };
      if (media_ids?.length) body.media = { media_ids };
      const data = await twitterAPI("POST", "/2/tweets", { body });
      const tweetId = data.data.id;
      const user = await getMe();
      return { content: [{ type: "text", text: `✅ Tweet posted!\nID: ${tweetId}\nURL: https://x.com/${user.username}/status/${tweetId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 2. Delete tweet
server.tool("twitter_delete_tweet", "Delete a tweet by ID",
  { tweet_id: z.string().describe("Tweet ID to delete") },
  async ({ tweet_id }) => {
    try {
      await twitterAPI("DELETE", `/2/tweets/${tweet_id}`);
      return { content: [{ type: "text", text: `✅ Tweet ${tweet_id} deleted` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 3. Get my info
server.tool("twitter_get_me", "Get authenticated user's profile info", {},
  async () => {
    try {
      const data = await twitterAPI("GET", "/2/users/me", {
        query: { "user.fields": "id,name,username,description,public_metrics,created_at,profile_image_url" }
      });
      const u = data.data;
      const m = u.public_metrics || {};
      return { content: [{ type: "text", text: `👤 @${u.username} (${u.name})\nID: ${u.id}\nBio: ${u.description || "(none)"}\nFollowers: ${m.followers_count} | Following: ${m.following_count} | Tweets: ${m.tweet_count}\nJoined: ${u.created_at || "N/A"}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 4. Get user tweets (own timeline)
server.tool("twitter_get_user_tweets", "Get recent tweets from a user (default: self)",
  {
    username: z.string().optional().describe("Username (without @). Omit for own tweets."),
    max_results: z.number().min(5).max(100).default(10).optional().describe("Number of tweets (5-100, default 10)")
  },
  async ({ username, max_results = 10 }) => {
    try {
      let userId;
      if (username) {
        const userData = await twitterAPI("GET", `/2/users/by/username/${username}`, {
          query: { "user.fields": "id" }
        });
        userId = userData.data.id;
      } else {
        const me = await getMe();
        userId = me.id;
        username = me.username;
      }

      const data = await twitterAPI("GET", `/2/users/${userId}/tweets`, {
        query: {
          max_results: String(max_results),
          "tweet.fields": "created_at,public_metrics,text"
        }
      });

      if (!data.data?.length) return { content: [{ type: "text", text: `No tweets found for @${username}` }] };

      const lines = data.data.map((t, i) => {
        const m = t.public_metrics || {};
        return `${i + 1}. [${t.created_at?.slice(0, 10) || "?"}] ${t.text.slice(0, 120)}${t.text.length > 120 ? "..." : ""}\n   ❤ ${m.like_count || 0}  🔁 ${m.retweet_count || 0}  💬 ${m.reply_count || 0}  ID: ${t.id}`;
      });
      return { content: [{ type: "text", text: `📝 @${username}'s recent tweets:\n\n${lines.join("\n\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 5. Get home timeline
server.tool("twitter_get_timeline", "Get home timeline (tweets from people you follow). Requires Basic tier or above.",
  {
    max_results: z.number().min(1).max(100).default(10).optional().describe("Number of tweets (1-100, default 10)")
  },
  async ({ max_results = 10 }) => {
    try {
      const me = await getMe();
      const data = await twitterAPI("GET", `/2/users/${me.id}/timelines/reverse_chronological`, {
        query: {
          max_results: String(max_results),
          "tweet.fields": "created_at,public_metrics,text,author_id",
          expansions: "author_id",
          "user.fields": "username,name"
        }
      });

      if (!data.data?.length) return { content: [{ type: "text", text: "Timeline is empty" }] };

      const users = {};
      (data.includes?.users || []).forEach(u => { users[u.id] = u; });

      const lines = data.data.map((t, i) => {
        const author = users[t.author_id] || {};
        const m = t.public_metrics || {};
        return `${i + 1}. @${author.username || "?"} (${author.name || "?"})\n   ${t.text.slice(0, 140)}${t.text.length > 140 ? "..." : ""}\n   ❤ ${m.like_count || 0}  🔁 ${m.retweet_count || 0}  💬 ${m.reply_count || 0}  [${t.created_at?.slice(0, 10) || "?"}]  ID: ${t.id}`;
      });
      return { content: [{ type: "text", text: `🏠 Home timeline:\n\n${lines.join("\n\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 6. Get mentions
server.tool("twitter_get_mentions", "Get recent mentions (@replies) of the authenticated user",
  {
    max_results: z.number().min(5).max(100).default(10).optional().describe("Number of mentions (5-100, default 10)")
  },
  async ({ max_results = 10 }) => {
    try {
      const me = await getMe();
      const data = await twitterAPI("GET", `/2/users/${me.id}/mentions`, {
        query: {
          max_results: String(max_results),
          "tweet.fields": "created_at,public_metrics,text,author_id",
          expansions: "author_id",
          "user.fields": "username,name"
        }
      });

      if (!data.data?.length) return { content: [{ type: "text", text: "No recent mentions" }] };

      const users = {};
      (data.includes?.users || []).forEach(u => { users[u.id] = u; });

      const lines = data.data.map((t, i) => {
        const author = users[t.author_id] || {};
        const m = t.public_metrics || {};
        return `${i + 1}. @${author.username || "?"}: ${t.text.slice(0, 140)}${t.text.length > 140 ? "..." : ""}\n   ❤ ${m.like_count || 0}  🔁 ${m.retweet_count || 0}  [${t.created_at?.slice(0, 10) || "?"}]  ID: ${t.id}`;
      });
      return { content: [{ type: "text", text: `📢 Recent mentions:\n\n${lines.join("\n\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 7. Search tweets
server.tool("twitter_search", "Search recent tweets (last 7 days)",
  {
    query: z.string().describe("Search query"),
    max_results: z.number().min(10).max(100).default(10).optional().describe("Number of results (10-100, default 10)")
  },
  async ({ query, max_results = 10 }) => {
    try {
      const data = await twitterAPI("GET", "/2/tweets/search/recent", {
        query: {
          query,
          max_results: String(max_results),
          "tweet.fields": "created_at,public_metrics,text,author_id",
          expansions: "author_id",
          "user.fields": "username,name"
        }
      });

      if (!data.data?.length) return { content: [{ type: "text", text: `No tweets found for "${query}"` }] };

      const users = {};
      (data.includes?.users || []).forEach(u => { users[u.id] = u; });

      const lines = data.data.map((t, i) => {
        const author = users[t.author_id] || {};
        const m = t.public_metrics || {};
        return `${i + 1}. @${author.username || "?"}: ${t.text.slice(0, 140)}${t.text.length > 140 ? "..." : ""}\n   ❤ ${m.like_count || 0}  🔁 ${m.retweet_count || 0}  [${t.created_at?.slice(0, 10) || "?"}]  ID: ${t.id}`;
      });
      return { content: [{ type: "text", text: `🔍 Search results for "${query}":\n\n${lines.join("\n\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 8. Reply to tweet
server.tool("twitter_reply", "Reply to a tweet",
  {
    tweet_id: z.string().describe("ID of the tweet to reply to"),
    text: z.string().max(280).describe("Reply text")
  },
  async ({ tweet_id, text }) => {
    try {
      const data = await twitterAPI("POST", "/2/tweets", {
        body: { text, reply: { in_reply_to_tweet_id: tweet_id } }
      });
      const replyId = data.data.id;
      const user = await getMe();
      return { content: [{ type: "text", text: `✅ Replied!\nID: ${replyId}\nURL: https://x.com/${user.username}/status/${replyId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);


// 9. Upload media
server.tool("twitter_upload_media", "Upload an image to Twitter. Returns media_id for use in twitter_post_tweet.",
  {
    image_url: z.string().describe("URL of the image to upload (JPEG/PNG/GIF, max 5MB)")
  },
  async ({ image_url }) => {
    try {
      const { buffer, mimeType } = await fetchImageBuffer(image_url);
      if (buffer.length > 5 * 1024 * 1024) throw new Error("Image too large (max 5MB)");
      const mediaId = await uploadMedia(buffer, mimeType);
      return { content: [{ type: "text", text: `✅ Media uploaded!\nMedia ID: ${mediaId}\nUse this ID in twitter_post_tweet's media_ids parameter.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 10. Tweet with image (convenience: upload + post in one step)
server.tool("twitter_tweet_with_image", "Upload an image and post a tweet with it in one step.",
  {
    text: z.string().max(280).describe("Tweet text content"),
    image_url: z.string().describe("URL of the image to attach (JPEG/PNG/GIF, max 5MB)")
  },
  async ({ text, image_url }) => {
    try {
      const { buffer, mimeType } = await fetchImageBuffer(image_url);
      if (buffer.length > 5 * 1024 * 1024) throw new Error("Image too large (max 5MB)");
      const mediaId = await uploadMedia(buffer, mimeType);
      const data = await twitterAPI("POST", "/2/tweets", {
        body: { text, media: { media_ids: [mediaId] } }
      });
      const tweetId = data.data.id;
      const user = await getMe();
      return { content: [{ type: "text", text: `✅ Tweet with image posted!\nID: ${tweetId}\nURL: https://x.com/${user.username}/status/${tweetId}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);


// 11. Follow a user
server.tool("twitter_follow", "Follow a user by username",
  { username: z.string().describe("Username to follow (without @)") },
  async ({ username }) => {
    try {
      const me = await getMe();
      const userData = await twitterAPI("GET", `/2/users/by/username/${username}`, {
        query: { "user.fields": "id,name,public_metrics" }
      });
      const target = userData.data;
      await twitterAPI("POST", `/2/users/${me.id}/following`, {
        body: { target_user_id: target.id }
      });
      const m = target.public_metrics || {};
      return { content: [{ type: "text", text: `✅ Now following @${username} (${target.name})\nFollowers: ${m.followers_count || 0} | Tweets: ${m.tweet_count || 0}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// 12. Unfollow a user
server.tool("twitter_unfollow", "Unfollow a user by username",
  { username: z.string().describe("Username to unfollow (without @)") },
  async ({ username }) => {
    try {
      const me = await getMe();
      const userData = await twitterAPI("GET", `/2/users/by/username/${username}`, {
        query: { "user.fields": "id" }
      });
      await twitterAPI("DELETE", `/2/users/${me.id}/following/${userData.data.id}`);
      return { content: [{ type: "text", text: `✅ Unfollowed @${username}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `❌ Failed: ${e.message}` }], isError: true };
    }
  }
);

// --- Express + MCP transport ---
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", async (req, res) => {
  try {
    const me = await getMe();
    res.json({ ok: true, user: `@${me.username}`, id: me.id });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// --- Start ---
app.listen(PORT, async () => {
  console.log(`Twitter MCP on port ${PORT}`);
  try {
    const me = await getMe();
    console.log(`Authenticated as @${me.username} (${me.id})`);
  } catch (e) {
    console.warn("Auth check failed:", e.message);
  }
});
