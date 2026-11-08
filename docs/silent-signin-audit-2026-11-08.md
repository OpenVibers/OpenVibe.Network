# Silent sign-in audit — 2026-11-08 UTC

55 entries from the live Network frame nav, plus the reported openvibe.link. Each entry used a fresh Chrome context with only openvibe.network ov_token/ov_sso cookies from the probe login. A normal Chrome user agent avoids the intentional crawler exclusion; viewport 390×844. No target-site cookies, local storage or pre-granted FedCM permission. CDP Network.setCookieControls explicitly enabled third-party-cookie restrictions and disabled metadata/heuristic exceptions; recorded blocked-cookie reasons confirm enforcement. Each home was observed for five seconds after DOMContentLoaded. Success means a signed-in navbar/auth event. Stored traces strip query strings and cookie values.

Before: **3/56 signed in with third-party cookies blocked**, **46/56 with cookies allowed**. Network, Inventory and Play pass because the latter two remain same-site with Network. The report/ai entry is a separate nav entry on the Report origin.

Browser substitution: serving the proposed Shared navbar plus the Live app and Bot setting to the browser yielded **49/55 nav entries signed in with cookies blocked**. This exercises production OAuth for those entries without deploying the patches. Run, Watch, Homes, Events, Restream and Search still need their backend/config patches; Link was not counted in that substitution pass. Local tests cover the backend changes, including signed-token callbacks for new SDK routers. Guest replays on Live, Community, Chat and Bot each returned home after one quiet round trip with no sign-in form. **No PR has been merged or deployed.**

| Site | Silently before (blocked / allowed) | Cause | PR |
|---|---|---|---|
| https://openvibe.live/ | No / Yes | Live’s own iframe/FedCM check depends on third-party cookies | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenVibe.Live#697](https://github.com/OpenVibers/OpenVibe.Live/pull/697) |
| https://openvibe.community/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.chat/ | No / No | Iframe blocked by frame-src CSP; cookie dependence as well | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.video/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.pics/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.download/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.tools/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.bot/ | No / No | No silentLogin navbar setting | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenVibe.Bot#337](https://github.com/OpenVibers/OpenVibe.Bot/pull/337) |
| https://openvibe.space/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.news/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.tips/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.vip/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.games/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.blog/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.coupons/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.deals/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.trade/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.exchange/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.report/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.report/ai | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.wiki/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.actor/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.media/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.design/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.network/ | Yes / Yes | Passed | — |
| https://openvibe.work/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.domains/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.today/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.host/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.fun/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://open.shoes/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.reviews/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.casino/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.tours/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.meme/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.vision/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.cam/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.services/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.surf/ | No / No | Iframe blocked by frame-src CSP; cookie dependence as well | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.zone/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://connect.openvibe.website/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.help/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.codes/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.quest/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.food/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.run/ | No / No | No browser SSO routes/nav configuration; callback not registered | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenVibe.Run#205](https://github.com/OpenVibers/OpenVibe.Run/pull/205), [OpenVibe.Network#664](https://github.com/OpenVibers/OpenVibe.Network/pull/664) |
| https://openvibe.watch/ | No / No | No silentLogin navbar setting; OAuth route did not request prompt=none or return a silent guest quietly | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenVibe.Watch#240](https://github.com/OpenVibers/OpenVibe.Watch/pull/240) |
| https://openvibe.rent/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.homes/ | No / No | Navbar sends sign-in to Rent, leaving its cookie on another origin; Homes callback not registered | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenVibe.Rent#243](https://github.com/OpenVibers/OpenVibe.Rent/pull/243), [OpenVibe.Network#664](https://github.com/OpenVibers/OpenVibe.Network/pull/664) |
| https://openvibe.events/ | No / No | No browser SSO routes/nav configuration; callback not registered; nginx page fallback rejects auth POSTs | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenVibe.Events#265](https://github.com/OpenVibers/OpenVibe.Events/pull/265), [OpenVibe.Network#664](https://github.com/OpenVibers/OpenVibe.Network/pull/664) |
| https://inventory.openvibe.network/ | Yes / Yes | Passed | — |
| https://play.openvibe.network/ | Yes / Yes | Passed | — |
| https://openre.stream/ | No / No | No silentLogin navbar setting; OAuth route did not request prompt=none or preserve the silent guest return | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenRestream#236](https://github.com/OpenVibers/OpenRestream/pull/236) |
| https://search.openvibe.network/ | No / No | No browser SSO routes/nav configuration; callback not registered | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenVibe.Search#245](https://github.com/OpenVibers/OpenVibe.Search/pull/245), [OpenVibe.Network#664](https://github.com/OpenVibers/OpenVibe.Network/pull/664) |
| https://openvibe.email/ | No / Yes | Shared iframe cannot see Network’s cookie; first-use FedCM is not silent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343) |
| https://openvibe.link/ | No / No | No local web auth/session routes or navbar configuration; link-web OAuth client absent | [OpenVibe.Shared#343](https://github.com/OpenVibers/OpenVibe.Shared/pull/343), [OpenVibe.Network#664](https://github.com/OpenVibers/OpenVibe.Network/pull/664) |

## Rollout after review

All ten PRs remain unmerged for Opus security review. Release and pin Shared #343 after review, apply the Network callback registrations with their corresponding site routes, deploy, and rerun this browser audit. The browser substitutions described above are test evidence, not a production deployment. See each linked PR for tests and current CI.
