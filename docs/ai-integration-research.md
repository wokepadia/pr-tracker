# AI Integration Research (2026-06-11)

Research into how to add an AI mode (PR summaries, review-thread
digests, "what changed and is it risky" analysis over cached data
plus on-demand diffs) without the developer running a centralized
AI backend or handling AI tokens/billing for users.

Findings below were produced by a multi-source research pass with
adversarial verification of each claim against primary sources
(vendor docs, ToS pages, benchmark threads), all checked live on
2026-06-11.

## Constraints and context

- No centralized AI backend, no developer-managed token/billing
  system. Users bring their own access (key, subscription, or
  local model).
- The app is local-first and privacy-first: Tauri desktop, local
  SQLite, GitHub PAT in OS keychain (Stronghold), no server.
- Data available for analysis: PR metadata, review decisions,
  comment/thread bodies, and activity events are fully cached
  locally. Diff content is NOT cached — code analysis requires
  fetching patches on demand from GitHub with the existing PAT.
- Target audience: professional developers/maintainers reviewing
  many PRs, comfortable with API keys and developer tooling.

## Options evaluated

### 1. BYOK (bring your own key) — recommended default

Users paste their own Anthropic/OpenAI/Google/OpenRouter key; the
app calls the provider directly from the client.

- This is the established no-vendor-billing pattern in shipping
  developer tools. Raycast accepts one key each for Anthropic,
  Google, and OpenAI; Obsidian Copilot accepts OpenAI, Anthropic,
  Google, and Cohere keys stored client-side. Raycast BYOK
  explicitly unlocks AI features without a paid subscription,
  with the user bearing API costs at provider rates. (Verified
  3-0 against vendor docs.)
- Privacy differentiator: Cursor and Raycast both route BYOK
  requests through their own servers (Cursor sends the user's
  key to its backend on every request; Raycast proxies "to unify
  the model APIs"). A Tauri app calling providers directly from
  the client has a strictly stronger privacy posture than the
  market leaders. Worth stating explicitly in product copy.
- One integration surface covers nearly everything: a generic
  OpenAI-compatible client (base URL + model name + key) covers
  OpenAI, Google's OpenAI-compat endpoint, OpenRouter, user-run
  LiteLLM proxies, and local servers (Ollama, LM Studio). This
  is exactly how Obsidian Copilot and Continue.dev ship it. The
  practical pattern is one generic OpenAI-format client plus a
  native Anthropic Messages API path.
- Keys belong in Stronghold/OS keychain alongside the GitHub
  PAT — never in SQLite. HTTP calls should go through the Rust
  side (Tauri command or http plugin), not webview fetch, which
  keeps keys out of the webview and sidesteps CORS issues that
  plague Electron-based plugins talking to localhost servers.

### 2. Claude subscription via Agent SDK — sanctioned, add later

- Effective 2026-06-15, Claude Pro/Max/Team/Enterprise plans
  include a monthly Agent SDK credit ($20 Pro, $100 Max 5x,
  $200 Max 20x at full API rates, separate from interactive
  limits). Third-party apps that authenticate with a user's
  Claude subscription through the Agent SDK are an explicitly
  enumerated covered category — so a "sign in with your Claude
  subscription" tier is legitimate. (Verified against Anthropic's
  help center and Claude Code legal docs.)
- Caution: this is the least stable finding. Anthropic banned
  exactly this pattern in February 2026 (OAuth cutoff April 4)
  before reinstating it via the credit system, and the policy
  takes effect days after this research. Legitimacy applies only
  to the Agent SDK auth flow, not raw OAuth token reuse against
  the API. Do not hard-depend on it for the first release; ship
  it as a convenience tier once the policy has held for a while.
- Anthropic is currently the only frontier vendor with a
  sanctioned subscription-auth path for third-party apps.

### 3. Gemini CLI OAuth piggybacking — prohibited, avoid

Google's official Gemini CLI docs (updated 2026-04-10) state that
directly accessing the services behind Gemini CLI's OAuth login
from third-party software violates the terms and is grounds for
account suspension, with documented mass suspensions in early
2026 (including paying Ultra subscribers). For Google models,
support API-key BYOK only (AI Studio / Vertex).

### 4. GitHub Copilot CLI shelling — poor privacy fit, avoid

Prompts sent through Copilot CLI and other non-editor surfaces
are retained server-side by GitHub (~28 days per the Copilot
Trust Center) — unlike editor prompts, which are deleted after
suggestion generation. Shelling out PR diffs and review-thread
bodies would put user data at rest on GitHub's servers, which
undermines the app's privacy-first positioning. Copilot's terms
are also in churn (Product Specific Terms deprecated 2026-03-05
in favor of the GitHub Generative AI Services Terms).

Note: the sanctioned way to reach a user's Copilot subscription
is not the Copilot CLI but OpenCode's formal GitHub partnership
(see option 7) — though the same non-editor retention terms
likely apply to whatever surface the requests go through, so the
privacy caveat should be surfaced to the user either way.

### 5. Local open-weight models (Ollama / LM Studio) — opt-in tier

- Operationally feasible on Apple Silicon. Verified llama.cpp
  benchmarks on M4 Max (40 GPU cores): ~886 t/s prompt
  processing and ~83 t/s generation for a 7B model at Q4_0, so
  an 8-16k-token PR diff prefills in roughly 10-20 seconds and
  generation is interactive. RAM needs (4-bit quantized,
  excluding KV cache): ~8GB for 7B, ~16GB for 13B, ~32GB for
  32B — within typical developer laptops, though 32B on a 32GB
  machine is a floor, not headroom.
- Long-context behavior beyond ~16k is unverified: every claim
  about 32k-100k-token degradation failed verification, leaving
  a genuine evidence gap. Plan to chunk or trim large diffs for
  the local tier rather than assuming big contexts work.
- Output quality for code-diff summarization is unbenchmarked.
  The recommendation rests on industry precedent (Continue.dev
  recommends qwen2.5-coder:7b-class models; Obsidian Copilot
  ships Ollama/LM Studio support), not measured quality. Pick
  concrete recommended models at implementation time and test
  them on real PR data before defaulting to one.
- Setup friction (install Ollama, pull a model, possibly start
  a server) is acceptable for this audience but justifies making
  local models the secondary path rather than the default. A
  native Tauri app calling localhost:11434 from the Rust side
  avoids the CORS friction that browser-context plugins hit.
- Integration is free once the OpenAI-compatible client exists:
  Ollama and LM Studio both expose OpenAI-format endpoints.

### 6. OpenAI Codex CLI / SDK — effectively sanctioned harness

Researched 2026-06-11 as a follow-up (the original pass left
OpenAI subscription auth as an open question).

- The harness is built for embedding. `openai/codex` is
  Apache-2.0; `codex exec` is the official headless mode with
  `--json` (JSONL events), `--output-schema` (final answer
  conforming to a JSON Schema), `--skip-git-repo-check`
  (arbitrary text via stdin, no checkout needed), and
  `--ephemeral` (no session files). There is an official
  TypeScript SDK (`@openai/codex-sdk`) wrapping the CLI and a
  JSON-RPC "App Server" whose docs explicitly invite "deep
  integration inside your own product."
- Subscription auth is publicly embraced, not just tolerated.
  OpenAI's posture is the opposite of Google's and Anthropic's
  OAuth bans: Sam Altman publicly endorsed signing in to
  third-party tools (OpenClaw) with a ChatGPT account, and
  OpenClaw, OpenCode, and OpenHands all ship ChatGPT-subscription
  auth openly with no enforcement against them. Caveat: there is
  no formal policy document analogous to Anthropic's Agent SDK
  credit — the endorsement is practice-based (CEO tweet, tolerated
  ecosystem, harness docs), and direct "can a paid third-party
  app ride subscription auth?" questions to OpenAI staff remain
  unanswered. Anthropic's tolerate→ban→formalize arc shows this
  can flip. The defensible shape is shelling out to the
  user-installed official harness with the user's own login —
  never raw OAuth token reuse against backend endpoints.
- Privacy is the weak point. Consumer ChatGPT plans (Free/Plus/
  Pro) train on content by default, including Codex tasks, unless
  the user opts out via Data Controls; prompts are retained
  server-side under normal ChatGPT retention. For an unconfigured
  user this is arguably worse than Copilot's 28-day retention.
  If this tier ships, the app should detect ChatGPT-auth mode and
  prominently tell users to disable "Improve the model for
  everyone."
- Usage is credit-based under ChatGPT plans (5-hour windows plus
  weekly caps; Plus roughly 15-80 messages per window as of the
  April 2026 repricing, two repricings in 2026 already). When
  exhausted, users can buy credits or fall back to an API key.
- Known rough edges: `--output-schema`/`--json` interactions
  with MCP tools have open bugs; fast release cadence means the
  app should feature-detect flags against the installed version
  and never copy or relocate the user's auth token (a June 2026
  npm supply-chain attack targeted Codex auth tokens).

### 7. OpenCode — strongest harness shape, BYOK-equivalent auth

Researched 2026-06-11. OpenCode (anomalyco/opencode, MIT,
maintained by Anomaly Co.) is the most popular open-source
coding agent and is purpose-built for exactly this kind of
embedding.

- Architecture: client/server. `opencode serve` runs a local
  HTTP server with an OpenAPI 3.1 spec, SSE streaming, and
  structured JSON output with schema validation; the official
  `@opencode-ai/sdk` (JS/TS) spawns or attaches to it.
  `opencode run --format json` is the non-interactive CLI mode.
  A real ecosystem of third-party apps embeds it this way
  (OpenChamber, CodeNomad, OpenWork, Promptfoo provider).
- Auth matrix is its unique value: 75+ providers via API keys,
  plus subscription logins — GitHub Copilot login is formally
  sanctioned via a GitHub partnership (the only unambiguously
  blessed Copilot path; announced 2026-01-16), ChatGPT Plus/Pro
  login works via the Codex OAuth flow (gray, same posture as
  option 6), and Claude Pro/Max login is permanently gone
  (removed in v1.3.0 after an Anthropic legal request; Anthropic
  via OpenCode is API-key only).
- Privacy: inference calls go direct from the user's machine to
  providers; no default phone-home (sharing is manual and can be
  hard-disabled). Its paid "Zen" gateway is optional — fully
  BYOK without it.
- Costs/risks as a dependency: it is a full agent loop (shell,
  file tools, sessions) — surplus capability and a larger
  permission surface for a summarize/classify feature. Release
  cadence is very hot (multiple releases per day at times,
  pre-2.0, no formal API stability guarantee), and the user must
  have it installed and authenticated, so the app inherits
  version skew. For pure API-key usage it buys little over a
  thin direct BYOK client; its real draw is the sanctioned
  Copilot and gray ChatGPT subscription paths, which a homegrown
  client cannot legally replicate.

### 7b. OpenCode as the complete AI layer (follow-up, 2026-06-11)

Deeper look at the server/SDK surface, prompted by the decision
to not build a first-party BYOK layer at all. Verified against
live docs, the checked-in OpenAPI 3.1 spec
(`packages/sdk/openapi.json`, 144 paths), and source.

What the server API covers — everything an AI layer needs:

- Credential management: `PUT /auth/{providerID}` sets API keys
  programmatically (SDK: `auth.set()`), so the app can ship its
  own key-entry UI and push keys into OpenCode; users never run
  `opencode auth login`. Keys land in
  `~/.local/share/opencode/auth.json` — plaintext, mode 0600,
  shared with the user's own opencode install.
- Model picker: `GET /provider` returns all providers with model
  catalogs, per-provider defaults, and which providers are
  authenticated (`connected`).
- Pure-completion prompting: `POST /session/{id}/message`
  accepts per-request `model`, `system` (system-prompt
  override), `tools: { ... }` (disable all tools), and inline
  text parts — so PR diffs + threads go in as text with no repo
  checkout and no agent behavior.
- Structured output: `format: {type: "json_schema", schema,
  retryCount}` returns schema-validated JSON with built-in
  validation retries (API/SDK only; `opencode run --format
  json` does NOT do schema validation).
- Config injection: the SDK's `config` option is delivered via
  the `OPENCODE_CONFIG_CONTENT` env var at spawn — the app can
  define its own locked-down agent (custom system prompt,
  `permission: deny` for everything, cheap `small_model`)
  without writing files or clobbering the user's setup. It is a
  merge, not isolation: the user's global config (plugins, MCP
  servers) still loads underneath.
- Lifecycle: localhost-bound `opencode serve --port N`, health/
  version via `GET /global/health`, SSE event stream, multiple
  clients per server supported. The SDK does NOT bundle the
  binary (it spawns `opencode` from PATH); a Tauri app would
  bundle it as a sidecar or detect/install it. Since the API is
  OpenAPI-specified, a Rust client can be generated and called
  from the Tauri backend directly — no Node sidecar needed.

What the app still builds: binary distribution/detection and
process supervision; version pinning (no stability policy —
15 releases in the three weeks before this research, and a
v1→v2 API route migration in flight; pin the binary+spec pair
and gate on the health-check version); PR-domain prompting,
diff chunking, and summary caching; key-entry form UX; privacy
messaging.

Gotchas for the no-tools use case:

- The default `build` agent is a full coding agent with all
  permissions defaulting to allow. Always pass a dedicated
  agent/system prompt with explicit `deny` (not `ask` — "ask"
  blocks headless flows waiting for a permission reply) plus
  per-request `tools: {}`.
- Session title generation makes a surprise side-call via
  `small_model`; pass `title` at session create or pin
  `small_model` to something cheap/local.
- Root sessions in a dedicated empty scratch directory so
  AGENTS.md / project instructions from user repos don't leak
  into prompts; consider `snapshot: false`.
- Prompt text (PR diffs, comments) persists in OpenCode's local
  session storage, and keys live in its plaintext auth.json —
  both outside the app's Stronghold story; the privacy posture
  is "user's existing opencode trust domain," slightly weaker
  than direct-to-provider with keys in the OS keychain.

## Recommended architecture

Direction update (2026-06-11): the developer does not want to
build or maintain a first-party BYOK/provider layer. That
leaves two viable shapes, both keeping a single "analysis
provider" interface in front of the rest of the app:

- **OpenCode as the complete AI backend** (section 7b): spawn a
  private `opencode serve` with injected locked-down config and
  delegate auth, providers, models, inference, and structured
  output to it. Buys the whole 75+ provider matrix, local
  models, and the sanctioned Copilot / gray ChatGPT subscription
  paths for free; costs a fast-moving binary dependency,
  install/version management, and a slightly weaker privacy
  story (plaintext auth.json, prompts persisted in OpenCode's
  session storage).
- **In-process provider library** (e.g. Vercel AI SDK — the same
  library OpenCode itself builds on): not building a BYOK layer
  by hand, but linking one. No binary dependency, direct
  client-to-provider calls, keys stay in Stronghold; the app
  still owns key-entry UI and model lists, and gets no
  subscription paths.

The original from-scratch recommendation below is retained for
reference; its tiering still applies whichever provider
substrate is chosen.

A thin provider-abstraction layer in its own package, with the
reviewer-workflow/UI layers consuming a single "analysis
provider" interface:

1. **BYOK as the default tier.** Native Anthropic Messages API
   client plus a generic OpenAI-compatible client (configurable
   base URL + model + key). Direct client-to-provider calls from
   the Rust side; keys in Stronghold next to the GitHub PAT.
2. **Local models via the same OpenAI-compatible client.**
   Ollama/LM Studio as a privacy-maximal opt-in, with diff
   chunking for large PRs and a curated default model picked
   after hands-on quality testing.
3. **A "subscription harness" tier as a later phase**, behind
   the same provider interface: detect locally installed
   harnesses and let subscribers use what they already pay for —
   Claude Agent SDK (Claude Pro/Max; sanctioned via the
   2026-06-15 credit once it proves stable), `codex exec` /
   Codex SDK (ChatGPT Plus/Pro; effectively sanctioned but
   practice-based — pair with a training-opt-out warning), and
   optionally OpenCode attach (Copilot subscribers; formally
   sanctioned partnership). Each is a small adapter producing
   the same structured output as the BYOK clients.
4. **No Gemini CLI OAuth piggybacking, no direct Copilot CLI
   shelling, no raw OAuth token reuse against any provider's
   backend.** Subscription access only through each vendor's
   official harness with the user's own login.

Per user segment:

| Segment | Path |
| --- | --- |
| Has a provider API key | BYOK direct (best quality, pay-per-use, strongest cloud privacy) |
| Claude Pro/Max subscriber | Agent SDK tier (zero marginal cost up to the monthly credit) |
| ChatGPT Plus/Pro subscriber | Codex harness tier (credit-capped; warn about training default) |
| Copilot subscriber | OpenCode attach (formally sanctioned; non-editor retention applies) |
| Privacy-absolutist / offline | Ollama / LM Studio local tier |
| Wants one key, many models | Generic endpoint pointed at OpenRouter |

## Open questions for implementation time

- Measured quality (not throughput) of 7B-32B local models on
  PR-diff summarization; minimum model size for trustworthy
  "is this risky" output.
- Whether OpenAI formalizes its practice-based endorsement of
  third-party subscription auth into a written policy (and
  whether it survives a pricing/policy flip like Anthropic's
  Feb-June 2026 arc).
- Retention terms for Copilot requests made through OpenCode's
  sanctioned partnership — assumed to follow the non-editor
  (~28-day) rules, not verified.
- Real long-context (32k+) prefill latency on mainstream
  Apple Silicon (M2/M3 Pro, 16-36GB) — determines how aggressive
  diff chunking must be for the local tier.
- How far the $20/month Pro Agent SDK credit stretches for a
  reviewer processing many PRs per day.

## Key sources

- Raycast BYOK manual: https://manual.raycast.com/ai/bring-your-own-keys
- Cursor API-keys doc (BYOK proxying): https://cursor.com/help/models-and-usage/api-keys
- Obsidian Copilot settings (OpenAI-compat pattern): https://www.obsidiancopilot.com/en/docs/settings
- Continue.dev Ollama guide (model/RAM guidance): https://docs.continue.dev/guides/ollama-guide
- Anthropic Agent SDK subscription credit: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Claude Code legal & compliance: https://code.claude.com/docs/en/legal-and-compliance
- Gemini CLI ToS/privacy (OAuth prohibition): https://geminicli.com/docs/resources/tos-privacy/
- Copilot product terms (CLI prompt retention): https://github.com/customer-terms/github-copilot-product-specific-terms
- llama.cpp Apple Silicon benchmarks: https://github.com/ggml-org/llama.cpp/discussions/4167
- Codex non-interactive mode (`codex exec`): https://developers.openai.com/codex/noninteractive
- Codex TypeScript SDK: https://developers.openai.com/codex/sdk
- Codex auth modes and recommendation: https://developers.openai.com/codex/auth
- Codex pricing/limits under ChatGPT plans: https://developers.openai.com/codex/pricing
- Altman endorsement of subscription auth in OpenClaw: https://x.com/sama/status/2050357911915028689
- OpenAI data-use defaults (consumer training opt-out): https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance
- OpenCode server mode: https://opencode.ai/docs/server/
- OpenCode SDK: https://opencode.ai/docs/sdk/
- OpenCode providers/auth: https://opencode.ai/docs/providers/
- GitHub Copilot × OpenCode partnership: https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/
- OpenCode removal of Anthropic OAuth ("anthropic legal requests"): https://github.com/anomalyco/opencode/pull/18186
