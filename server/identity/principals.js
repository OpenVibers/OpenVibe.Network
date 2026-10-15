'use strict';
/**
 * Service principals (roadmap Wave 1, ADR-003; contract identity.service-token-claims@1).
 *
 * A first-party service authenticates to /oauth/token with grant_type=client_credentials and the
 * OAuth client id/secret it already has, and receives a 5-minute RS256 token whose `cap` claim is
 * exactly what principal_grants allows it for the requested audience. Receivers check the one
 * capability each route performs (openvibe-contracts serviceAuth.requireCapability).
 *
 * Every internal route takes a service token and nothing
 * else. principal_usage counts, per caller and route, each decision.
 */
const crypto = require('crypto');
const { serviceAuth, capabilities, assertValid, http } = require('openvibe-contracts');

const TOKEN_TTL_S = 300;
const SELF_AUDIENCE = 'openvibe.network';

const CHAT_NAMESPACES = ['chat.preferences', 'chat.tts_defaults', 'chat.dm_settings', 'chat.presence_prefs'];

// Initial grants: what each service does against Network today.
const DEFAULT_GRANTS = [
    ['live', 'network.coins.credit', SELF_AUDIENCE, ['live']],
    // OpenVibe.Quest pays a completed quest's OpenCoins (app_id quest, idempotency_key = the completion id), resolving
    // the person's subject to the wallet first, and subscribes to the events it counts (plan T19).
    ['quest', 'network.coins.credit', SELF_AUDIENCE, ['quest']],
    ['quest', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['quest', 'events.subscription.manage', 'openvibe.events', []],
    // They subscribe to network.account.export_requested and network.account.deleted at boot (ADR-033).
    ...['actor', 'food', 'help', 'work', 'rent', 'media-hub'].map((svc) => [svc, 'events.subscription.manage', 'openvibe.events', []]),
    // Their pages go into OpenVibe.Search: <svc>.index_document.* through each one's outbox (openvibe-publishing/search-feed,
    // contracts 0.128.0). Inventory publishes already (below).
    ...['work', 'rent', 'help', 'quest'].map((svc) => [svc, 'events.event.publish', 'openvibe.events', []]),
    // The same two subscriptions for the services that gained an account-event route on 2026-10-09 (SDK 0.37.0
    // startSubscriptions); deals, trade, tips and vip already hold the grant for their other subscriptions.
    ...['watch', 'services', 'wiki', 'blog', 'bot'].map((svc) => [svc, 'events.subscription.manage', 'openvibe.events', []]),
    // MediaHub resolves the usernames an owner names on a share link to subjects (only subjects are matched).
    ['media-hub', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // OpenVibe.Inventory (ADR-054) publishes inventory.* through its outbox and subscribes to the account events at boot;
    // Live is the issuer of the live.* kinds (its cosmetics), reads and equips for the people it serves.
    ['inventory', 'events.event.publish', 'openvibe.events', []],
    ['inventory', 'events.subscription.manage', 'openvibe.events', []],
    // Plan T16: Codes keeps the coding tasks people start on their own machines (run_tasks), so it answers account
    // export and deletion (ADR-033) and subscribes to them first; its account grants follow once it is subscribed.
    ['codes', 'events.subscription.manage', 'openvibe.events', []],
    // The Workshop (ADR-054 §6): a creator gives a badge to "@name"; Inventory resolves the name to a subject.
    ['inventory', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ...['inventory.item.read', 'inventory.item.list', 'inventory.equip.manage', 'inventory.item.grant', 'inventory.item.consume', 'inventory.definition.manage']
        .map((cap) => ['live', cap, 'openvibe.inventory', []]),
    // OpenVibe.Quest gives six of Live's items as quest rewards: Live names Quest a grantor of them (ADR-054 §3), so
    // Quest grants them itself (origin earned, the completion id as the key) and nothing else.
    ['quest', 'inventory.item.grant', 'openvibe.inventory', []],
    // OpenVibe.Games gives six of Live's items for achievements (Inventory's live-grantors.json names Games on them),
    // granted to signed-in players once each (origin earned, games:<game>:<achievement>:<subject> as the key).
    ['games', 'inventory.item.grant', 'openvibe.inventory', []],
    // OpenVibe.Play (contracts 0.172.0, Games ADR-0007 decision 10): Games registers Scraplandia and Salvage Rush as Play
    // titles and posts their scores and unlocks there. Play subscribes to the account events at boot (its account grants
    // are with the other services' above).
    ...['play.title.manage', 'play.result.write', 'play.player.read'].map((cap) => ['games', cap, 'openvibe.play', []]),
    ['play', 'events.subscription.manage', 'openvibe.events', []],
    ['live', 'network.coins.debit', SELF_AUDIENCE, ['live']],
    ['live', 'network.notifications.push', SELF_AUDIENCE, ['live']],
    // User modules: each service reads and writes the namespaces it owns (openvibe-contracts manifests/namespaces).
    // The chat.* namespaces are Chat's (chat.preferences since the Wave 6 cutover, chat.tts_defaults since
    // contracts 0.41.0). A service reading another's namespace sees only the fields `readers` lists for it.
    ['live', 'network.modules.read', SELF_AUDIENCE, ['live.profile', 'live.stats', 'live.loyalty']],
    ['live', 'network.modules.write', SELF_AUDIENCE, ['live.profile', 'live.stats', 'live.loyalty']],
    ['chat', 'network.modules.read', SELF_AUDIENCE, CHAT_NAMESPACES],
    ['chat', 'network.modules.write', SELF_AUDIENCE, CHAT_NAMESPACES],
    ['ai', 'network.modules.read', SELF_AUDIENCE, ['ai.preferences', 'ai.usage_summary']],
    ['ai', 'network.modules.write', SELF_AUDIENCE, ['ai.usage_summary']],
    ['community', 'network.modules.read', SELF_AUDIENCE, ['community.profile']],
    ['community', 'network.modules.write', SELF_AUDIENCE, ['community.profile']],
    ['wiki', 'network.modules.read', SELF_AUDIENCE, ['wiki.projects']],
    ['wiki', 'network.modules.write', SELF_AUDIENCE, ['wiki.projects']],
    ['tools', 'network.modules.read', SELF_AUDIENCE, ['tools.usage']],
    ['tools', 'network.modules.write', SELF_AUDIENCE, ['tools.usage']],
    ['games', 'network.modules.read', SELF_AUDIENCE, ['games.progress.summary']],
    ['games', 'network.modules.write', SELF_AUDIENCE, ['games.progress.summary']],
    // Wave 5: Community owns pastes. It resolves authors and uploads screenshot bytes to Media; Live writes
    // pastes into Community on behalf of its users and its AI jobs.
    ['community', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['community', 'media.object.upload', 'openvibe.media', ['community']],
    // Wave 11: Tools job results as Media objects; Wave 12: Games map-editor assets.
    // tools.* : developer projects' results go to tools.app.<project_id>[.sandbox] (WS-L task 5).
    ['tools', 'media.object.upload', 'openvibe.media', ['tools', 'tools.*']],
    ['tools', 'media.object.read', 'openvibe.media', ['tools', 'tools.*']],
    ['games', 'media.object.upload', 'openvibe.media', ['games']],
    // Plan T12: Host keeps tenant deploy files in Media (Host#24, HOST_OBJECT_STORE=media), its own namespace only:
    // write-through on deploy, re-fetch on a cache miss, list and delete when its GC finds a blob unreferenced.
    // Plan T4 (Media cleanup): Live and OpenRestream reach Media with their own tokens instead of API keys. Live keeps
    // its objects under the live namespace (VOD/clip/thumbnail uploads, reads, lists, deletes); OpenRestream uploads the
    // recordings and thumbnails it produces there too.
    ...['media.object.read', 'media.object.list', 'media.object.upload', 'media.object.delete'].map(cap => ['live', cap, 'openvibe.media', ['live']]),
    ['openre', 'media.object.upload', 'openvibe.media', ['live']],
    // Compatibility register C-71: Inventory (Workshop badge images) and MediaHub (its library) reach Media with their
    // own tokens on their own tenants, not with app keys. Upload also covers the delete of an object.
    ['inventory', 'media.object.upload', 'openvibe.media', ['inventory']],
    ['media-hub', 'media.object.upload', 'openvibe.media', ['media-hub']],
    ['media-hub', 'media.object.read', 'openvibe.media', ['media-hub']],
    // Plan T3: Chat owns the six chat tables. Emote images go to Media under the chat namespace, and
    // the chat-AI summaries run in Chat with its own token.
    ['chat', 'media.object.upload', 'openvibe.media', ['chat']],
    ['chat', 'media.object.delete', 'openvibe.media', ['chat']],
    ['chat', 'ai.run.create', 'openvibe.ai', ['chat.*']],
    ['chat', 'ai.run.read', 'openvibe.ai', ['chat.*']],
    ['games', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // Games subscribes to network.user.token_valid_after (sign-out everywhere closes game sessions).
    ['games', 'events.subscription.manage', 'openvibe.events', []],
    // Media and Tools subscribe to network.user.token_valid_after too (their sign-in refuses older tokens).
    ['media', 'events.subscription.manage', 'openvibe.events', []],
    ['tools', 'events.subscription.manage', 'openvibe.events', []],
    // Mod principals (ADR-013, WS-M task 3): Games registers its mod installs and changes their grants.
    ['games', 'mods.grant.manage', SELF_AUDIENCE, []],
    // Account export and deletion (ADR-033): the services that keep data about people push their export part and
    // confirm a deletion; the holders of each grant are the services Network waits for.
    // Since 2026-10-08 the services built from the skeleton answer too, through openvibe-sdk/account-data (SDK 0.36.0),
    // and since 2026-10-09 the older services that hold personal rows (SDK 0.37.0; each subscribed before this grant).
    // Codes since 2026-10-14 (its run_tasks, plan T16; subscribed first through Network#178). Play since 2026-10-14 (its
    // scores and unlocks; subscribed at its first boot, Network#189).
    ...['live', 'chat', 'community', 'media', 'games', 'actor', 'food', 'help', 'work', 'quest', 'rent', 'media-hub',
        'deals', 'trade', 'tips', 'vip', 'watch', 'services', 'wiki', 'blog', 'bot', 'inventory', 'codes', 'play'].flatMap((svc) => [
        [svc, 'network.account.export.contribute', SELF_AUDIENCE, []],
        [svc, 'network.account.deletion.confirm', SELF_AUDIENCE, []],
    ]),
    // Wave 9: Tips starts purchases and transfers in Billing, follows settlement through Events, and
    // announces delivered tips in the creator's Live chat. Since plan T5 the announcement itself goes
    // through OpenVibe.Chat's typed ingress, with Tips' own service token (TIPS_CHAT_ADAPTER=chat;
    // OpenVibe.Tips server/delivery/chat.js asks for exactly these two capabilities).
    ['tips', 'billing.intent.create', 'openvibe.billing', []],
    ['tips', 'billing.transfer.create', 'openvibe.billing', []],
    ['tips', 'events.subscription.manage', 'openvibe.events', []],
    ['tips', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['tips', 'live.tips_delivery.write', 'openvibe.live', []],
    ['tips', 'chat.message.send', 'openvibe.chat', []],
    ['tips', 'chat.event.publish', 'openvibe.chat', []],
    ['live', 'tips.interaction.record', 'openvibe.tips', []],
    // Wave 7: Live manages its slots' streams, keys and sessions on OpenRestream; OpenRestream publishes
    // session/output events (Live consumes openre.session.* by webhook).
    ...['openre.stream.read', 'openre.stream.write', 'openre.key.rotate', 'openre.session.read'].map(c => ['live', c, 'openvibe.openre', []]),
    ['openre', 'events.event.publish', 'openvibe.events', []],
    // OpenVibe Live on by default (contracts 0.126.0): OpenRestream asks Live for a slot on the person's channel bound to
    // their OpenRestream stream, so its sessions show on openvibe.live through Live's mirror.
    ['openre', 'live.openre.slot.bind', 'openvibe.live', []],
    // Wave 16: Wiki publishes events, attaches Community discussion, cites Sources items, reads its Media.
    ['wiki', 'events.event.publish', 'openvibe.events', []],
    ['wiki', 'community.comment.write', 'openvibe.community', []],
    ['wiki', 'community.comment.moderate', 'openvibe.community', []],
    ['wiki', 'sources.item.read', 'openvibe.sources', []],
    ['wiki', 'media.object.read', 'openvibe.media', ['wiki']],
    // Wave 16: Blog (same shape as Wiki; it may hide the thread of a post that stopped being public).
    ['blog', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // The network changelog reads the GitHub token the owner configures (server/integrations/github.js).
    ['blog', 'network.integration.github.read', SELF_AUDIENCE, []],
    ['blog', 'events.event.publish', 'openvibe.events', []],
    ['blog', 'community.comment.write', 'openvibe.community', []],
    ['blog', 'community.comment.moderate', 'openvibe.community', []],
    ['blog', 'media.object.read', 'openvibe.media', ['blog']],
    // Wave 10: VIP sells plans through Billing and projects its entitlements from Billing events.
    ['vip', 'billing.intent.create', 'openvibe.billing', []],
    ['vip', 'billing.subscription.manage', 'openvibe.billing', []],
    ['vip', 'billing.entitlement.check', 'openvibe.billing', []],
    ['vip', 'events.event.publish', 'openvibe.events', []],
    ['vip', 'events.subscription.manage', 'openvibe.events', []],
    ['vip', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // Wave 17: Reviews reads Sources review items (and follows them by event), links Community discussion.
    ['reviews', 'sources.item.read', 'openvibe.sources', []],
    ['reviews', 'sources.source.read', 'openvibe.sources', []],
    ['reviews', 'events.event.publish', 'openvibe.events', []],
    ['reviews', 'events.subscription.manage', 'openvibe.events', []],
    ['reviews', 'community.comment.write', 'openvibe.community', []],
    // Wave 17: News reads Sources news items (and follows them and fetch failures by event).
    ['news', 'sources.item.read', 'openvibe.sources', []],
    ['news', 'sources.source.read', 'openvibe.sources', []],
    ['news', 'events.event.publish', 'openvibe.events', []],
    ['news', 'events.subscription.manage', 'openvibe.events', []],
    ['news', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['news', 'community.comment.write', 'openvibe.community', []],
    ['news', 'community.comment.moderate', 'openvibe.community', []],
    ['news', 'ai.run.create', 'openvibe.ai', ['news.*']],
    ['news', 'ai.run.read', 'openvibe.ai', ['news.*']],
    // Blog's "Draft with AI" (blog.draft_post; Blog server/domain/ai-drafts.js, 2026-09-24).
    ['blog', 'ai.run.create', 'openvibe.ai', ['blog.*']],
    ['blog', 'ai.run.read', 'openvibe.ai', ['blog.*']],
    // Wave 19: Trade (informational) reads Sources filings and publishes events.
    ['trade', 'events.event.publish', 'openvibe.events', []],
    ['trade', 'sources.item.read', 'openvibe.sources', []],
    ['trade', 'sources.source.read', 'openvibe.sources', []],
    // Trade's scripts/subscribe.js (Trade #9) manages its own Events subscriptions.
    ['trade', 'events.subscription.manage', 'openvibe.events', []],
    // Wave 18: Deals and Coupons; Wave 21 Stage B: the Host API publishes deploy/domain events.
    ['deals', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['deals', 'events.event.publish', 'openvibe.events', []],
    ['deals', 'events.subscription.manage', 'openvibe.events', []],
    ['deals', 'sources.item.read', 'openvibe.sources', []],
    ['deals', 'community.comment.write', 'openvibe.community', []],
    ['deals', 'community.comment.moderate', 'openvibe.community', []],
    ['coupons', 'events.event.publish', 'openvibe.events', []],
    // Coupons subscribes to the sources it watches (OpenVibe.Coupons scripts/subscribe.js), as Deals does.
    ['coupons', 'events.subscription.manage', 'openvibe.events', []],
    ['coupons', 'sources.item.read', 'openvibe.sources', []],
    ['host', 'events.event.publish', 'openvibe.events', []],
    // T20 step 2 (2026-10-12, Space#36): the static hosting engine moved to Space, which publishes space.deploy.* and
    // space.domain.verified through its outbox. (Its forum-era grants stay revoked below.)
    ['space', 'events.event.publish', 'openvibe.events', []],
    // The hosting catalog (plan T20 step 3) reads OpenVibe.Sources items in category hosting (Host#69).
    ['host', 'sources.item.read', 'openvibe.sources', []],
    // The hosting catalog's provider and plan discussion threads on OpenVibe.Community (Host#74).
    ['host', 'community.comment.write', 'openvibe.community', []],
    ['host', 'community.comment.moderate', 'openvibe.community', []],
    // ADR-030 (WS-E task 4): Live rebuilds its follows projection from Network's graph.
    ['live', 'network.follows.read', SELF_AUDIENCE, []],
    ['live', 'network.follows.write', SELF_AUDIENCE, []],
    // WS-E task 6: Live's creator dashboards read the full analytics built from its events.
    ['live', 'network.analytics.creator.read', SELF_AUDIENCE, []],
    // WS-H task 11: Host relays the alerts firing on the production host (ovhost alerts relay).
    ['host', 'network.operator.alert', SELF_AUDIENCE, []],
    // WS-X1: Host reports the platform's machines to the node registry (ovhost nodes report).
    ['host', 'network.node.report', SELF_AUDIENCE, []],
    ['host', 'network.resource.report', SELF_AUDIENCE, []],
    // Plan T2 N4b: Bot pairs its users' machines with Network and reads or revokes only the principals it paired.
    ['bot', 'network.node.manage', SELF_AUDIENCE, []],
    // Plan T15: an owner adds an operator by @username on the robot's panel; Bot resolves it to the subject here.
    ['bot', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // Plan T15: Bot runs each robot's OpenRestream stream for its owner (find/create/archive, key rotation), plays the live
    // session in the panel (session.read), restreams out (output.*) and sets the owner's streaming and recording
    // toggles on the stream, minting its own token with its Network client instead of a hand-set BOT_OPENRE_TOKEN.
    ...['openre.stream.read', 'openre.stream.write', 'openre.key.rotate', 'openre.session.read', 'openre.output.read', 'openre.output.write'].map(c => ['bot', c, 'openvibe.openre', []]),
    // Bot's outbox relays bot.robot.*, bot.estop.*, bot.command.* and its job metering posts run:<job>:<n> readings
    // (server/events/outbox.js, server/jobs/metering.js); both relays stayed off without these rows (2026-10-07).
    ['bot', 'events.event.publish', 'openvibe.events', []],
    ['bot', 'billing.usage.record', 'openvibe.billing', []],
    // Plan T18: OpenVibe.Watch relays watch.observation.recorded / watch.watch.triggered / watch.check.failed.
    ['watch', 'events.event.publish', 'openvibe.events', []],
    // Plan T18 step 4: a watch's notification action tells its owner when the condition fires. Watch resolves the owner
    // (a usr_ subject) to Network's user id, then pushes as app 'watch' (openvibe-sdk/notifications).
    ['watch', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['watch', 'network.notifications.push', SELF_AUDIENCE, ['watch']],
    // Plan T18 step 6: a watch's actor-task action gives Actor a task for the watch's owner. Watch names the owner in
    // X-OV-Subject, so the task is the person's (their allowance and list) and Actor records Watch as `via`.
    ['watch', 'actor.task.create', 'openvibe.actor', []],
    // A watch's actor-agent action runs the owner's personal agent (contracts 0.143.0, Actor's actor.agent.run).
    ['watch', 'actor.agent.run', 'openvibe.actor', []],
    // Project delegation (ADR-003 amendment 2026-10-12, contracts 0.153.0): a watch that names a project has its
    // run-job actions start Run jobs for the owner in that project (X-OV-Subject + X-OV-Project). Watch checks the
    // owner's membership when the watch is saved; Run checks it again before every delegated job.
    ['watch', 'run.job.submit', 'openvibe.run', []],
    ['watch', 'network.project.member.read', SELF_AUDIENCE, []],
    ['run', 'network.project.member.read', SELF_AUDIENCE, []],
    // Actor and Media read a person's project role before a project admin's control request (contracts 0.169.0).
    ['actor', 'network.project.member.read', SELF_AUDIENCE, []],
    ['media', 'network.project.member.read', SELF_AUDIENCE, []],
    // Work's agent pillar: "Ask my Actor agent" on a tracked application gives Actor a task for that person (X-OV-Subject).
    ['work', 'actor.task.create', 'openvibe.actor', []],
    // Food's recipes pillar: food.suggest_recipes on OpenVibe.AI for the signed-in person (AI#57).
    ['food', 'ai.run.create', 'openvibe.ai', ['food.*']],
    ['food', 'ai.run.read', 'openvibe.ai', ['food.*']],
    // Plan T13: OpenVibe.Services merges every authority's resource index (ADR-048 section 3): it reads each one's
    // GET /api/v1/resources under that authority's <id>.resource.read, with a token for that authority's audience.
    ['services', 'network.resource.read', SELF_AUDIENCE, []],
    // Phase 2 (contracts 0.129.0-0.134.0): watches, Actor tasks, robots, rooms, OpenRestream's streams and Community's
    // pastes and spaces.
    // Since contracts 0.150.0 the static hosting index is Space's (space.resource.read); Host's is retired.
    ...['media', 'events', 'space', 'watch', 'actor', 'bot', 'chat', 'openre', 'community'].map(id => ['services', `${id}.resource.read`, `openvibe.${id}`, []]),
    // ADR-048 control (plan T13 step 10): Services sends a person's control requests to the authority that owns the
    // resource. Watch is the first to take them (watch.resource.control, contracts 0.165.0; Watch#57).
    ['services', 'watch.resource.control', 'openvibe.watch', []],
    // Events is the second (events.resource.control, contracts 0.168.0): suspend and resume a person's subscription.
    ['services', 'events.resource.control', 'openvibe.events', []],
    // Actor and Media (contracts 0.169.0): stop a task; delete an object (the soft delete). Each acts for the resource's
    // own person or an admin of its project.
    ['services', 'actor.resource.control', 'openvibe.actor', []],
    ['services', 'media.resource.control', 'openvibe.media', []],
    // Space (contracts 0.170.0): delete a site, deploy or domain; Space decides by its own project roles.
    ['services', 'space.resource.control', 'openvibe.space', []],
    // OpenVibe.Zone (contracts 0.173.0, ADR-031 amendment): Services lists its zones and deletes one for a project admin.
    ['services', 'zone.resource.read', 'openvibe.zone', []],
    ['services', 'zone.resource.control', 'openvibe.zone', []],
    // Person-owned resources (contracts 0.176.0, ADR-048 amendment 2026-10-15): Services acts on a person's own robot,
    // room, restream definition or paste for them; each authority checks the owner it holds.
    ['services', 'bot.resource.control', 'openvibe.bot', []],
    ['services', 'chat.resource.control', 'openvibe.chat', []],
    ['services', 'openre.resource.control', 'openvibe.openre', []],
    ['services', 'community.resource.control', 'openvibe.community', []],
    // Zone provisions each zone in Media and manages S3 access keys there for a project admin; it reads project roles here.
    ['zone', 'media.zone.provision', 'openvibe.media', []],
    ['zone', 'media.access_key.manage', 'openvibe.media', []],
    ['zone', 'network.project.member.read', SELF_AUDIENCE, []],
    // Zone sums Media's per-zone rollups (media.usage.recorded) in its usage view: its own Events subscription.
    ['zone', 'events.subscription.manage', 'openvibe.events', []],
    // Plan T14: OpenVibe.Run publishes run.job.* and hands each job to a paired Node through Bot's internal jobs API
    // (POST /api/v1/jobs, /jobs/:id/cancel, GET /jobs/:id, capability bot.job.dispatch, service-to-service only).
    ['run', 'events.event.publish', 'openvibe.events', []],
    ['run', 'bot.job.dispatch', 'openvibe.bot', []],
    // Plan T15: a channel bound to an OpenVibe.Bot robot lets its chat drive it. Live forwards !forward, !say … to Bot's
    // POST /api/v1/robots/:id/commands with X-OV-Subject naming the viewer, so Bot's roles, queue, cooldowns and e-stop
    // judge each one as that person (Live has no robot code of its own since Live's controls were deleted).
    ['live', 'bot.robot.control', 'openvibe.bot', []],
    // Plan T15/T17: a person's OpenVibe.Actor agent pilots their robot. Bot answers it only for the robot's owner
    // (X-OV-Subject) and only where that owner turned on "Let my OpenVibe.Actor agent drive this robot"
    // (robots.agent_control); its gate, limits and e-stop still judge every step.
    ['actor', 'bot.robot.read', 'openvibe.bot', []],
    ['actor', 'bot.robot.control', 'openvibe.bot', []],
    // Plan T14/T17 (contracts 0.166.0): the agent uses a person's own computer (OpenVibe.Node's computer plugin) through
    // Bot, only as that machine's owner (X-OV-Subject) and only where the owner turned on "Let my agent use this
    // computer"; the level the owner set on the machine decides what may happen there.
    ['actor', 'bot.computer.control', 'openvibe.bot', []],
    // Plan T17 (contracts 0.183.0): ask Actor from chat. Actor answers a person's "@actor …" in the room they asked in,
    // through Chat's service API (POST /internal/chat/messages), as "OpenVibe Actor".
    ['actor', 'chat.message.send', 'openvibe.chat', []],
    // Plan T18 step 7 (contracts 0.167.0): a watch's node source checks something on its owner's own network from their
    // machine. Bot lets Watch send only the read-only probe, as the owner, where they turned on "Let my watches check
    // things from this computer".
    ['watch', 'bot.computer.control', 'openvibe.bot', []],
    // Plan T14/T16 (contracts 0.161.0): a person's own machine runs jobs for them. Bot reports the worker offers of the
    // machines connected to it (each user-owned offer names its owner); Run reads them, owner included, to place a
    // person's job only on that person's own machines; Codes starts, follows and cancels a coding job for the signed-in
    // person in their project (X-OV-Subject + X-OV-Project), which Run checks before every job.
    ['bot', 'network.resource.report', SELF_AUDIENCE, []],
    ['run', 'network.registry.read', SELF_AUDIENCE, []],
    ...['run.job.submit', 'run.job.read', 'run.job.stream', 'run.job.cancel'].map((c) => ['codes', c, 'openvibe.run', []]),
    // Plan T16/T17 (contracts 0.162.0): a person's OpenVibe.Actor agent routes coding work to OpenVibe.Codes, which runs
    // it on that person's own machine (X-OV-Subject); Codes shows Actor only the tasks Actor started for that person.
    ...['codes.task.start', 'codes.task.read', 'codes.task.cancel'].map((c) => ['actor', c, 'openvibe.codes', []]),
    // Plan T18/T16: a watch's codes-run action starts a coding task for its owner on Codes (Watch#55).
    ['watch', 'codes.task.start', 'openvibe.codes', []],
    // Plan T2 lane B step 3: Host places and runs per project, so it reads a project's tenancy, placement and quotas.
    // Other services get this row only when they ship a caller of GET /internal/projects/:project_id.
    ['host', 'network.project.read', SELF_AUDIENCE, []],
    // WS-N task 12: ovhost incident / maintenance post to the status page.
    ['host', 'network.status.incident', SELF_AUDIENCE, []],
    // WS-L task 4: OpenVibe.Host's scheduled Tools job proof (openvibe-toolsjob.timer, OpenVibe.Examples
    // scripts/tools-job-proof.js) submits a converter job as `probe` and finds its tools.job.* events.
    ['probe', 'tools.job.create', 'openvibe.tools', []],
    ['probe', 'tools.job.read', 'openvibe.tools', []],
    ['probe', 'events.event.read', 'openvibe.events', []],
    // The production mod lifecycle proof (WS-M task 6, Games apps/server/scripts/modLifecycleProof.ts): install, grant,
    // use and revoke a proof mod through Games' staff API.
    ['probe', 'games.mod.manage', 'openvibe.games', []],
    // Wave 20: the Codes portal relays its release events.
    ['services', 'events.event.publish', 'openvibe.events', []],
    ['ai', 'events.event.publish', 'openvibe.events', []],          // ai.run.* (AI server/events.js, 2026-09-24)
    // Wave 13: Live's AI features run as OpenVibe.AI workflows (AI_SERVICE=remote in live.env).
    // Live runs its own live.* workflows, network.site_copy as the footer-copy fallback, and media.analyze
    // (local-first VOD/clip analysis, roadmap WS-O task 5) (OpenVibe.AI fails closed on a token with no ns).
    ['live', 'ai.run.create', 'openvibe.ai', ['live.*', 'network.site_copy', 'media.analyze']],
    ['live', 'ai.run.read', 'openvibe.ai', ['live.*', 'network.site_copy', 'media.analyze']],
    // A streamer's own provider key for their AI viewers lives in OpenVibe.AI (WS-O task 2): Live stores it there.
    ['live', 'ai.credential.manage', 'openvibe.ai', []],
    // A streamer's daily AI-viewer budget is an AI quota on their attribution (live:user:<id>), which Live sets.
    ['live', 'ai.quota.attribution.manage', 'openvibe.ai', []],
    // Wave 3: producers publish to OpenVibe.Events (their own source only, enforced by Events).
    ...['live', 'media', 'network', 'community', 'billing', 'chat', 'tools', 'games', 'search', 'sources', 'tips'].map(c => [c, 'events.event.publish', 'openvibe.events', []]),
    // Wave 14: Search subscribes to <owner>.index_document.* deliveries.
    ['search', 'events.subscription.manage', 'openvibe.events', []],
    // Plan T9: Search's saved-search notifier pushes one notification per new match through Network
    // (server/network-push.js). It resolves the saved search's owner (a usr_ subject) to Network's user id
    // first, then pushes as app 'search'.
    ['search', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['search', 'network.notifications.push', SELF_AUDIENCE, ['search']],
    ['live', 'events.subscription.manage', 'openvibe.events', []],
    ['live', 'events.event.read', 'openvibe.events', []],
    // VIP gates in products: Chat's subscriber badge, Community's and Blog's members-only content, Live's own checks.
    ['chat', 'vip.entitlement.check', 'openvibe.vip', []],
    ['community', 'vip.resource.policy.evaluate', 'openvibe.vip', []],
    ['blog', 'vip.resource.policy.evaluate', 'openvibe.vip', []],
    // WS-K task 8: Wiki's VIP spaces and pages (Wiki server/integrations/vip.js).
    ['wiki', 'vip.resource.policy.evaluate', 'openvibe.vip', []],
    ['live', 'vip.entitlement.check', 'openvibe.vip', []],
    ['community', 'events.subscription.manage', 'openvibe.events', []],
    ['community', 'events.event.read', 'openvibe.events', []],
    ['community', 'events.event.publish', 'openvibe.events', []],   // community.* events (Community server/events.js, 2026-09-24)
    ['billing', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['chat', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['live', 'identity.subject.resolve', SELF_AUDIENCE, []],
    // Live's avatar picker reports to Network, and Live reads the URL registry and
    // the OpenCoins totals with capabilities of their own (the registry read used identity.subject.resolve, the coin
    // totals network.coins.credit).
    ['live', 'network.avatar.write', SELF_AUDIENCE, []],
    ['live', 'network.registry.read', SELF_AUDIENCE, []],
    ['live', 'network.coins.read', SELF_AUDIENCE, []],
    // Media records each object's owner as a canonical subject (roadmap D01/D20): it resolves the app-local
    // owner ids it is given (X-OV-User-Id) through resolve-batch, in its backfill and its reconcile job.
    ['media', 'identity.subject.resolve', SELF_AUDIENCE, []],
    ['live', 'community.paste.create', 'openvibe.community', []],
    ['live', 'community.paste.write', 'openvibe.community', []],
    ['live', 'community.paste.moderate', 'openvibe.community', []],
    // One canonical channel/owner resolver (roadmap §10.5/§15.10, D20-R1): OpenRestream, Media and Community (Pulse)
    // resolve channels, streams, VODs and clips through Live's /internal/lineage/resolve instead of their own
    // channel mappings.
    ...['openre', 'media', 'community'].map(c => [c, 'live.lineage.resolve', 'openvibe.live', []]),
    // Wave 5 remainder: Live comments on its own entities, publishes stream/VOD items to Pulse, and
    // hides a thread when it takes the entity down.
    ['live', 'community.comment.write', 'openvibe.community', []],
    ['live', 'community.comment.moderate', 'openvibe.community', []],
    ['live', 'community.pulse.write', 'openvibe.community', []],
    // Wave 6: OpenVibe.Chat reads Live's chat context and asks Live for effects; Live bridges its remaining
    // chat writers to Chat and reads presence. (The read mirror back to Live was retired 2026-10-05: see REVOKED_GRANTS.)
    ['chat', 'live.chat_context.read', 'openvibe.live', []],
    ['chat', 'live.chat_effects.write', 'openvibe.live', []],
    // Chat consumes live.release.deployed (the deploy card, register C-84) and network.module.updated
    // (its chat.preferences cache) through its own Events subscriptions, created at Chat's boot.
    ['chat', 'events.subscription.manage', 'openvibe.events', []],
    // Platform blocks (WS-E task 5): Chat (DMs, mentions) and Community (replies) read who blocked whom;
    // both also follow network.block.changed through their own Events subscriptions.
    ['chat', 'network.blocks.read', SELF_AUDIENCE, []],
    ['community', 'network.blocks.read', SELF_AUDIENCE, []],
    ['live', 'chat.live_bridge.write', 'openvibe.chat', []],
    ['live', 'chat.presence.read', 'openvibe.chat', []],
    // Plan T3: Live reads a channel's moderation settings, its moderators and emote count from Chat.
    ['live', 'chat.moderation.read', 'openvibe.chat', []],
    ['live', 'chat.message.send', 'openvibe.chat', []],
    // Plan T3 J2/J4b: Live writes through Chat's typed internal ingress (events, moderation, cache hints)
    // and reads them through Chat's internal read API, in place of its mirrored copy (Chat docs/chat-ingress.md).
    ['live', 'chat.event.publish', 'openvibe.chat', []],
    ['live', 'chat.moderation.write', 'openvibe.chat', []],
    ['live', 'chat.cache.invalidate', 'openvibe.chat', []],
    ['live', 'chat.stats.read', 'openvibe.chat', []],
    ['live', 'chat.messages.read', 'openvibe.chat', []],
    ['live', 'chat.analysis.read', 'openvibe.chat', []],
    ['live', 'chat.moderation.queue.read', 'openvibe.chat', []],
    ['live', 'chat.sounds.read', 'openvibe.chat', []],
    ['live', 'chat.sounds.write', 'openvibe.chat', []],
    // Wave 8: Live as a Billing client (used only with BILLING_AUTHORITY=billing). Never cashout.manage
    // or ledger.admin: approving payouts is a separately controlled capability (ADR-012 rule 10).
    ...['billing.intent.create', 'billing.transfer.create', 'billing.balance.read', 'billing.cashout.request',
        'billing.subscription.manage', 'billing.entitlement.check'].map(c => ['live', c, 'openvibe.billing', []]),
    // Tools platform S9: products call the Tools run API (the kiosk's page titles, Chat's audio conversion,
    // Community's save-as-paste) with their own token, on the service tier instead of the anonymous one.
    ...['live', 'chat', 'community'].flatMap(c => ['tools.tool.run', 'tools.job.read'].map(cap => [c, cap, 'openvibe.tools', []])),
    // Tools indexes its own tool pages in Search through the owner API (owner tools only).
    ['tools', 'search.document.write', 'openvibe.search', []],
    // Plan T5 step 7: Tools posts one usage reading per ended tool job to Billing (POST /api/v1/usage).
    ['tools', 'billing.usage.record', 'openvibe.billing', []],
    // Plan T5 step 14: Network's own usage producers — AI (per model run), Events (per delivered event)
    // and Media (per stored object) post their platform.usage-sample@1 readings to Billing
    // (POST /api/v1/usage) with their own token. Recording usage only: none of them holds a money
    // capability (billing.ledger.admin / billing.cashout.manage).
    ['ai', 'billing.usage.record', 'openvibe.billing', []],
    ['events', 'billing.usage.record', 'openvibe.billing', []],
    ['media', 'billing.usage.record', 'openvibe.billing', []],
    // The same for Space (gb-month of a Network project's deploy bytes, Space#43) and Watch (one reading per completed
    // check, Watch#54). Recording usage only.
    ['space', 'billing.usage.record', 'openvibe.billing', []],
    ['watch', 'billing.usage.record', 'openvibe.billing', []],
    // Project secrets (ADR-056): Actor signs a task's webhook deliveries with the project secret its secret_ref names,
    // when the project granted that secret to actor for sign. The capability is the door; each secret's grant decides.
    ['actor', 'network.secret.use', SELF_AUDIENCE, []],
    // Watch reveals a source credential to its source's origin, and signs a webhook action, with a project secret its
    // watch names (Contracts 0.179.0); each secret's project grant decides.
    ['watch', 'network.secret.use', SELF_AUDIENCE, []],
    // AI reveals a project's own provider key to that provider's origin for one run of an app that names it on
    // /v1/chat/completions (x_openvibe.provider, AI#74); each secret's project grant decides.
    ['ai', 'network.secret.use', SELF_AUDIENCE, []],
];

// Grants withdrawn by decision; applied at every boot so an old default can't come back.
const REVOKED_GRANTS = [
    ['live', 'network.coins.transfer', SELF_AUDIENCE],
    // The Live read mirror is retired (2026-10-05): Chat #25 removed the sender, Live the receiver.
    ['chat', 'live.chat_mirror.write', 'openvibe.live'],
    // The developer portal moved from Codes to Services (contracts 0.113.0): Codes owns no resources and publishes no
    // event any more; Services publishes the services.* events and reads its own resources in process.
    ['services', 'codes.resource.read', 'openvibe.codes'],
    ['codes', 'events.event.publish', 'openvibe.events'],
    // The forum returned to Community (owner decision 2026-10-08, contracts 0.118.0): Space keeps only its sign-in
    // client. Its forum grants go, and Network stops waiting for its account export part and deletion confirmation
    // (the forum's account data is Community's).
    ['space', 'identity.subject.resolve', SELF_AUDIENCE],
    ['space', 'media.object.upload', 'openvibe.media'],
    ['space', 'vip.resource.policy.evaluate', 'openvibe.vip'],
    ['space', 'events.subscription.manage', 'openvibe.events'],
    ['space', 'events.event.read', 'openvibe.events'],
    ['space', 'network.blocks.read', SELF_AUDIENCE],
    ['space', 'network.account.export.contribute', SELF_AUDIENCE],
    ['space', 'network.account.deletion.confirm', SELF_AUDIENCE],
    // The static hosting engine left Host (T20, Host#84, contracts 0.150.0): its Media objects and Services' fan-out to
    // its resource index go. Space serves the engine.
    ['host', 'media.object.upload', 'openvibe.media'],
    ['host', 'media.object.read', 'openvibe.media'],
    ['host', 'media.object.list', 'openvibe.media'],
    ['host', 'media.object.delete', 'openvibe.media'],
    ['services', 'host.resource.read', 'openvibe.host'],
];

// Default grants whose namespaces changed: a row still exactly as the old default seeded it is moved to
// the new list at boot, in this order (a row someone edited is left alone). Live's write grant lost
// chat.preferences when the namespace moved to Chat (Wave 6), then chat.tts_defaults (contracts 0.41.0).
// Default grants that REVOKED_GRANTS once revoked and that are defaults again. The seed below inserts with ON CONFLICT
// DO NOTHING, so a revoked row would otherwise stay revoked; only these named rows are restored (a grant a person revoked
// through grants-admin is never touched). Each entry must also be in DEFAULT_GRANTS and no longer in REVOKED_GRANTS.
const RESTORED_GRANTS = [
    // T20 step 2 (2026-10-12): Space publishes its static hosting events again (revoked when the forum left, 10-08).
    ['space', 'events.event.publish', 'openvibe.events'],
];

const CHANGED_DEFAULT_NAMESPACES = [
    ['live', 'network.modules.write', SELF_AUDIENCE, ['chat.preferences', 'chat.tts_defaults', 'live.profile'], ['chat.tts_defaults', 'live.profile']],
    ['live', 'network.modules.write', SELF_AUDIENCE, ['chat.tts_defaults', 'live.profile'], ['live.profile', 'live.stats']],
    ['live', 'network.modules.read', SELF_AUDIENCE, ['chat.preferences', 'chat.tts_defaults', 'live.profile'], ['live.profile', 'live.stats']],
    // contracts 0.56.0: live.loyalty (WS-K task 9).
    ['live', 'network.modules.write', SELF_AUDIENCE, ['live.profile', 'live.stats'], ['live.profile', 'live.stats', 'live.loyalty']],
    ['live', 'network.modules.read', SELF_AUDIENCE, ['live.profile', 'live.stats'], ['live.profile', 'live.stats', 'live.loyalty']],
    ['chat', 'network.modules.read', SELF_AUDIENCE, ['chat.preferences'], CHAT_NAMESPACES],
    ['chat', 'network.modules.write', SELF_AUDIENCE, ['chat.preferences'], CHAT_NAMESPACES],
    // Tools' job results under each developer project's child namespace (WS-L task 5, Media namespaces WS-G task 2).
    ['tools', 'media.object.upload', 'openvibe.media', ['tools'], ['tools', 'tools.*']],
    ['tools', 'media.object.read', 'openvibe.media', ['tools'], ['tools', 'tools.*']],
    // Live runs media.analyze on OpenVibe.AI (WS-O task 5).
    ['live', 'ai.run.create', 'openvibe.ai', ['live.*', 'network.site_copy'], ['live.*', 'network.site_copy', 'media.analyze']],
    ['live', 'ai.run.read', 'openvibe.ai', ['live.*', 'network.site_copy'], ['live.*', 'network.site_copy', 'media.analyze']],
];

async function ensureSchema(db) {
    // adr-012 rule 5: loyalty is not transferable between people, so nobody holds the transfer grant.
    for (const [client, cap, aud] of REVOKED_GRANTS) {
        await db.prepare("UPDATE principal_grants SET revoked_at = ov_now() WHERE client_id = ? AND capability = ? AND audience = ? AND revoked_at IS NULL").run(client, cap, aud);
    }
    for (const [client, cap, aud] of RESTORED_GRANTS) {
        await db.prepare("UPDATE principal_grants SET revoked_at = NULL WHERE client_id = ? AND capability = ? AND audience = ? AND granted_by = 'default' AND revoked_at IS NOT NULL").run(client, cap, aud);
    }
    for (const [client, cap, aud, was, now] of CHANGED_DEFAULT_NAMESPACES) {
        await db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = ? AND capability = ? AND audience = ? AND granted_by = 'default' AND namespaces = ?")
            .run(JSON.stringify(now), client, cap, aud, JSON.stringify(was));
    }
    const seed = db.prepare("INSERT INTO principal_grants (client_id, capability, audience, namespaces, granted_by) VALUES (?, ?, ?, ?, 'default') ON CONFLICT DO NOTHING");
    // A default grant that later gained namespaces fills them in on a row still seeded without any
    // (INSERT OR IGNORE alone would leave it at []); a row someone edited is left alone.
    const fillNs = db.prepare("UPDATE principal_grants SET namespaces = ? WHERE client_id = ? AND capability = ? AND audience = ? AND granted_by = 'default' AND namespaces = '[]'");
    for (const [client, cap, aud, ns] of DEFAULT_GRANTS) {
        if (!await db.prepare('SELECT 1 FROM oauth_clients WHERE client_id = ?').get(client)) continue;
        await seed.run(client, cap, aud, JSON.stringify(ns));
        if (ns.length) await fillNs.run(JSON.stringify(ns), client, cap, aud);
    }
    // Owner changes (expiry, reason, who revoked) and their audit trail (WS-D task 3).
    await require('./grants-admin').ensureSchema(db);
}

async function grantsFor(db, clientId, audience) {
    // An expired grant stops counting at once; grants-admin.expireDue() records the expiry.
    return (await db.prepare('SELECT capability, namespaces FROM principal_grants WHERE client_id = ? AND audience = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ov_now()) ORDER BY capability')
        .all(clientId, audience)).map(r => ({ capability: r.capability, namespaces: JSON.parse(r.namespaces || '[]') }));
}

function sameSecret(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * grant_type=client_credentials. Returns { status, body } (OAuth error shapes on failure).
 * `scope` (space-separated capability ids) narrows the token; omitted = every grant for the audience.
 */
async function issueToken(db, { clientId, clientSecret, audience, scope, privateKey, issuer, agent, settings, ctx }) {
    const client = await db.prepare('SELECT client_id, client_secret FROM oauth_clients WHERE client_id = ?').get(String(clientId || ''));
    if (!client || !sameSecret(client.client_secret, clientSecret)) return { status: 401, body: { error: 'invalid_client', error_description: 'Invalid client credentials' } };
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(client.client_id)) return { status: 400, body: { error: 'unauthorized_client', error_description: 'client id is not a service principal' } };
    // The service hosts an agent (plan T2 WS-Z2 slice 8): the agent's token, bounded by this service's own grants.
    if (agent !== undefined) {
        return await require('../developer/agent-tokens').mint(db, { agentId: agent, host: { kind: 'service', clientId: client.client_id }, audience, scope, privateKey, issuer,
            settings: settings || require('../developer/policy').settings(), ctx });
    }
    const aud = String(audience || '').trim();
    if (!aud) return { status: 400, body: { error: 'invalid_request', error_description: 'audience is required' } };
    const grants = await grantsFor(db, client.client_id, aud);
    const wanted = scope ? String(scope).split(/\s+/).filter(Boolean) : null;
    const chosen = wanted ? grants.filter(g => wanted.includes(g.capability)) : grants;
    if (wanted && wanted.some(w => !chosen.find(g => g.capability === w))) {
        return { status: 400, body: { error: 'invalid_scope', error_description: `not granted: ${wanted.filter(w => !chosen.find(g => g.capability === w)).join(' ')}` } };
    }
    if (!chosen.length) return { status: 400, body: { error: 'invalid_scope', error_description: `no grants for audience ${aud}` } };
    const now = Math.floor(Date.now() / 1000);
    const claims = {
        iss: issuer, sub: `svc:${client.client_id}`, actor_type: 'service', aud: [aud],
        cap: chosen.map(g => g.capability),
        ns: [...new Set(chosen.flatMap(g => g.namespaces))],
        iat: now, exp: now + TOKEN_TTL_S, jti: `tok_${crypto.randomBytes(12).toString('hex')}`,
    };
    assertValid('identity.service-token-claims@1', claims);
    return { status: 200, body: { access_token: serviceAuth.signServiceToken(claims, privateKey), token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: claims.cap.join(' ') } };
}

/** Audit hook for requireCapability: one counter row per (principal, route, auth, outcome). */
function recordDecision(db) {
    const up = db.prepare(`INSERT INTO principal_usage (principal, route, capability, auth, allowed, code, count) VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(principal, route, auth, allowed, code) DO UPDATE SET count = principal_usage.count + 1, last_at = ov_now()`);
    return async ({ req, capability, principal, allowed, code }) => {
        const bearer = String(req.headers.authorization || '').startsWith('Bearer ');
        const auth = bearer ? 'service-token' : 'none';
        const who = principal ? principal.sub : 'unknown';
        try { await up.run(who, `${req.method} ${req.baseUrl || ''}${req.route ? req.route.path : req.path}`, capability, auth, allowed ? 1 : 0, code || ''); } catch { /* best effort */ }
    };
}

/**
 * Guard for a Network internal route: a service token holding `capability`, nothing else. `ownApp(req)`
 * returns the app id the request acts for; a service token may only act for its own app (svc:live ->
 * app_id 'live').
 */
function guard(capability, { ownApp, namespace } = {}) {
    if (!capabilities.get(capability)) throw new Error(`unknown capability ${capability}`);
    let check = null;
    let record = null;
    return function principalGuard(req, res, next) {
        // The audit row for this request is written before its response leaves: the contracts' decision hooks
        // are synchronous while the insert is async, so the first res.end waits for the request's audits.
        const audits = [];
        req._ovAudits = audits;
        const end = res.end.bind(res);
        let ended = false;
        res.end = (...args) => {
            if (ended) return end(...args);
            ended = true;
            Promise.allSettled(audits).then(() => end(...args));
            return res;
        };
        if (!check) {
            record = recordDecision(req.app.locals.db);
            check = serviceAuth.requireCapability(capability, {
                getPublicKey: (r) => r.app.locals.publicKey,
                issuer: req.app.locals.config.jwt && req.app.locals.config.jwt.issuer,
                audience: SELF_AUDIENCE,
                namespace,
                // Denials are final here; an allow is recorded below, after the ownership check.
                onDecision: (d) => {
                    if (d.allowed) return;
                    const list = d.req && d.req._ovAudits;
                    if (list) list.push(record(d));
                    require('../observability').principalDenied(d);
                },
            });
        }
        check(req, res, () => {
            const principal = req.principal;
            // Agent tokens (plan T2 WS-Z2 slice 8) act at the owning services; no Network route takes one yet.
            if (principal && /^agent:/.test(String(principal.sub))) {
                audits.push(record({ req, capability, principal, allowed: false, code: 'capability.denied' }));
                require('../observability').principalDenied({ req, code: 'capability.denied' });
                return http.sendProblem(res, 403, 'capability.denied', { detail: 'agent tokens are not accepted here', ctx: req.ov });
            }
            // Developer sandbox tokens (env: sandbox) are refused unless Network opted in as an audience
            // (DEV_SANDBOX_AUDIENCES); the signature was verified by check() above.
            if (principal) {
                const devPolicy = require('../developer/policy');
                const claims = devPolicy.unverifiedClaims(String(req.headers.authorization || '').slice(7).trim());
                const env = devPolicy.environmentDecision(claims, { acceptSandbox: devPolicy.settings(req.app.locals.config).sandboxAudiences.has(SELF_AUDIENCE) });
                if (!env.ok) {
                    audits.push(record({ req, capability, principal, allowed: false, code: env.code }));
                    require('../observability').principalDenied({ req, code: env.code });
                    return http.sendProblem(res, 401, env.code, { detail: env.reason, ctx: req.ov });
                }
            }
            if (ownApp && principal) {
                const app = ownApp(req);
                const self = String(principal.sub).replace(/^svc:/, '');
                if (app !== undefined && app !== self) {
                    audits.push(record({ req, capability, principal, allowed: false, code: 'capability.owner_denied' }));
                    require('../observability').principalDenied({ req, code: 'capability.owner_denied' });
                    return http.sendProblem(res, 403, 'capability.owner_denied', { detail: `${principal.sub} may only act for app_id '${self}'` });
                }
            }
            audits.push(record({ req, capability, principal, allowed: true, code: null }));
            next();
        });
    };
}

/**
 * A guard that accepts any one of `caps`. The bearer's (unverified) claims only pick which capability's guard runs;
 * that guard then verifies the token and the capability in full, exactly as guard() alone does, and audits it.
 */
function guardAny(caps, opts) {
    const guards = caps.map((c) => [c, guard(c, opts)]);
    return function anyGuard(req, res, next) {
        const claims = require('../developer/policy').unverifiedClaims(String(req.headers.authorization || '').slice(7).trim());
        const held = claims && Array.isArray(claims.cap) ? claims.cap : [];
        const pick = guards.find(([c]) => capabilities.grants(held, c)) || guards[0];
        return pick[1](req, res, next);
    };
}

module.exports = { ensureSchema, issueToken, guard, guardAny, grantsFor, recordDecision, DEFAULT_GRANTS, REVOKED_GRANTS, RESTORED_GRANTS, TOKEN_TTL_S, SELF_AUDIENCE };
