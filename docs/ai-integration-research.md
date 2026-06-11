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

## Recommended architecture

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
3. **"Sign in with Claude subscription" as a later tier** via
   the Agent SDK, once the 2026-06-15 credit policy proves
   stable.
4. **No Gemini CLI OAuth piggybacking, no Copilot CLI shelling.**

Per user segment:

| Segment | Path |
| --- | --- |
| Has a provider API key | BYOK direct (best quality, pay-per-use, strongest cloud privacy) |
| Claude Pro/Max subscriber | Agent SDK tier (zero marginal cost up to the monthly credit) |
| Privacy-absolutist / offline | Ollama / LM Studio local tier |
| Wants one key, many models | Generic endpoint pointed at OpenRouter |

## Open questions for implementation time

- Measured quality (not throughput) of 7B-32B local models on
  PR-diff summarization; minimum model size for trustworthy
  "is this risky" output.
- Whether OpenAI (ChatGPT/Codex) or GitHub ship a sanctioned
  subscription-auth path analogous to Anthropic's Agent SDK
  credit, or whether Anthropic stays unique.
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
