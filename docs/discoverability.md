# Discoverability: what the network publishes, and the owner-only steps

The network's answer to "be found by search engines and AI systems without spamming anyone". Everything a crawler
can do without an account is already public; this page records what is in place, the steps only the owner can take,
and the drafts for the places that need a human account.

## What every site already answers

- `robots.txt` allows Googlebot, Bingbot, DuckDuckBot, Applebot, GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot,
  Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User and the rest by name, with content signals
  (`search=yes, ai-input=yes, ai-train=yes`) and the `Sitemap:` line. Private routes stay disallowed and `noindex`.
- `/llms.txt` and `/llms-full.txt` describe each site in plain Markdown with dates; `/sitemap.xml` carries the public
  pages with `lastmod`; public pages have a `.md` twin.
- Home pages carry Organization and WebSite JSON-LD; products use WebApplication, Report's tables are a Dataset,
  posts use Article, FAQs are FAQPage with open text (never a closed accordion), and content pages show `Updated`.
- Content sites publish RSS/Atom/JSON feeds (Community's forum threads, News, Reviews, Deals, Coupons, Trade, Blog,
  Wiki and Report's AI results), and IndexNow is sent on publish.

Nothing here needs an account with anyone. It is fetched and cited by whoever crawls it.

## Owner-only steps (accounts are yours)

1. **Social preview images** (the GitHub API cannot set them): open each repository's Settings → Social preview and
   upload the card the site already serves, 1200×630:
   `https://<site>/shared/social/<service>.jpg` — for example
   [live](https://openvibe.live/shared/social/live.jpg), [network](https://openvibe.network/shared/social/network.jpg),
   [chat](https://openvibe.chat/shared/social/chat.jpg), [community](https://openvibe.community/shared/social/community.jpg),
   [games](https://openvibe.games/shared/social/games.jpg), [tools](https://openvibe.tools/shared/social/tools.jpg),
   [services](https://openvibe.services/shared/social/services.jpg).
2. **Google Search Console**: add a Domain property for `openvibe.network` and the product domains, verify by DNS TXT,
   submit `https://openvibe.network/sitemap.xml` and each product site's sitemap. Verify the same domains in **Bing
   Webmaster Tools** (this also activates IndexNow for them).
3. **GitHub organization profile**: the `OpenVibers/OpenVibers` profile README lists every product; keep it first when
   a product launches. Repository descriptions, homepages and topics are set on every public repository.

## Ready drafts (post only from your own accounts, disclose you build it)

**Show HN** — title: `Show HN: OpenVibe – open-source live streaming, chat and tools, one account`
Body: I built OpenVibe, an open-source network that starts with live streaming: go live from a browser or OBS with no
follower minimum, then chat, clip, restream and get a rundown of what you talked about. It also has a community home,
a wiki, blogs, a news reader, AI agents and small everyday tools. Every site is crawlable, has an `llms.txt`, JSON-LD,
Atom feeds and a Markdown twin. AGPL services, MIT libraries, no ads at launch. I would value feedback on the
streaming path and on what to build next. https://openvibe.live

**Reddit r/selfhosted** — title: `OpenVibe: an open-source live streaming and community network (AGPL, browser or OBS)`
Body: We run a network of small services on one account. Live accepts RTMP and WHIP, plays in the browser, keeps clips
and VODs in a separate media service, and restreams to other platforms. The services are AGPL-3.0, the SDK and shared
UI are MIT, and every site publishes feeds, sitemaps, JSON-LD and an `llms.txt`. Happy to answer how the pieces talk to
each other. https://openvibe.live — docs for the streaming API: https://openvibe.live/docs/whip

**dev.to** — title: `Making a network answer-first for AI search: robots, llms.txt, JSON-LD and feeds`
Article beats: the retrieval bots we allow by name and why; why `llms.txt` is optional and crawlable HTML is not; the
JSON-LD we emit per page type; visible `Updated` dates and original numbers; Atom feeds for public content; what we
refuse to do (hidden text, doorway pages, keyword stuffing, link schemes). Link to the live `robots.txt`, `llms.txt`
and one JSON-LD example.

**Product Hunt** — tagline: `Open-source live streaming and community, no follower minimum`
Description: Go live from a browser or OBS, chat, clip, restream, and get The Rundown of what you talked about.
OpenVibe is a network of open-source services — community, wiki, blogs, news, AI tools — with one account and public,
machine-readable pages. First comment: what is open (AGPL services, MIT SDK), how to self-host, and where to ask.

**awesome-list PR** — add one line under the live-streaming section, only after confirming the project meets the
list's self-hosting bar:
`- [OpenVibe.Live](https://github.com/OpenVibers/OpenVibe.Live) - Open-source live streaming from a browser or OBS with chat, clips, restream and VODs (AGPL-3.0).`

Rules for all of the above: one post per community, answer comments, never ask for votes, never post the same text in
several places, and stop if a community's rules say no. That is the line between being found and being spam.

## "Seen by AI" (Report, owner-only)

A weekly measurement, not a growth trick: ask a fixed list of questions a person would ask, through the network's own
AI with web search on, and record whether OpenVibe is cited and which page.

- Questions (fixed, so the series is comparable): "best free live streaming site with no follower minimum",
  "open source alternative to Discord", "open source Twitch alternative", "free online tools no signup",
  "open source community platform with chat and forums", "self-hosted live streaming with RTMP and WebRTC".
- Run: the cheapest model on the `report.ai-visibility` task, one run a week, with the answer's citations stored as
  `(week, question, cited, page_url, model)` — never the raw prompt or a person's data.
- Publish: an owner-only page and chart in Report at first, with the question list and the date of each run.
- Cost: bounded by one run per question per week; the job refuses to start without a cost cap.

This is the only measurement step that spends AI money; it stays an owner decision until the series proves useful.
