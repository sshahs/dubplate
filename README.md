<p align="center">
  <img src="docs/banner.svg" alt="Dubplate — AI-assisted tagging for sound-system crates" width="100%">
</p>

<p align="center">
  <img alt="Node 22.13+" src="https://img.shields.io/badge/node-22.13%2B-1f9d55?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=1b1511">
  <img alt="React 19" src="https://img.shields.io/badge/react-19-f4c20d?style=for-the-badge&logo=react&logoColor=white&labelColor=1b1511">
  <img alt="Vite" src="https://img.shields.io/badge/vite-8-d62f2f?style=for-the-badge&logo=vite&logoColor=white&labelColor=1b1511">
  <img alt="shadcn/ui preset b6FArvVnDX" src="https://img.shields.io/badge/shadcn%2Fui-b6FArvVnDX-1f9d55?style=for-the-badge&logo=shadcnui&logoColor=white&labelColor=1b1511">
  <br>
  <img alt="Ollama local or cloud" src="https://img.shields.io/badge/AI-local%20%2B%20cloud-f4c20d?style=for-the-badge&logo=ollama&logoColor=white&labelColor=1b1511">
  <a href="https://github.com/sshahs/dubplate/pkgs/container/dubplate"><img alt="Docker image on ghcr.io" src="https://img.shields.io/badge/ghcr.io-sshahs%2Fdubplate-d62f2f?style=for-the-badge&logo=docker&logoColor=white&labelColor=1b1511"></a>
  <img alt="Read-only by default" src="https://img.shields.io/badge/files-read--only%20by%20default-1f9d55?style=for-the-badge&labelColor=1b1511">
</p>

<p align="center">
  <b>Wheel up the badly named rips.</b><br>
  Dubplate reads your filenames like a selector would, checks what it hears against the big databases and the underground archives,<br>
  and only renames a tune to <code>Artist - Title</code> when the sources agree. Everything else waits for your ear.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#docker">Docker</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#sources">Sources</a> ·
  <a href="#ai-providers">AI providers</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#glossary">Glossary</a>
</p>

<img src="docs/stripe.svg" width="100%" height="6" alt="">

## 🔊 Wha' gwaan?

Every collection has them: tunes pulled off pirate radio, CD-Rs, forum
rips and old hard drives, named any way at all. Dubplate turns this…

```text
12_buju_banton_vs_beenie_man_live_93_dubplate.mp3
03. Wiley - Wot Do U Call It (Official Video) [320kbps] www.grimeripz.com.mp3
A1-Tenor_Saw-Ring_The_Alarm.mp3
chronixx ft protoje - here comes trouble (dubplate for king addies).mp3
Murder She Wrote - Chaka Demus & Pliers.mp3
audio_track_01 copy.mp3
```

…into this, and shows its working for every call:

| | Becomes | Confidence | Why |
| :-: | --- | :-: | --- |
| 🟩 | `Wiley - Wot Do U Call It.mp3` | **93** | Clean reading, and independent sources agree |
| 🟩 | `Tenor Saw - Ring the Alarm.mp3` | **93** | Vinyl side `A1` stripped; the catalogues confirm it |
| 🟨 | `Chronixx feat. Protoje - Here Comes Trouble (Dubplate for King Addies).mp3` | **85** | The song is confirmed, but this cut is a dubplate |
| 🟨 | `Chaka Demus & Pliers - Murder She Wrote.mp3` | **85** | The filename had the title first. The swap was spotted, but you get the final say |
| 🟨 | `Buju Banton vs Beenie Man - Live Clash (Dubplate).mp3` | **75** | A clash tape that no database lists, so it's capped for review |
| 🟥 | *(left alone)* | **6** | Nothing to go on, so nothing gets touched |

<sub>From a run over the demo library (`npm run demo`). Real scores depend on which sources know the tune.</sub>

<img src="docs/stripe.svg" width="100%" height="6" alt="">

<a id="how-it-works"></a>

## 🎛️ The riddim: how it works

```mermaid
flowchart TB
  subgraph pipeline ["The pipeline"]
    direction LR
    scan["📂 Scan<br/>read-only"] --> parse["⚡ Parse<br/>rule-based"] --> ai["🧠 Interpret<br/>local or cloud AI"] --> scour["🔎 Scour<br/>11 sources + scrapers"] --> score["📊 Score<br/>consensus engine"]
  end
  pipeline -->|"90 and up"| matched["Matched"]
  pipeline -->|"60–89 or conflict"| review["Review"]
  pipeline -->|"under 60"| unmatched["Unmatched<br/>left alone"]
  matched --> approve["✅ Approve"]
  review -->|"your ear"| approve
  approve --> cut["✂️ Cut & Tag"]
  cut -.->|"⏪ Rewind"| approve

  classDef base fill:#1b1511,stroke:#4a3f39,color:#f3ead9
  classDef green fill:#1f9d55,stroke:#146b3a,color:#ffffff
  classDef gold fill:#f4c20d,stroke:#a88400,color:#1b1511
  classDef red fill:#d62f2f,stroke:#8c1d1d,color:#ffffff
  class scan,parse,ai,scour,score,approve,cut base
  class matched green
  class review gold
  class unmatched red
  style pipeline fill:#0f0c0a,stroke:#4a3f39,color:#f4c20d
```

| Stage | What happens |
| --- | --- |
| **📂 Scanner** | Walks your folders and reads existing tags (including BPM, key and cover art), duration and a content fingerprint into a SQLite staging database. **It never opens a music file for writing.** It follows files you've moved and flags exact duplicates. Watched folders are picked up as files land. |
| **⚡ Rule-based parser** | A fast first pass. It strips rip-site names, bitrates, *(Official Video)*, and track and vinyl-side numbers. It splits `Artist - Title`, `Title by Artist` and `A vs B` clashes, and spots hints like *dubplate*, *special*, *live '93*, *riddim* and *VIP*. |
| **🧠 AI interpreter** | Reads the filename, folder, tags and first-pass result, and returns structured JSON: artists, `&` or `vs`, title, version, year, riddim, event, alternatives and search queries. Your approvals are shown to it as examples, so it learns your style. |
| **🔎 Metadata scourer** | Asks every enabled source at once, with polite per-host rate limits and a 7-day response cache. |
| **📊 Confidence engine** | Groups the hits by recording, then weighs consensus across independent sources, agreement between readings, duration, fingerprint matches and conflicts. The result is an explainable 0–100 score. |
| **🎨 Artwork, tempo & key** | Fetches a cover from the sources that confirmed the track (Cover Art Archive, Discogs, Bandcamp, Apple Music, Deezer…), and listens to the audio for BPM and musical key. |
| **✂️ Verify & execute** | Bulk-approve the matches, review the rest, then rename and tag in place. Every operation is logged so any batch can be put back. |

### 📊 Reading the meter

The colours mean the same thing everywhere in the app:

| | Band | What happens |
| :-: | --- | --- |
| 🟩 | **90–100: Matched** | Strong consensus. Ready to approve, or auto-approve if you turn that on. |
| 🟨 | **60–89: Review** | Plausible but unproven, *or* strong sources disagree. It goes to the review queue. |
| 🟥 | **0–59: Unmatched** | Guesswork. Never touched unless you step in. |

The **Evidence** tab shows every factor behind a score:

- **Readings agree**: the AI, the parser and the embedded tags agree with each other.
- **AI certainty**: how sure the model says it is.
- **Sources match the reading**: how close the best hit is to what the file says.
- **Source consensus**: how many independent sources back the same recording, weighted by trust.
- **Conflicts** pull the score down. **Duration** and an **AcoustID fingerprint** can nudge it up or down.

> [!NOTE]
> A reading that **no source confirms** is capped at 75, so dubplates and
> specials that exist nowhere online always get a human check. Thresholds and
> source weights are all adjustable in Settings.

<img src="docs/stripe.svg" width="100%" height="6" alt="">

## 📸 Inna di dance

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/dashboard.png" alt="Dashboard"><p align="center"><b>The yard</b>: where your crates stand</p></td>
    <td width="50%"><img src="docs/screenshots/track-detail.png" alt="Track detail"><p align="center"><b>Track detail</b>: evidence, audio preview and editor</p></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/review.png" alt="Review queue"><p align="center"><b>Selector's chair</b>: keyboard-driven review</p></td>
    <td><img src="docs/screenshots/cut-and-tag.png" alt="Cut and tag"><p align="center"><b>Cut & Tag</b>: plan, dry run, rewind</p></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/untangler.png" alt="Untangler"><p align="center"><b>Untangler</b>: test any filename</p></td>
    <td><img src="docs/screenshots/sources.png" alt="Sources"><p align="center"><b>The scourer</b>: sources, keys and trust weights</p></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/dashboard-light.png" alt="Light theme"><p align="center"><b>Daytime</b>: light theme</p></td>
    <td align="center"><img src="docs/screenshots/mobile-review.png" alt="Mobile" width="45%"><p align="center"><b>Pocket</b>: works on a phone</p></td>
  </tr>
</table>

<img src="docs/stripe.svg" width="100%" height="6" alt="">

<a id="sources"></a>

## 🗂️ Sources

**Big catalogues**

| Source | Key | Notes |
| --- | :-: | --- |
| MusicBrainz | – | The most authoritative source. 1 request per second. |
| Discogs | token | Opens the matching release to find the actual track. Strong for 7″s and white labels. |
| Apple Music (iTunes Search) | – | |
| Deezer | – | Includes durations |
| Spotify | ID + secret | Client-credentials flow |
| Last.fm | key | Crowd-sourced, so weighted lower |

**Underground & archives**

| Source | Key | Notes |
| --- | :-: | --- |
| Bandcamp | – | Independent dub, grime and sound-system releases |
| Internet Archive | – | Clash tapes and pirate radio sets |
| Mixcloud | – | Radio shows and clash recordings |
| YouTube | key | Where most specials end up. Uses auto-generated "Artist - Topic" channels when available. |
| AcoustID | key + `fpcalc` | **Audio fingerprinting**: identifies the audio itself, not the name |

**🔧 Custom scrapers**: point Dubplate at any specialist site's search page
(CSS selectors) or JSON API (dot-paths, e.g. WordPress `/wp-json`). Grime
archives, clash databases and label shops all work. The built-in **Test**
button shows exactly what gets extracted. Presets for Juno Download and a
sound-clash archive ship switched off until you've verified them.

<a id="ai-providers"></a>

## 🧠 AI providers

| Provider | Default model | Notes |
| --- | --- | --- |
| 🏠 **Ollama (local)** | `qwen3:8b` | Structured JSON output via `format`. Everything stays on your machine. |
| ☁️ Ollama Cloud | `gpt-oss:120b` | `https://ollama.com` plus an API key |
| OpenAI | `gpt-5-mini` | Strict JSON-schema responses |
| Anthropic | `claude-haiku-4-5` | Forced tool call for structured output |
| Command Code | pick from list | OpenAI-compatible Provider API at `https://api.commandcode.ai/provider/v1`. Has a **Zero Data Retention** switch (sends `x-cmd-zdr: 1`); `CMD_ZDR=1` forces it on. |
| OpenAI-compatible | – | LM Studio, OpenRouter, Groq, vLLM and others. Falls back from JSON-schema to JSON mode to plain instructions. |

Try any filename against the parser and the active model in the
**Untangler**. It doesn't touch your library.

<img src="docs/stripe.svg" width="100%" height="6" alt="">

<a id="quick-start"></a>

## ▶️ Run the dance: quick start

Needs **Node.js 22.13+** (Dubplate uses the built-in `node:sqlite`).

```bash
npm install
npm run build
npm start               # → http://127.0.0.1:4455
```

Development mode, with the API on :4455 and Vite on :5173 with hot reload:

```bash
npm run dev
```

> [!TIP]
> No music handy? `npm run demo -- ./demo-crates` makes a folder of silent
> files with realistically messy names.

**First session**

1. **Libraries**: add a folder. It's scanned read-only. Switch on **Watch for new files** to have new rips picked up and identified as they land.
2. **Settings → AI interpreter**: pick a provider and model, then hit **Test**.
3. **Dashboard → Process new**: interpret → scour → score.
4. **Review**: listen, check the evidence, fix anything that's off and approve.
5. **Cut & Tag**: do a dry run, switch off read-only mode, then cut. **Rewind** undoes any batch.

**Keyboard**

| Keys | Where | Does |
| --- | --- | --- |
| <kbd>⌘</kbd> <kbd>K</kbd> / <kbd>Ctrl</kbd> <kbd>K</kbd> | anywhere | Command palette |
| <kbd>⌘</kbd> <kbd>B</kbd> / <kbd>Ctrl</kbd> <kbd>B</kbd> | anywhere | Fold the sidebar to icons and back (remembered) |
| <kbd>J</kbd> / <kbd>K</kbd> | Review | Next / previous track |
| <kbd>A</kbd> | Review | Approve (and learn) |
| <kbd>X</kbd> | Review | Leave as-is |
| <kbd>Z</kbd> | Review | Undo the last approve / leave-as-is |
| <kbd>Shift</kbd>-click | Tracks | Tick every row between two checkboxes |

<a id="docker"></a>

## 🐳 Container ting: Docker

A ready-made image is published to GitHub Container Registry for
**amd64 and arm64**, so it runs on PCs, Macs, NAS boxes and a Raspberry Pi 4/5.
No Node.js or build step needed.

**One command**

```bash
docker run -d --name dubplate --init -p 4455:4455 \
  -v dubplate-data:/data \
  -v /path/to/your/music:/music \
  ghcr.io/sshahs/dubplate:latest
```

Then open **http://localhost:4455** and add libraries as `/music/…`.

**With compose** (recommended: keys, Ollama and updates in one place)

```bash
curl -O https://raw.githubusercontent.com/sshahs/dubplate/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/sshahs/dubplate/main/.env.example
# edit .env: set MUSIC_DIR, PUID/PGID and any API keys (all optional)
docker compose up -d              # → http://localhost:4455
```

Update to the newest build with `docker compose pull && docker compose up -d`.

| Tag | What it is |
| --- | --- |
| `latest` | The newest build of `main` |
| `1.2.3` · `1.2` · `1` | Releases, from `v*` git tags |
| `sha-abc1234` | One exact commit, for pinning or rolling back |

Pick one with `DUBPLATE_TAG` in `.env`.

- 🎵 Your music is mounted at **`/music`**. Add libraries in the app as `/music/…`.
- 💾 The staging database lives in the `dubplate-data` volume (`/data`). Keep it between upgrades.
- 👤 The container runs as `PUID:PGID` (default `1000:1000`). That user needs write access to your music for renames to work. With plain `docker run`, add `--user 1000:1000`.
- 🔍 `fpcalc` (Chromaprint) is bundled, so AcoustID fingerprinting works out of the box.
- 🧠 **Ollama on the host** is reached at `host.docker.internal:11434` by default. To run Ollama in the stack instead:

  ```bash
  OLLAMA_BASE_URL=http://ollama:11434 docker compose --profile ollama up -d
  docker compose exec ollama ollama pull qwen3:8b
  ```

- 🌐 If you browse to it by a LAN name or IP (e.g. a NAS), add that name or IP to `DUBPLATE_ALLOWED_HOSTS`.
- ❤️ A built-in healthcheck reports the container as healthy once the server is up.

<details>
<summary><b>Build the image yourself</b></summary>

From a checkout:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
# or
docker build -t dubplate .
```

Add `--build-arg WITH_FPCALC=0` to leave out Chromaprint.

Every push to `main` and every `v*` tag is built by
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml).
It smoke-tests the image (boots it and checks the API and UI), then publishes
both architectures to `ghcr.io`. Pull requests get the build and smoke test
without publishing.

</details>

<img src="docs/stripe.svg" width="100%" height="6" alt="">

<a id="configuration"></a>

## 🎚️ Mixing desk: configuration

Everything is editable in the UI. Environment variables set defaults and
secrets, and keys entered in the UI take precedence.

<details>
<summary><b>Environment variables</b></summary>

| Variable | Default | |
| --- | --- | --- |
| `DUBPLATE_PORT` | `4455` | |
| `DUBPLATE_HOST` | `127.0.0.1` | `0.0.0.0` in Docker |
| `DUBPLATE_DATA_DIR` | `~/.dubplate` | SQLite database + response cache |
| `DUBPLATE_ALLOWED_HOSTS` | – | Extra `Host` names allowed (DNS-rebinding guard); `*` disables the check |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | `http://localhost:11434`, `qwen3:8b` | |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY`, `COMMANDCODE_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` | – | |
| `CMD_ZDR` | – | `1` or `true` forces Command Code's Zero Data Retention on (the Settings switch is locked) |
| `DISCOGS_TOKEN`, `LASTFM_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `YOUTUBE_API_KEY`, `ACOUSTID_API_KEY` | – | |
| `FPCALC_PATH` | `fpcalc` on `PATH` | |
| `TZ` | `UTC` | The clock the nightly scan runs by, e.g. `Europe/London` |

</details>

<details>
<summary><b>Naming & tagging</b></summary>

The default template is `{artist} - {title}`. The available tokens are
`{artist}`, `{title}`, `{song}` (the title without the version),
`{version}`, `{year}`, `{album}`, `{label}`, `{featuring}` and `{genre}`.

- Clashes are joined with ` vs `, collaborations with ` & `, and three or more names become `A, B & C`.
- Featured artists go in the artist (`A feat. B - Title`) or the title (`A - Title (feat. B)`), as you prefer.
- Characters that filesystems reject are replaced. Names that would collide are **blocked, never overwritten**.

Tags are written with
[node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp), so MP3,
FLAC, M4A, OGG/Opus, WAV, AIFF, WMA and APE are all supported. Artist and
title are always written. Album, year, genre and label only fill fields that
are empty. BPM and key are written too (key as `Am` or Camelot `8A`, your
choice), and a found cover becomes the front cover — other pictures in the
file are left alone, and a file's existing cover is only replaced if you
allow it.

</details>

## 🛡️ Safety inna di dance

- 🔒 **Read-only by default.** Nothing on disk changes until you turn off read-only mode.
- 👀 Scans only stat, list and read.
- 🧾 Before writing, Dubplate checks that each file still has the size and mtime from the scan.
- 🚫 Renames stay in the same folder and never overwrite another file.
- ⏪ Every rename and tag write is logged with the old name and tag values (and any cover it replaced), so **Rewind** restores them all.
- ↩️ Review decisions and bulk edits come with **Undo** for a few moments afterwards.
- 🏠 The server binds to localhost, rejects unknown `Host` headers (DNS rebinding) and needs an `X-Dubplate` header on every write request (CSRF).

## 🎁 Extra riddims

- 🧠 **Learning**: approvals become examples for the AI, and an alias table maps shorthand to credited names (`buju` → Buju Banton, `kartel` → Vybz Kartel).
- 🎨 **Cover art**: found from the sources that identified a track, shown as thumbnails everywhere, and embedded when you cut.
- 🥁 **BPM & key**: worked out by listening (pure JS/WASM decoders, no ffmpeg), folded into a DJ-style range (88–175 by default, so a one-drop at 75 reads 150). Tags from the file and your own edits always win.
- 👀 **Watch folders**: new files are scanned and identified as they land, with a periodic re-check for network shares and an optional nightly rescan.
- ✏️ **Bulk edit**: set album, label, genre, year, artists, BPM or key across a selection — with Undo.
- 🗄️ **Big libraries**: the Tracks list only draws what's on screen and loads rows in blocks as you scroll, so tens of thousands of tracks stay quick.
- 🔔 **Job notifications**: a long job finishing in a background tab flags the tab title, and can pop a browser notification (needs HTTPS or localhost).
- 🎧 **Audio preview** in the review screen, with streaming and seeking.
- 👯 **Duplicates**: identical audio by fingerprint, plus different files that would get the same name.
- 📟 **Live console**: job progress and logs streamed over server-sent events.
- 📤 **Export** CSV or JSON reports for any filter.
- ⌨️ **Command palette**, and light and dark themes.

<img src="docs/stripe.svg" width="100%" height="6" alt="">

<a id="glossary"></a>

## 📖 Selector's glossary

The app borrows from sound-system culture. Here's what the words mean, both
in the dance and in Dubplate:

| Word | In the dance | In Dubplate |
| --- | --- | --- |
| **Dubplate** | A one-off acetate cut of a tune, often voiced exclusively for one sound | The app, and a *version* it keeps in the title, e.g. `(Dubplate)` |
| **Special** | A dubplate with the lyrics changed to big up a particular sound | Detected as a version; capped for review, since no database lists it |
| **Selector** | The one choosing the tunes | You, in the review queue |
| **Riddim** | The instrumental a tune is voiced on | Picked out by the AI (`Sleng Teng`, `Diwali`…) |
| **Clash** | Sound systems going head to head | `A vs B` readings, joined with ` vs ` |
| **Pull up / Rewind** | Stopping the tune to run it back from the top | **Rewind** puts a batch back exactly as it was |
| **Crates** | A selector's record boxes | Your libraries |
| **Big up** | Respect, a shout-out | What the success toasts say |

## 🔧 Development

```bash
npm test            # vitest: parser, confidence engine, naming, sources, BPM/key, artwork, undo, scan→cut→rewind on real files
npm run typecheck
npm run lint
```

```text
server/
  core/          filename parser, normaliser, confidence engine, naming (pure, shared with the UI)
  ai/            LLM providers + interpreter prompt
  sources/       MusicBrainz, Discogs, … + declarative scrapers, rate-limited cached HTTP
  analysis/      BPM & key: decoding, onset/tempo and chroma/key estimation
  scanner.ts     read-only library walker
  watcher.ts     watched folders, periodic re-checks, nightly scan
  pipeline.ts    interpret → scour → score (→ artwork, BPM & key)
  art.ts         cover-art cache, downloads, thumbnails
  worker-pool.ts CPU-heavy work (decoding, thumbnails) off the main thread
  executor.ts    plan / rename + tag / rewind
  undo.ts        short-lived undo for review decisions and bulk edits
  app.ts         Hono API + SSE
shared/types.ts  types used by server and UI
src/             React + Vite UI (shadcn/ui, Base UI)
docs/            banner, screenshots
```

### 🎨 The look

Built with Vite, React 19, Tailwind v4 and **shadcn/ui preset
[`b6FArvVnDX`](https://ui.shadcn.com)**: Base UI primitives, the *Luma*
style, a taupe base with a red theme, Hugeicons, Geist and Manrope, a large
radius and inverted-translucent menus. The palette is re-tuned for a roots
feel: warm yard neutrals, **red** as the primary, and **gold** and **green**
as first-class tokens. The chart colours are validated for colour-blind
separation in both themes. `components.json` is set up for the preset, so
`npx shadcn@latest add <component>` works as normal.

Motion uses the browser's View Transitions through React's
`<ViewTransition>`. Pages lift out and settle in, a red-gold-green marker
glides between sidebar items, Review slides tracks in the direction you're
moving, and the theme switch sweeps across as a circle. All of it turns off
when your system asks for reduced motion.

<br>

<img src="docs/stripe.svg" width="100%" height="6" alt="">

<p align="center">
  <b>Big up every selector, soundman, engineer and archivist keeping the culture alive.</b><br>
  <sub>Made for the crates. One love. 🟥🟨🟩</sub>
</p>
