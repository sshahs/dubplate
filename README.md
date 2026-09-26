# Dubplate

**An AI-assisted music tagger and renamer for sound-system collections.**

Dubplate reads badly named rips the way a selector would, checks what it
thinks it hears against MusicBrainz, Discogs, Bandcamp and friends, and only
renames files to `Artist - Title` when the sources agree. Everything else goes
to a review queue for your ear, and every batch can be rewound.

![Dashboard](docs/screenshots/dashboard.png)

```
12_buju_banton_vs_beenie_man_live_93_dubplate.mp3
  → Buju Banton vs Beenie Man - Live Clash (Dubplate).mp3     review · 78

03. Wiley - Wot Do U Call It (Official Video) [320kbps] www.grimeripz.com.mp3
  → Wiley - Wot Do U Call It.mp3                              matched · 93
```

## How it works

| Stage | What happens |
| --- | --- |
| **1. Read-only scanner** | Walks your library folders, reads existing tags, duration and a content fingerprint into a SQLite staging database. It never opens a music file for writing. Moved files are followed by fingerprint; exact duplicates are flagged. |
| **2. Rule-based parser** | A fast first pass: strips rip-site names, bitrates, "(Official Video)", track and vinyl-side numbers, splits `Artist - Title`, `Title by Artist`, `A vs B` clashes, featuring credits, and spots hints like *dubplate*, *special*, *live '93*, *riddim*, *VIP*. |
| **3. AI interpreter** | An LLM (local via Ollama, or cloud) reads the filename, folder, tags and first-pass result and returns structured JSON: artists, relation (`&` / `vs`), title, version, year, riddim, event, alternatives and search queries. It learns from your approvals, which are shown to it as examples. |
| **4. Metadata scourer** | Queries every enabled source in parallel with per-host rate limits and a 7-day response cache. |
| **5. Confidence engine** | Clusters the source hits, measures consensus across independent sources, agreement between readings, duration, fingerprint matches and conflicts, and produces an explainable 0–100 score. |
| **6. Verify & execute** | Matched tracks can be bulk-approved, and conflicts and mid-confidence tracks queue for review. Approved files are renamed and tagged in place. Every operation is journalled so any batch can be rewound. |

### Confidence, explained

Every score comes with its working (the **Evidence** tab):

- **Readings agree**: how closely the AI, the rule-based parser and the embedded tags agree.
- **AI certainty**: the model's own confidence.
- **Sources match the reading**: how close the best source hit is to what the file says.
- **Source consensus**: how many independent sources back the same recording, weighted by trust.
- **Conflicts** reduce the score when another strong cluster disagrees. **Duration** and an **AcoustID fingerprint** can adjust it up or down.

Defaults: **≥ 90** auto-matches, **60–89** goes to review, and anything
below is unmatched. A reading that no source confirms is capped at 75, so
dubplates and specials that exist nowhere online always get a human check.
All thresholds and source weights can be changed in Settings.

## Sources

| Source | Key needed | Notes |
| --- | --- | --- |
| MusicBrainz | – | 1 req/s; the most authoritative |
| Discogs | personal token | Opens the matching release to find the actual track; strong for 7″s and white labels |
| Apple Music (iTunes Search) | – | |
| Deezer | – | Includes durations |
| Spotify | client ID + secret | Client-credentials flow |
| Last.fm | API key | Crowd-sourced, so weighted lower |
| Bandcamp | – | Independent dub, grime and sound-system releases |
| Internet Archive | – | Clash tapes, pirate radio sets |
| Mixcloud | – | Radio shows and clash recordings |
| YouTube | Data API key | Uses auto-generated "Artist - Topic" channels where available |
| AcoustID | app key + `fpcalc` | Audio fingerprinting: identifies the audio itself |
| **Custom scrapers** | – | Point Dubplate at any specialist site's search page (CSS selectors) or JSON API (dot-paths, e.g. WordPress `/wp-json`). Built-in *Test* shows what it extracts. Presets for Juno Download and a sound-clash archive ship disabled until you verify them. |

## AI providers

| Provider | Default model | Notes |
| --- | --- | --- |
| Ollama (local) | `qwen3:8b` | Structured JSON output via `format` |
| Ollama Cloud | `gpt-oss:120b` | `https://ollama.com` + API key |
| OpenAI | `gpt-5-mini` | Strict JSON-schema responses |
| Anthropic | `claude-haiku-4-5` | Forced tool call for structured output |
| Command Code | pick from list | OpenAI-compatible Provider API at `https://api.commandcode.ai/provider/v1` |
| OpenAI-compatible | – | LM Studio, OpenRouter, Groq, vLLM…; falls back from JSON-schema to JSON mode to plain instructions |

Use the **Untangler** page to try any filename against the parser and the
active model without touching your library.

## Quick start

Requires **Node.js 22.13+** (Dubplate uses the built-in `node:sqlite`).

```bash
npm install
npm run build
npm start               # → http://127.0.0.1:4455
```

Development mode, with the API on :4455 and Vite on :5173 with hot reload:

```bash
npm run dev
```

No music handy? `npm run demo -- ./demo-crates` creates a folder of silent
files with realistically messy names.

Then:

1. **Libraries**: add a folder. It's scanned read-only.
2. **Settings → AI interpreter**: pick a provider and model, then **Test**.
3. **Dashboard → Process new**: interpret → scour → score.
4. **Review**: listen, check the evidence, fix and approve (`J`/`K` to move, `A` approve, `X` leave as-is).
5. **Cut & Tag**: do a dry run, switch off read-only mode, then rename and tag. **Rewind** undoes any batch.

## Docker

```bash
cp .env.example .env        # set MUSIC_DIR, PUID/PGID, keys (all optional)
docker compose up -d        # → http://localhost:4455
```

- Your music is mounted at **`/music`**. Add libraries in the app as `/music/…`.
- The staging database lives in the `dubplate-data` volume (`/data`).
- The container runs as `PUID:PGID` (default `1000:1000`). That user needs write access to your music for renames to work.
- `fpcalc` (Chromaprint) is bundled for AcoustID. Build with `--build-arg WITH_FPCALC=0` to leave it out.
- **Ollama on the host** is reached at `host.docker.internal:11434` by default. To run Ollama in the stack instead:

  ```bash
  OLLAMA_BASE_URL=http://ollama:11434 docker compose --profile ollama up -d
  docker compose exec ollama ollama pull qwen3:8b
  ```
- If you browse to it by a LAN name or IP (e.g. a NAS), add that name or IP to `DUBPLATE_ALLOWED_HOSTS`.

## Configuration

Everything is editable in the UI. Environment variables set defaults and
secrets, and keys entered in the UI take precedence.

| Variable | Default | |
| --- | --- | --- |
| `DUBPLATE_PORT` | `4455` | |
| `DUBPLATE_HOST` | `127.0.0.1` | `0.0.0.0` in Docker |
| `DUBPLATE_DATA_DIR` | `~/.dubplate` | SQLite database + response cache |
| `DUBPLATE_ALLOWED_HOSTS` | – | Extra `Host` names allowed (DNS-rebinding guard); `*` disables the check |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | `http://localhost:11434`, `qwen3:8b` | |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_API_KEY`, `COMMANDCODE_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` | – | |
| `DISCOGS_TOKEN`, `LASTFM_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `YOUTUBE_API_KEY`, `ACOUSTID_API_KEY` | – | |
| `FPCALC_PATH` | `fpcalc` on `PATH` | |

### Naming

The default template is `{artist} - {title}`. The available tokens are
`{artist}`, `{title}`, `{song}` (the title without the version),
`{version}`, `{year}`, `{album}`, `{label}`, `{featuring}` and `{genre}`.
Clashes are joined with ` vs `, collaborations with ` & ` (three or more
become `A, B & C`), and featured artists go in the artist or the title as you
prefer. Characters that filesystems reject are replaced, and names that
collide are blocked, never overwritten.

Tag writing uses [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp),
so MP3, FLAC, M4A, OGG/Opus, WAV, AIFF, WMA and APE are all supported. Artist
and title are always written. Album, year, genre and label only fill fields
that are empty.

## Safety

- **Read-only by default.** Nothing on disk changes until you turn off read-only mode.
- Scans only stat, list and read.
- Before writing, Dubplate checks that each file still has the size and mtime from the scan.
- Renames stay in the same folder and never overwrite another file.
- Each rename and tag write is journalled with the previous name and tag values, so **Rewind** restores both.
- The server binds to localhost, rejects unknown `Host` headers (DNS rebinding) and requires an `X-Dubplate` header on every write request (CSRF).

## Other features

- **Learning**: approvals become few-shot examples for the AI, and an alias table maps shorthand to credited names (`buju` → Buju Banton).
- **Audio preview** in the review screen, with streaming and seeking.
- **Duplicates**: identical audio by fingerprint, plus different files that would get the same name.
- **Live console**: job progress and logs over server-sent events.
- **Export** of CSV/JSON reports for any filter.
- **Command palette** (`⌘K` / `Ctrl+K`).
- Light and dark themes.

## Development

```bash
npm test            # vitest: parser, confidence engine, naming, sources, scan→cut→rewind on real files
npm run typecheck
npm run lint
```

```
server/
  core/          filename parser, normaliser, confidence engine, naming (pure, shared with the UI)
  ai/            LLM providers + interpreter prompt
  sources/       MusicBrainz, Discogs, … + declarative scrapers, rate-limited cached HTTP
  scanner.ts     read-only library walker
  pipeline.ts    interpret → scour → score
  executor.ts    plan / rename + tag / rewind
  app.ts         Hono API + SSE
shared/types.ts  types used by server and UI
src/             React + Vite UI (shadcn/ui, Base UI)
```

### UI and theme

Built with Vite, React 19, Tailwind v4 and shadcn/ui using preset
**`b6FArvVnDX`**: Base UI primitives, the *Luma* style, a taupe base with a
red theme, Hugeicons, Geist and Manrope, a large radius and
inverted-translucent menus. The palette is re-tuned for a roots feel: warm
yard neutrals, red as the primary, and gold and green as first-class tokens.
Confidence is always shown in those three colours, so a band's colour means
the same thing everywhere. `components.json` is set up for the preset, so
`npx shadcn@latest add <component>` works as normal.
