# Shorts Autopilot

Hands-free short-form video factory for a personal brand. Every run it:

1. **Researches**: pulls fresh stories for your niche (Google News, Google Trends, Hacker News). An LLM picks the one most likely to go viral that this schedule has **never covered before** (45-day de-dupe).
2. **Writes**: hook, spoken script with your own take (needed to stay monetisable), title, on-screen hook, thumbnail text, and native captions for each platform.
3. **Styles you**: rotates through brand "looks" (outfits, glasses, studio background in brand colours), each generated once from your photo and then reused.
4. **Speaks in your voice**: ElevenLabs instant clone from your clip. If that fails it falls back to fal F5-TTS zero-shot cloning.
5. **Animates you**: photo + voice become a talking-head video (OmniHuman 1.5, then VEED Fabric, then an animated still as the last resort). Optional "clip" mode re-lip-syncs your own recorded clip instead.
6. **Edits**: 1080×1920 H.264. Word-by-word karaoke captions in your accent colour, hook banner, handle watermark, progress bar, CTA end card, loudness normalised to −14 LUFS, optional music bed, branded thumbnail.
7. **Publishes**: YouTube Shorts, Instagram Reels, Facebook Reels, X, Threads and LinkedIn, all in parallel, each with its own retry loop.
8. **Cleans up and logs**: deletes the generated video, audio and thumbnail, then writes one row per video to your **Google Sheet**: what was posted, links, failures, who scheduled it. Every owner/user action goes to a second tab.

The owner and invited users manage everything from a mobile-installable web app (PWA) hosted on Vercel.

TikTok is not included (banned in India). Snapchat Spotlight, Moj and Josh have no public posting API.

---

## Brutal honesty: read before you spend money

| Topic | Reality |
|---|---|
| **Cost per video** | The talking avatar is the expensive part: about **$0.14–0.16 per second** (OmniHuman 1.5 / Fabric 720p). A 45 s short costs about **$6–7** for the avatar alone, plus about $0.10–0.30 for voice and script. **Hourly = 24/day ≈ $150+/day ≈ $4,500+/month.** The *Max videos per day* fuse defaults to **6**. Raise it on purpose. |
| **YouTube API audit** | Google API projects created after July 2020 that are **unverified upload videos as *private*, and you can't make them public until the project passes the YouTube API Services audit.** Apply on day one: Google Cloud → YouTube Data API → "Audit and quota extension" form. It takes weeks. Also set the OAuth consent screen to **"In production"**. In "Testing" mode refresh tokens die after 7 days. |
| **YouTube monetisation** | YPP for Shorts needs 1,000 subscribers + 10M valid Shorts views in 90 days. YouTube's *inauthentic / mass-produced content* policy demonetises repetitive, templated, low-value uploads. **24 AI-avatar news shorts a day from one channel is exactly the pattern it targets.** The prompts force original opinion and the uploads carry the required "altered/synthetic content" disclosure (`containsSyntheticMedia`). Even so, 2–4 strong videos a day will earn more than 24 weak ones. |
| **Instagram / Facebook** | You need an Instagram **Professional** (Creator/Business) account and a Facebook **Page**. The API can't post to personal FB profiles. Instagram allows 50 API posts per 24 h. Reels payouts are limited or invite-only in India, so money there comes from brand deals. |
| **X** | Posting video through the API needs a **paid** X API plan (pricing changes often; check developer.x.com). Revenue sharing needs Premium plus large impression thresholds. |
| **LinkedIn** | Personal-profile posting works with the self-serve "Share on LinkedIn" product. Tokens expire after **60 days** and the dashboard warns you. There are no creator payouts; LinkedIn is for leads and authority. |
| **Vercel plan** | The Hobby plan is for **non-commercial** use and allows only daily crons. This repo works on Hobby: it uses a daily Vercel cron plus a GitHub Actions heartbeat plus self-chaining. A monetised brand should be on **Pro ($20/mo)**, which also allows longer function time. |
| **"Unlimited AI tools"** | A Google AI Pro / Jio subscription does **not** include Gemini **API** credits. API keys are billed separately (Gemini has a free tier). You need your own API keys for ElevenLabs, fal.ai and one LLM. |
| **Deepfake rules** | Only ever use **your own** face and voice. Every platform requires AI disclosure for realistic synthetic people. The YouTube flag and a description line are added automatically. |

---

## Architecture

```
GitHub Actions (every 30 min) ─┐                       ┌─► Google News / Trends / HN
cron-job.org (optional, 5 min) ├─► /api/cron/tick ──► engine.tick()
Vercel cron (daily backup) ────┘      ▲   │          │ per job, one stage per step:
"Make one now" button ────────────────┘   │          │ research → script → look → voice → avatar → edit → publish → cleanup
                                          │          │       (LLM)    (fal)   (11Labs)  (fal)   (ffmpeg)  (6 APIs)  (Blob+Sheet)
          self-chains while a job waits ◄─┘          ▼
                                   Upstash Redis (jobs, schedules, encrypted tokens, de-dupe, counters)
                                   Vercel Blob (public media URLs, deleted after publishing)
                                   Google Sheet (permanent log, buffered in Redis if Google is down)
```

* Every job is a **persistent state machine** in Redis. A function can die at any moment (timeout, deploy, crash) and the next tick resumes from the last finished stage.
* Each stage runs only if enough function time is left (rendering needs about 150 s).
* A Redis lock stops two workers from running the same job.
* Slow external work (avatar render, Instagram/X/LinkedIn processing) is **polled**, never waited on in-process.

### Fallbacks (what happens when things break)

| Failure | Behaviour |
|---|---|
| A trend source is down | The others are used. If every source is empty, the LLM writes an evergreen idea in your niche. |
| LLM error / bad JSON / script too long | Retries once on the same provider, then moves to the next provider (Anthropic → Gemini → OpenAI, configurable). The stage retries with backoff 3×. |
| Voice clone fails | ElevenLabs → fal F5 zero-shot. A generic voice is used **only** if you allow it, so a stranger's voice never goes out under your face by default. |
| Avatar service down / out of credit / >25 min | Moves to the next provider. Last resort is an animated still photo (can be disabled). |
| Look generation fails | Uses your original photo. |
| ffmpeg render fails | Retries at 720p ultrafast. If that fails too, publishes the raw talking-head with your audio. |
| A platform rejects / times out | That platform alone retries (1, 2, 4, 8 min…, up to 5 tries). Dead Instagram/Threads/X/LinkedIn containers are rebuilt. Permission/auth errors fail fast and are logged, and the other platforms still publish. The job ends `partial`. |
| Token expired | Auto-refresh (Google, X with rotating refresh tokens, Instagram/Threads 60-day tokens). If refresh is impossible, the connection is marked "needs reconnect" on the dashboard and the error goes to the sheet. |
| Google Sheet unreachable | Rows are buffered in Redis and flushed on the next tick. |
| Setup incomplete (no AI key / photo / voice) | The cron **does not create jobs** (your daily cap is protected) and the dashboard shows exactly what is missing. |
| Daily cap reached | No new jobs. Per-platform caps skip that platform only. |

---

## Setup (do these in order; about 1–2 hours)

### 1. Deploy
1. Merge this branch into your default branch (`main`). GitHub only runs scheduled workflows from the default branch.
2. vercel.com → **Add New Project** → import this repo (framework: Next.js, defaults are fine).
3. Vercel → project → **Storage**:
   * **Upstash Redis** (Marketplace) → connect to the project. This fills `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
   * **Blob** → create store → connect. This fills `BLOB_READ_WRITE_TOKEN`.
4. Settings → Environment Variables: set everything under "Core" in `.env.example`:
   `APP_URL`, `APP_SECRET` (`openssl rand -hex 32`), `CRON_SECRET` (`openssl rand -hex 32`), `OWNER_EMAIL`, `OWNER_PASSWORD`.
5. Redeploy. Open the URL and sign in.

### 2. Install on your phone
* **Android (Chrome)**: open the URL → ⋮ → **Install app** (or "Add to Home screen").
* **iPhone (Safari)**: Share → **Add to Home Screen**.

### 3. AI keys (Vercel env, then redeploy)
* `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY` / `OPENAI_API_KEY`: script writing. One is enough, and two give you a fallback.
* `ELEVENLABS_API_KEY`: needs a paid plan for voice cloning. Starter has about 30k chars/month ≈ 40 videos. Creator has 100k ≈ 140 videos.
* `FAL_KEY` (fal.ai, prepaid credits): talking avatar, outfit looks, backup voice.

### 4. Studio (in the app)
* **Photo**: sharp, front-facing, chest-up, eyes to camera, mouth closed, even light.
* **Voice clip**: 60–120 s of you speaking naturally, quiet room, no music. Video or audio both work. The app extracts and cleans the audio and creates the voice clone.

### 5. Google: YouTube + Sheet log
1. console.cloud.google.com → new project → **APIs & Services → Library**: enable **YouTube Data API v3** and **Google Sheets API**.
2. **OAuth consent screen**: External. Add scopes `youtube.upload`, `youtube.readonly`, `spreadsheets`. Add yourself as test user, then **Publish app → In production**. The "unverified app" warning is fine for your own account.
3. **Credentials → Create OAuth client ID → Web application**. Authorised redirect URI: `https://YOUR_APP/api/oauth/google/callback`.
4. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in Vercel → redeploy → app **Connections → Connect** (YouTube + Google Sheets). Log in with the Google account that owns the channel **and** can edit the sheet.
5. Create an empty Google Sheet → copy the ID from its URL → app **Brand & Settings → Google Sheet log**. The "Runs" and "Activity" tabs are created automatically.
6. Apply for the **YouTube API audit** now (see the honesty table).

### 6. Meta: Instagram, Facebook Page, Threads
1. developers.facebook.com → **Create app** → use cases: *Manage messaging & content on Instagram* (Instagram API with Instagram Login), *Access the Threads API*, and *Manage everything on your Page* (Facebook Login for Business).
2. Instagram product → Business login settings → redirect `https://YOUR_APP/api/oauth/instagram/callback`. Copy the **Instagram app ID/secret** to `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`. Add your IG account under *Roles → Instagram testers* and accept the invite in the Instagram app.
3. Threads use case → redirect `https://YOUR_APP/api/oauth/threads/callback` → `THREADS_APP_ID` / `THREADS_APP_SECRET`. Add yourself as Threads tester.
4. Facebook Login → redirect `https://YOUR_APP/api/oauth/facebook/callback` → `META_APP_ID` / `META_APP_SECRET`.
5. The app can stay in **Development mode**. It works for accounts that have a role on the app, so no App Review is needed to post to your own accounts.
6. Redeploy → **Connections** → Connect each. (Alternative: generate tokens in the Meta dashboard and use **Paste token**.)

### 7. X
developer.x.com → Project → App → **User authentication settings**: OAuth 2.0, type **Web App**, callback `https://YOUR_APP/api/oauth/x/callback`, permissions **Read and write**. Copy the OAuth 2.0 **Client ID / Secret** to `X_CLIENT_ID` / `X_CLIENT_SECRET`. Make sure your API plan allows posting and media upload.

### 8. LinkedIn
linkedin.com/developers → Create app (needs a company page to associate) → **Products**: add *Sign In with LinkedIn using OpenID Connect* and *Share on LinkedIn* → Auth: redirect `https://YOUR_APP/api/oauth/linkedin/callback` → `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`. Reconnect every 60 days when the app warns you.

### 9. Turn on the heartbeat
* GitHub repo → Settings → Secrets → Actions: `APP_URL`, `CRON_SECRET`. The `autopilot-heartbeat` workflow pings the worker at :07 and :37 every hour. Private repos get 2,000 free Actions minutes/month, and this uses about 1,450.
* **Recommended extra:** cron-job.org (free) → new job → URL `https://YOUR_APP/api/cron/tick?async=1`, every 5–10 min, header `Authorization: Bearer <CRON_SECRET>`. This makes schedule timing tight and uses no GitHub minutes.

### 10. Verify, then go live
1. App → **Health check**: every line green. It makes real calls to every service.
2. **Schedules → New schedule**. New schedules start in **Private test** mode (YouTube private only, nothing public).
3. **Make one now** → watch it on Overview (about 5–15 min) → review the private YouTube video.
4. Happy with it? Edit the schedule → **LIVE**, set the frequency and the posting window (e.g. 8–23 h), and set **Max videos per day** in Settings.

---

## Using it day to day
* **Schedules**: owner and users each add recipes such as topic, direction, frequency, posting window and platforms. Users can edit only their own; the owner can edit all. Every change is logged to the sheet's *Activity* tab.
* **Make one now**: runs a schedule immediately, outside its timing.
* **Overview**: live progress per job, per-platform links, full logs, cancel.
* **Brand & Settings** (owner): colours, handle, CTA, looks, provider order, daily caps, music, sheet ID.
* **Team** (owner): add/remove users.

## Development
```bash
npm install
cp .env.example .env.local     # fill what you have; without Redis/Blob it uses local disk
npm run dev                    # http://localhost:3000
npm test                       # 34 tests: full pipeline with real ffmpeg renders, failure injection, every platform's API contract
npm run tick                   # run one worker pass from your machine (same Redis/Blob/creds)
npm run worker                 # keep a worker running (fallback if Vercel is unavailable)
```

### Tests cover
* The full pipeline end to end with mocked AI/platforms: real 1080×1920 H.264/AAC render, voice and avatar fallbacks, a flaky platform recovering, a forbidden platform failing fast while the others publish, media deleted afterwards, sheet row written, story de-dupe, look caching.
* Private test mode, refusing to publish a generic voice, actionable errors for missing photo/voice/keys, sheet buffering while Google is down, daily caps, the scheduler window/interval maths, and preflight blocking.
* Each publisher's HTTP contract: YouTube resumable upload with synthetic-media flag, Instagram container → poll → publish, Facebook Reels hosted upload, Threads, X chunked upload/processing/post plus rotating refresh tokens, LinkedIn multipart upload with ETags → post.

What the tests **can't** prove: that each vendor's live API still behaves the same today. That is what **Health check** plus one **Private test** run is for. If a vendor changes an endpoint or model ID, most of them can be overridden with env vars (`*_MODEL`, `META_GRAPH_VERSION`, `LINKEDIN_VERSION`).
