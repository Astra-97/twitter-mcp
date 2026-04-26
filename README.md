# Twitter MCP

A [Model Context Protocol](https://modelcontextprotocol.io/) server for Twitter/X. Connect it to Claude (or any MCP client) to post tweets, read timelines, upload images, search, follow/unfollow — all through natural conversation.

## Features

- **12 tools** — post, delete, reply, search, timeline, mentions, follow/unfollow, media upload
- **OAuth 1.0a** — tokens never expire, no refresh hassle
- **Image support** — upload images and attach to tweets (up to 4 per tweet)
- **Streamable HTTP** — standard MCP transport, works with Claude.ai MCP connectors
- **Zero dependencies on twitter client libraries** — pure OAuth 1.0a signing, no `twitter-api-v2` package needed

## Quick Start

```bash
git clone https://github.com/Astra-97/twitter-mcp.git
cd twitter-mcp
./setup.sh
```

The setup script will:
1. Check Node.js 20+
2. Install npm dependencies
3. Create `.env` from template
4. Optionally install a systemd service

## Manual Setup

```bash
npm install
cp .env.example .env   # fill in your Twitter API keys
./start.sh
```

## Get Your API Keys

1. Go to [developer.x.com](https://developer.x.com) and create a developer account
2. Create an App
3. **App permissions**: Read and write
4. **Type of App**: Web App, Automated App or Bot
5. Fill in App info (Callback URI can be `https://example.com/callback`)
6. Go to **Keys and Tokens**:
   - Copy **Consumer Key** (API Key) and **Consumer Secret** (API Secret)
   - Generate **Access Token** and **Access Token Secret** (OAuth 1.0a section)
   - ⚠️ Copy immediately — some keys are only shown once
7. **Charge credits** at the Developer Portal ($5 minimum) — X API is pay-per-use since Feb 2026

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TWITTER_CONSUMER_KEY` | — | OAuth 1.0a Consumer Key (required) |
| `TWITTER_CONSUMER_SECRET` | — | OAuth 1.0a Consumer Secret (required) |
| `TWITTER_ACCESS_TOKEN` | — | OAuth 1.0a Access Token (required) |
| `TWITTER_ACCESS_TOKEN_SECRET` | — | OAuth 1.0a Access Token Secret (required) |
| `PORT` | `9533` | Server port |

## MCP Endpoint

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP Streamable HTTP endpoint |
| `/health` | GET | Health check (returns authenticated user info) |

## Tools

| Tool | Description | API Cost |
|------|-------------|----------|
| `twitter_post_tweet` | Post a tweet (max 280 chars), optional image attachment | ~$0.01 |
| `twitter_tweet_with_image` | Upload image + post tweet in one step | ~$0.01 |
| `twitter_upload_media` | Upload image, returns media_id for attaching to tweets | — |
| `twitter_delete_tweet` | Delete a tweet by ID | ~$0.01 |
| `twitter_get_me` | Get your profile info | ~$0.01 |
| `twitter_get_user_tweets` | Get recent tweets from any user | ~$0.005 |
| `twitter_get_timeline` | Home timeline (tweets from people you follow) | ~$0.005 |
| `twitter_get_mentions` | Get @mentions | ~$0.005 |
| `twitter_search` | Search recent tweets (last 7 days) | ~$0.005 |
| `twitter_reply` | Reply to a tweet | ~$0.01 |
| `twitter_follow` | Follow a user | ~$0.005 |
| `twitter_unfollow` | Unfollow a user | ~$0.005 |

## Connect to Claude.ai

1. Expose with Cloudflare Tunnel, ngrok, or any reverse proxy
2. In Claude.ai → Settings → MCP → Add connector: `https://your-domain.com/mcp`
3. Done. Ask Claude to "post a tweet" or "check my timeline"

## API Cost Estimate

With $5 credits:
- ~500 tweets
- ~1000 timeline/search reads
- Casual daily use → 3-5 months

## Gotchas

1. **402 "no credits"** — X API is pay-per-use since Feb 2026, no free tier. Charge credits in Developer Portal
2. **Access Token permissions** — after changing App permissions, regenerate your Access Token. Old tokens keep old permissions
3. **Media upload uses v1.1** — image upload goes to `upload.twitter.com/1.1/`, tweet posting uses v2 `api.twitter.com/2/`
4. **media_id expires in 24h** — upload and use in the same session
5. **Use OAuth 1.0a, not 2.0** — 1.0a tokens never expire, 2.0 requires refresh token flow

## License

MIT
