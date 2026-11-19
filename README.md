# X Account Insight

A free, open-source browser extension for X (Twitter) that surfaces the data already sitting behind X's **About this account** page — country/region, connection type, account age, affiliation — as a small badge next to every name in your timeline, plus local filtering, stats and sharing tools built on top of it.

No account, no login, no tracking, no ads. Everything runs in your browser against your own signed-in session.

**What it reports is X's own account-level label, not a person's live location or the device behind one specific post.** Treat an "inaccurate location" warning as uncertainty, not proof of a VPN.

Jump to: [Badges](#badges) · [Account card](#account-card) · [Filters](#filters) · [Stats & sharing](#stats--sharing) · [Privacy](#privacy) · [Running it](#running-it) · [Contributing](#contributing)

## Badges

A small flag/connection/warning cluster appears next to usernames across your timeline, replies, quoted posts, profiles, people lists (Followers/Following), and identifiable 1:1 Chat threads. Size, background and placement are configurable under **Settings → Display**; badges follow X's own light/dark theme.

- **Flag** — the country or regional label X assigns (250+ countries/territories, 16 region groupings).
- **App-store / globe icon** — whether the account connects via iOS, Android, or the web.
- **Amber shield** — X itself flags the location as possibly unreliable.
- **Share icon** — exports the post, with its context, as an image.
- **Info icon** — opens the full account card.

## Account card

Click or hover a badge for everything X's about-page exposes, without leaving your feed: reported location and connection, follower/following/post/media counts, account creation date and handle-change history, verification tier and organizational affiliation, and a permanent ID-based profile link that survives handle changes. From the card you can also filter the account or its country, pin it to Always Show, or save/copy it as an image.

## Filters

Match on country/region, specific accounts (by permanent ID), display name or bio text, linked domains/URLs, account labels (Parody, Commentary, Government, etc.), organization affiliation, post language, follower/following counts, digit-heavy handles, or location-accuracy warnings. Matches can **Hide** a post outright or **Highlight** it with an amber border — nothing is muted, blocked, or reported to X, and changes apply instantly to posts already rendered.

Multiple named filter profiles are supported (work/personal/etc.), switchable per X account from the popup or **Settings → Blocking**. **Always Show** overrides any filter for accounts you pick, your own account, and optionally everyone you follow.

Full matching semantics — how region/country overlap, follow-status exemptions, quoted-post handling, language detection limits, and domain/URL exact-match rules work — are documented in the extension's **Settings → Blocking** help text and tooltips, since the mechanics are easiest to understand while looking at the actual controls.

## Stats & sharing

**Statistics** tallies filtered posts (deduplicated, hidden and highlighted combined) by country, region and device, plus a separate map of everything cached locally — all computed client-side from data already in your browser. **Share** renders a post into an image card with its text, photos, and the account context above, ready to quote/reply/post yourself or just save; nothing is posted automatically.

Local account data caps at 50,000 entries / 60 days and can be cleared or exported from **Data & Cache** in Settings.

## Privacy

- No telemetry, no analytics, no ads, no account for this extension itself.
- X session headers (auth/CSRF) stay local and are only ever sent to X.
- An optional, opt-out **community cache** shares looked-up public handles/metadata (not post text, bios, DMs, or session headers) across users who enable it — see [PRIVACY.md](PRIVACY.md) for exactly what that includes.
- Everything else X exposes on its own timeline responses stays in page-session memory and can be disabled under **Blocking → Behavior → Use profile details**.
- X's own labels (and anything shared via the community cache) can be stale, incomplete, or wrong — don't treat a badge as a verified fact.

Full details, including data retention and permissions, are in [PRIVACY.md](PRIVACY.md). This project is independent and not affiliated with, endorsed by, or supported by X Corp.

## Running it

This project isn't published to any browser store. The easiest way to get a working copy without a Node toolchain is the **[Releases page](https://github.com/theonlytruebigmac/x-account-insight/releases)** — every tagged release has pre-built `x-account-insight-chrome-vX.Y.Z.zip` and `x-account-insight-firefox-vX.Y.Z.zip` assets, built automatically by CI:

- **Chrome/Chromium**: download and unzip the `-chrome-` asset, then `chrome://extensions` → enable Developer mode → **Load unpacked** → select the unzipped folder.
- **Firefox**: download the `-firefox-` asset, then `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select the zip directly (no unzipping needed). This is a temporary install and is cleared when Firefox restarts.

To build from source instead (needed for `dev:*` watch mode or if you want to modify the code):

```bash
git clone https://github.com/theonlytruebigmac/x-account-insight.git
cd x-account-insight/extension
npm ci
npm run lint
npm run build
npm run check:build
```

Then load the unpacked build:

- **Chrome/Chromium**: `chrome://extensions` → enable Developer mode → **Load unpacked** → select `extension/dist/chrome`.
- **Firefox**: `about:debugging` → **This Firefox** → **Load Temporary Add-on** → select `extension/dist/firefox/manifest.json` (temporary install, cleared on restart).

`npm run dev:chrome` / `npm run dev:firefox` watch and rebuild automatically; `npm run package` produces both store-format ZIPs under `extension/dist/`. Reload the extension and refresh any open X tabs after rebuilding.

Source lives under `extension/src/` (content scripts, background service, shared modules, settings/popup UI, styles). `userscript/` is an older, non-feature-equivalent variant kept for reference.

## Contributing

Open an [issue](https://github.com/theonlytruebigmac/x-account-insight/issues) for bugs or feature requests — include browser/extension version and repro steps, and never paste cookies, auth headers, or unredacted account/network data.

For PRs: keep changes scoped, reuse the existing filtering/settings modules rather than adding new ones, run the `npm run check:*` scripts relevant to what you touched, and verify both Chrome and Firefox. UI changes need both themes checked; filter changes need Hide/Highlight, Always Show, and quoted/opened-post behavior checked.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT — see [LICENSE](LICENSE). This project started as a fork of [x-account-location-device](https://github.com/xaitax/x-account-location-device) ("X-Posed") by Alexander Hagenah, also MIT licensed. It has since diverged into an independent codebase and is not affiliated with, supported by, or endorsed by the original author or project.
