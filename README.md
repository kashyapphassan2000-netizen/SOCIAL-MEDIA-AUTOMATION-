# Shorts Autopilot

Hands-free short-form video factory for a personal brand. Every run it:

1. **Researches**: pulls fresh stories for your niche (Google News, Google Trends, Hacker News). An LLM picks the one most likely to go viral that this schedule has **never covered before** (45-day de-dupe).
2. **Writes**: hook, spoken script with your own take (needed to stay monetisable), title, on-screen hook, thumbnail text, and native captions for each of the 9 platforms.
3. **Speaks in your voice**: cloned from your clip. **Free:** Chatterbox (open source, 23 languages incl. Hindi) on your own free worker. Paid backups: ElevenLabs, fal F5.
4. **Animates you**: your photo talks in sync with the audio. **Free:** SadTalker (open source) on the free worker. Paid backups: OmniHuman / VEED Fabric. Last resort: an animated still photo.
5. **Edits**: 1080×1920 H.264. Word-by-word karaoke captions in your accent colour, hook banner, handle watermark, progress bar, CTA end card, loudness normalised to −14 LUFS, branded thumbnail.
6. **Publishes**: YouTube Shorts, Instagram Reels, Facebook Reels, X, Threads, LinkedIn, Pinterest, Bluesky and a Telegram channel, all in parallel, each with its own retry loop.
7. **Cleans up and logs**: deletes the generated media, then writes one row per video to your **Google Sheet** (links, failures, who scheduled it). Every owner/user action goes to a second tab.

The owner and invited users manage everything from a mobile-installable web app (PWA) hosted on Vercel.

---

## The ₹0 stack: what is genuinely free, and the catch

No AI provider gives *unlimited* free access. Every free tier has a rate or daily cap. But a video needs only **2 LLM calls**, one voice render and one avatar render, so free tiers cover many videos a day.

| Job | Free option (default) | Free limit (2026, changes often) | Catch |
|---|---|---|---|
| Script + trend pick | **Gemini** (AI Studio key), **Groq**, **Cerebras**, **OpenRouter `:free`**, **NVIDIA NIM** (build.nvidia.com), tried in that order | Gemini Flash ~1,500 req/day; Groq ~1,000 req/day; Cerebras ~1M tokens/day; NVIDIA ~40 req/min | Set 2–3 keys so a rate-limit on one never stops you. NVIDIA's free endpoints are under *trial / evaluation* terms, so keep them as a backup, not the primary. The model is auto-picked from each provider's live list, so retired models don't break anything. |
| Voice clone | **Chatterbox** (MIT licence) on the **free worker** | Unlimited (it's your compute) | On a free GitHub CPU runner: **~5× slower than real time**, so a 45 s voiceover takes ~4–5 min. Tested in this repo. |
| Talking head | **SadTalker** (MIT licence) on the **free worker** | Unlimited (your compute) | **CPU is very slow: ~2 min of compute per 1 s of video** (measured here: 6.9 s took 14.7 min on 4 cores), so 45 s ≈ 1.5 h. On **Kaggle's free GPU** (~30 GPU-hours/week) it's minutes. Quality is decent lip-sync with little head motion, noticeably below paid OmniHuman. |
| Outfit looks | none free (needs an image-edit model) | — | Free mode uses your original photo. Upload 3–5 real photos in different outfits if you want variety. |
| Hosting | Vercel Hobby + Upstash Redis free + Vercel Blob free | Hobby is officially **non-commercial** | Monetised brand → Vercel Pro $20/mo is the honest option. |
| Workers | GitHub Actions (free CPU) / Kaggle (free GPU) / your own PC | Public repo: unlimited Actions minutes. Private: 2,000 min/month | Private repo + CPU avatars will burn the 2,000 minutes fast. Use Kaggle for avatars. |

**Not usable for automation:** Hugging Face Spaces' free GPU (ZeroGPU) gives free accounts ~3.5 GPU-minutes and ~3 runs **per day**. NVIDIA's Audio2Face-2D talking-head model is evaluation-licence only. XTTS-v2 and F5-TTS weights are **non-commercial** licences; Chatterbox and SadTalker are MIT, which is why they were chosen.

**Recommended free setup:** Gemini + Groq + Cerebras keys, voice on GitHub Actions, avatars on Kaggle GPU, and repo **public** for unlimited Actions minutes (secrets stay secret). Expect a video **~10–20 min** after its slot. With CPU-only avatars, keep it to **2–4 videos/day**, or turn avatars off and post voice + animated photo + captions, which renders instantly.

---

## Brutal honesty: platforms and money

| Topic | Reality |
|---|---|
| **YouTube API audit** | Google API projects created after July 2020 that are **unverified upload videos as *private*, and you can't make them public until the project passes the YouTube API Services audit.** Apply on day one: Google Cloud → YouTube Data API → "Audit and quota extension" form. It takes weeks. Set the OAuth consent screen to **"In production"**. In "Testing" mode refresh tokens die after 7 days. |
| **Mass-produced content** | YouTube's *inauthentic content* policy (and Meta's "unoriginal content" rules) demonetise repetitive, templated, low-value uploads. **24 AI-avatar news shorts a day is exactly that pattern.** The prompts force your own opinion and every upload carries the AI disclosure, but 2–4 strong videos a day beat 24 weak ones, for reach *and* money. |
| **X API** | Posting video through the API needs a **paid** X API plan. There is no workaround. Leave X unchecked in your schedules if you won't pay. |
| **Pinterest API** | New apps get *Trial* access (sandbox). Apply for *Standard* access (they want a short demo video) before Pins go live. |
| **Paid fallbacks (optional)** | If you add `FAL_KEY` / `ELEVENLABS_API_KEY`, they are used **only when the free path fails**. A paid avatar costs ~$0.14–0.16 per second (≈ $6–7 per 45 s video). The *Max videos per day* fuse (default 6) caps damage. |
| **Deepfake rules** | Only ever use **your own** face and voice. Platforms require AI disclosure for realistic synthetic people. The YouTube flag and a description line are added automatically. |

### How each platform pays (India, 2026)

| Platform | Automated here | How you actually earn | Thresholds / notes |
|---|---|---|---|
| **YouTube Shorts** | ✅ | YPP: ~45% of Shorts ad pool, Super Thanks, memberships, Shopping | 1,000 subs + 10M Shorts views in 90 days (or 4,000 watch hours). Best long-term payer. |
| **Facebook Reels** | ✅ (Page) | Meta **Content Monetization** program (replaced Reels Play / in-stream / bonuses) | Roughly: 10k followers, 600k minutes watched in 60 days, 5+ videos. Rolled out partially in India; check *Professional Dashboard → Monetization*. |
| **Instagram Reels** | ✅ | **Gifts** (500+ followers), **Subscriptions** (10k+, ₹85–890/month per fan), brand deals, affiliate | No general Reels ad-revenue share in India. Real money is **brand deals**, and this pipeline builds the audience for them. |
| **Threads** | ✅ | None direct | The bonus program ended in 2025 and is not available in India. Use it for reach and to funnel to YouTube/IG. |
| **X** | ✅ (paid API) | **Original Content Rewards** program (Creator Revenue Sharing closed to new members Aug 2026 and retired Sept 7, 2026), subscriptions | Needs X Premium + high impressions. Check current terms in the X app. |
| **LinkedIn** | ✅ | No creator payouts | Leads, consulting, job offers, sponsorships. High-value audience for AI/career niches. |
| **Pinterest** | ✅ (video Pins) | Affiliate links, brand deals, traffic to your site/YouTube | No creator fund since 2022. Performance+ creator rewards are invite-only. Pins carry your source link. |
| **Bluesky** | ✅ | None | Free, fast-growing tech audience. Pure reach. |
| **Telegram channel** | ✅ | **Ad revenue share 50%** (paid in TON) once the channel has 1,000+ subscribers, paid posts, Stars | Check your country is in Telegram's eligible list. India has a huge Telegram base. |
| **Snapchat Spotlight / Stories** | ❌ API is allow-list only for approved partners | Snap creator monetization (ads in Stories/Spotlight) via Snap Creator programs in India | Post manually from your phone (download the video from the job's Telegram post or YouTube). Reach out to Snap for API access when you're bigger. |
| **Moj / ShareChat / Josh** | ❌ no public posting API | Moj for Creators programs, brand campaigns | Manual upload only. |
| **TikTok** | ❌ excluded (banned in India) | — | — |

---

## Architecture

```
GitHub Actions (every 30 min) ─┐                       ┌─► Google News / Trends / HN
cron-job.org (optional, 5 min) ├─► /api/cron/tick ──► engine.tick()
Vercel cron (daily backup) ────┘      ▲   │          │ per job, one stage per step:
"Make one now" button ────────────────┘   │          │ research → script → look → voice → avatar → edit → publish → cleanup
                                          │          │  (free LLMs)          │        │      (ffmpeg)  (9 APIs)  (Blob+Sheet)
          self-chains while a job waits ◄─┘          │              queue ───┴────────┴──► /api/worker/claim|complete
                                                     │                                      ▲
                                                     │      FREE WORKER (worker/free_worker.py): Chatterbox voice + SadTalker avatar
                                                     │      on GitHub Actions CPU (auto-dispatched) · Kaggle GPU · your own PC
                                                     ▼
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
| LLM error / rate limit / bad JSON / script too long | Retries once on the same provider, then moves to the next (Gemini → Groq → Cerebras → OpenRouter → NVIDIA → paid ones if keyed). The stage retries with backoff 3×. |
| Free worker down / slow / crashed | Task leases expire after 45 min and are re-queued once. Voice falls back after 60 min, avatar after 150 min (configurable), to the next provider: paid ones if keyed, else the animated still photo. |
| Voice clone fails | free Chatterbox → ElevenLabs → fal F5. A generic voice is used **only** if you allow it, so a stranger's voice never goes out under your face by default. |
| Avatar fails (e.g. "no face detected") | free SadTalker → OmniHuman → Fabric → animated still photo (can be disabled). |
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

### 3. Free AI keys (Vercel env, then redeploy). No card needed.
* `GEMINI_API_KEY`: aistudio.google.com → **Get API key**. Your Jio/Google AI Pro subscription is separate; the API key has its own free tier.
* `GROQ_API_KEY`: console.groq.com → API Keys.
* `CEREBRAS_API_KEY`: cloud.cerebras.ai → API Keys.
* Optional extra backups: `OPENROUTER_API_KEY` (openrouter.ai/keys, uses `:free` models) and `NVIDIA_API_KEY` (build.nvidia.com → any model → *Get API Key*).
* Paid keys (`ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `FAL_KEY`) are optional backups. Skip them for ₹0.

### 3b. Free worker (voice clone + talking head), ₹0
1. Make up a long random `WORKER_SECRET` (`openssl rand -hex 32`). Put it in **Vercel env** *and* in **GitHub → Settings → Secrets → Actions** (together with `APP_URL`).
2. Instant start: create a GitHub **fine-grained token** (Settings → Developer settings → Fine-grained tokens → only this repo → *Actions: Read and write*). Put it in Vercel as `GH_DISPATCH_TOKEN`, plus `GITHUB_REPO=owner/repo`. Without it the worker still runs every 3 hours from its schedule.
3. Voice is rendered on GitHub's free runners (workflow **free-worker**, first run ~10 min to download models, then cached).
4. **Avatars, strongly recommended on Kaggle's free GPU:** kaggle.com → sign up → **verify your phone** (needed for internet access) → Settings → API → *Create New Token*. Add `KAGGLE_USERNAME` and `KAGGLE_KEY` as GitHub secrets. The workflow then pushes each avatar batch to a private Kaggle GPU job automatically. Without Kaggle, avatars render on GitHub CPU (≈1.5 h per 45 s video).
5. **Or run it on your own PC** (an NVIDIA GPU makes it fast): `bash worker/setup.sh` once, then `APP_URL=… WORKER_SECRET=… IDLE_EXIT_SEC=0 python3 worker/free_worker.py`. It works through tasks as they arrive.

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

### 8b. Pinterest, Bluesky, Telegram
* **Pinterest:** developers.pinterest.com → create app → redirect `https://YOUR_APP/api/oauth/pinterest/callback` → `PINTEREST_APP_ID` / `PINTEREST_APP_SECRET` → Connections → Connect. Request **Standard access** in the app console; Trial access only writes to the sandbox.
* **Bluesky:** bsky.app → Settings → Privacy and security → **App passwords** → create one → Connections → Bluesky → paste it with your handle.
* **Telegram:** talk to **@BotFather** → `/newbot` → copy the token → add the bot as **admin** of your channel (permission *Post messages*) → Connections → Telegram → token + `@yourchannel`.

### 9. Turn on the heartbeat
* GitHub repo → Settings → Secrets → Actions: `APP_URL`, `CRON_SECRET` (plus `WORKER_SECRET`, optional `KAGGLE_USERNAME`/`KAGGLE_KEY` from step 3b). The `autopilot-heartbeat` workflow pings the app hourly (~720 Actions minutes/month on a private repo; free and unlimited on a public repo).
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
npm test                       # 45 tests: full pipeline with real ffmpeg renders, failure injection, free-worker queue, every platform's API contract
npm run tick                   # run one worker pass from your machine (same Redis/Blob/creds)
npm run worker                 # keep a worker running (fallback if Vercel is unavailable)
```

### Tests cover
* The full pipeline end to end with mocked AI/platforms: real 1080×1920 H.264/AAC render, voice and avatar fallbacks, a flaky platform recovering, a forbidden platform failing fast while the others publish, media deleted afterwards, sheet row written, story de-dupe, look caching.
* Private test mode, refusing to publish a generic voice, actionable errors for missing photo/voice/keys, sheet buffering while Google is down, daily caps, the scheduler window/interval maths, and preflight blocking.
* Each publisher's HTTP contract: YouTube resumable upload with synthetic-media flag, Instagram container → poll → publish, Facebook Reels hosted upload, Threads, X chunked upload/processing/post plus rotating refresh tokens, LinkedIn multipart upload with ETags → post, Pinterest S3 upload → video Pin, Bluesky video service + hashtag facets, Telegram sendVideo.
* The free stack: worker queue claim/lease/re-queue/fail, GitHub dispatch debounce, free LLM model auto-pick, the full pipeline driven through the async voice + avatar queue, and fallback when the worker reports "no face detected".
* Verified for real in this repo's sandbox (not mocked): `worker/setup.sh` installs everything from scratch. Chatterbox cloned a voice on CPU (~5× slower than real time). SadTalker animated a portrait on CPU (6.9 s of video in 14.7 min). The Python worker claimed tasks from the running Next.js app over HTTP and uploaded results back.

What the tests **can't** prove: that each vendor's live API still behaves the same today. That is what **Health check** plus one **Private test** run is for. If a vendor changes an endpoint or model ID, most of them can be overridden with env vars (`*_MODEL`, `META_GRAPH_VERSION`, `LINKEDIN_VERSION`).
