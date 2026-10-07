# Decisions API with the existing ChatGPT subscription

## Question and scope

Can our existing Pi Codex OAuth credentials or a fresh direct-sharing OAuth grant call OpenAI Decisions API without an API key?

The user narrowed LPT-614 to practical access research on 7 October 2026. This run does not implement a reactive computer-use policy or change Pi, its login, or the computer-use extension.

## Result

**The current Codex OAuth token did not authorize `/v1/decisions`.** Both public Decisions requests returned HTTP 401 with `A valid API key is required.` They did not return the documented `subscription_sharing_route_not_supported` error.

**The subscription did accept `gpt-6-luna` through the existing Codex Responses route.** A plain text request completed. A separate strict JSON-schema classification completed with `{"choice":"damaged"}` and reported model `gpt-6-luna`.

That is ordinary Responses generation, not Decisions API. Sending Decisions `questions` to that working route returned HTTP 400 with `Unsupported parameter: questions`. There were no Decisions probabilities or confidence values.

The token's locally decoded claims listed `openid`, `profile`, `email`, and `offline_access`, but not `chatgpt.tokens.use.direct` or `resource.invoke`. Claims were decoded for diagnostics, not signature-verified. A successful Codex control request confirmed that the token worked on its normal route. It does not prove permission for the newer public subscription-sharing flow.

**A fresh direct-sharing OAuth grant also failed on Decisions.** The user approved a separate browser login. Its ID token passed signature, issuer, audience, expiration, and nonce checks. The granted scopes included `chatgpt.tokens.use.direct` and `resource.invoke`. Model discovery and public Responses both succeeded using that new token. Decisions returned HTTP 401, `rejected_by_access_enforcement`, code `no_matching_rule`.

This establishes that neither tested credential path can use Decisions on this account now. It does not establish a permanent restriction for every subscriber. The observed error differs from the documented `subscription_sharing_route_not_supported` error.

## Live requests

Run on 7 October 2026, 07:33–07:34 UTC, from the local WSL host. All requests used the same existing, unexpired Codex access token. No refresh, API key, billing fallback, or automatic retry was used. Inputs were synthetic text only. No screenshot, document, or account content was sent.

| Probe | Route and payload | Result | Full-request time |
| --- | --- | --- | --- |
| Public Decisions | `POST https://api.openai.com/v1/decisions`, `gpt-6-luna`, bounded `choice` | 401; `A valid API key is required.` | 1,223 ms |
| Public model catalog control | `GET https://api.openai.com/v1/models` | 403; missing `api.model.read` | 735 ms |
| Public Responses control | `POST https://api.openai.com/v1/responses`, `gpt-6.1-sol`, `store:false`, `stream:true` | 401; missing `api.responses.write` | 478 ms |
| Codex control | `POST https://chatgpt.com/backend-api/codex/responses`, `gpt-6.1-sol` | 200; `OK`; `response.completed`; 22 total tokens | 2,599 ms |
| Public Decisions with Codex headers | Same Decisions payload plus account ID, `OpenAI-Beta: responses=experimental`, and `originator: pi` | 401; `A valid API key is required.` | 1,457 ms |
| Hypothetical Codex Decisions sibling | `POST https://chatgpt.com/backend-api/codex/decisions`, Decisions payload and Codex headers | 403; HTML Cloudflare challenge, not a Decisions JSON response | 108 ms |
| Luna through Codex Responses | Existing Codex Responses route, `gpt-6-luna`, say `OK` | 200; `OK`; `response.completed`; 22 total tokens | 1,148 ms |
| Decisions questions through Responses | Luna Responses request with top-level `questions` | 400; `Unsupported parameter: questions` | 370 ms |
| Schema classification through Responses | Luna Responses request with strict `text.format` JSON schema; damaged/intact/other enum | 200; `{"choice":"damaged"}`; `response.completed`; response model `gpt-6-luna`; 76 total tokens | 4,918 ms |

These are single samples, not a latency benchmark. HTTP 200 alone was not treated as success: the successful streams contained `response.completed`. The Codex streams omitted Content-Type; the probe also recognizes the SSE body prefix.

The Cloudflare challenge does not prove that the hypothetical Decisions sibling exists, is absent, or rejects subscription access. No challenge bypass or browser-cookie reuse was attempted.

### Request identifiers

Public API request IDs:

- Decisions: `req_54958a21aebe4f00992364671152a3fe`
- Model catalog: `eb7870b0-0237-43e7-9f9f-85ec9987379f`
- Responses: `req_ddbd0a6df3c34e91af369d10872ca931`
- Decisions with Codex headers: `req_dba3f346efd1449baf607169159e5ec9`

The tested Codex responses did not expose `x-request-id`. Their Cloudflare Ray IDs were `a46b381958d1e52e-TXL` (control), `a46b38770a5e1550-TXL` (hypothetical Decisions), `a46b38779b447c0d-TXL` (Luna), `a46b399059a983dd-TXL` (questions), and `a46b39922a28f69f-TXL` (schema).

## Fresh direct-sharing grant

A second run also completed on 7 October 2026. The user signed in through a separate dynamic registration using the documented scope set. Pi's active credentials were not read or changed by this experiment. The probe verified the ID token against OpenAI JWKS before using the access token, and checked the granted scopes before inference.

| Probe | Result | Full-request time |
| --- | --- | --- |
| Direct-sharing OAuth | Identity verified; `chatgpt.tokens.use.direct email offline_access openid profile resource.invoke` granted | Not benchmarked |
| Public model catalog | HTTP 200; listed `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` | Not benchmarked |
| Public Responses control | HTTP 200; `OK`; `response.completed`; response model `gpt-6-astra` | 2,707 ms |
| Public Decisions, `gpt-6-luna`, bounded choice | HTTP 401; `rejected_by_access_enforcement`; `no_matching_rule` | 613 ms |

The catalog also included hidden `gpt-reserve`, `gpt-5.5`, and `codex-auto-review`. The control chose the first visible model because the catalog did not include `gpt-6.1-sol`. The same access token was used for discovery, control, and Decisions.

Exact Decisions response, with Content-Type `text/plain`:

```json
{
  "error": {
    "message": "Unauthorized",
    "type": "rejected_by_access_enforcement",
    "code": "no_matching_rule",
    "param": null
  },
  "status": 401
}
```

Request ID: `req_1b60897cbfff4de78207be84599c8948`. The successful model catalog and Responses control did not expose `x-request-id`. No grant token or user identity is included in this report.

## Reproduce safely

Use [the probe script](../../scripts/probe-decisions-oauth.mjs). It reads the current user's existing `~/.pi/agent/auth.json` and selects only explicitly named cases. It never refreshes credentials or changes the auth store. It refuses an expired token, rejects redirects, applies a 30-second timeout, redacts credentials, and summarizes SSE output.

```bash
node scripts/probe-decisions-oauth.mjs public-decisions codex-control codex-luna-responses
node scripts/probe-decisions-oauth.mjs codex-luna-questions codex-luna-schema
```

These commands make real requests and may consume subscription usage. All nine case names are listed when the script runs without arguments. A failed request is evidence, not a reason to retry blindly.

To repeat the separate direct-sharing registration, run [the login probe](../../scripts/probe-decisions-direct-login.mjs) and open `http://127.0.0.1:1457` yourself. The listener expires after ten minutes. Only the user signs in or approves the grant; the probe does not operate account UI. It verifies the identity, checks the direct-sharing scope, lists models, sends one tiny Responses control and one Decisions choice request. It makes no automatic retries or token refreshes.

```bash
node scripts/probe-decisions-direct-login.mjs
```

Host and issued-client registration metadata are retained with owner-only permissions under `~/.config/pi-agent-computer-use-decisions-probe/registration.json` so later sign-ins reuse the registration. Access, refresh, and ID tokens stay only in process memory; they were discarded when the completed probe exited. This is a research harness, not an adopted production login provider. The grant may remain visible in ChatGPT settings; removing local metadata does not revoke it.

## Official contract checked on 7 October 2026

- [Decisions guide](https://developers.openai.com/api/docs/guides/decisions): dedicated `POST /v1/decisions`, text/image input, typed questions, and API-key examples. `gpt-6-luna` is the documented model. The claimed roughly 10× latency reduction was not measured here.
- [Subscription models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): the public direct-sharing flow uses `POST /v1/responses`, not ChatGPT backend routes.
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery): documents `subscription_sharing_route_not_supported` for unsupported routes. That exact error was not observed with our older Codex token.
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference): the newer grant includes `chatgpt.tokens.use.direct` and `resource.invoke`.
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in): a separate direct-sharing registration can request those permissions. It requires explicit user consent and must stay separate from the active Pi login.

The existing Codex endpoint and header conventions were checked in the installed Pi AI adapter, read-only. No Pi source was changed.
