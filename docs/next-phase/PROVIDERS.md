# Dynamic providers: design contract

Status: proposed implementation contract, baseline `e1b3c66`, 2026-10-29.
PRV-101 freezes executable schemas and interfaces before dependent agents begin.
Decisions below are requirements; deviations need a concrete decision record and chief
review. Do not leave competing implementations to settle precedence accidentally.

## 1. Configuration and trust

Use a versioned private user file under the existing Matrix home abstraction:
`${MATRIX_HOME}/providers.json`, with the existing default Matrix home when unset.
Do not auto-load provider configuration from the repository, model output or a remote
catalog. No executable plugins, shell expansion, credential values or dynamic imports.

Proposed schema example (placeholder host and model, not a working service):

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "lab",
      "name": "My inference server",
      "transport": "chat-completions",
      "baseUrl": "https://inference.example/v1",
      "auth": { "type": "bearer", "env": "LAB_API_KEY" },
      "defaultModel": "vendor/Model-X:latest",
      "request": {
        "tokenLimitField": "max_tokens",
        "includeUsage": false
      },
      "models": [
        {
          "id": "vendor/Model-X:latest",
          "name": "Model X",
          "contextWindow": null,
          "pricing": null,
          "capabilities": { "tools": "unknown" }
        }
      ]
    }
  ]
}
```

Support bearer auth with a validated environment-variable name and explicit
`{ "type": "none" }` for servers without authentication. Missing required keys fail
before network activity; never borrow another provider's key. No raw-key CLI option.
Other authentication schemes and arbitrary headers are follow-on adapter work.

Provider IDs are stable lowercase ASCII slugs, unique and at most 64 characters.
Reserve `local`, `openrouter` and `ollama` for built-ins; custom profiles cannot shadow
them. Model IDs are exact, case-sensitive wire values, at most 512 characters; preserve
slashes, colons and case. Reject empty IDs, control characters and surrounding whitespace
with an actionable error. Escape all remote display text for terminal rendering.

Initial ceilings: configuration 1 MiB, 64 custom profiles, 256 configured models per
profile. Reject unknown schema versions, unknown fields, duplicate IDs, invalid enums
and nonfinite/negative numeric metadata. Validate before replacing any existing file.
Use private directories/files, bounded reads, same-directory atomic replacement and
safe path handling. Reject symlink/nonregular configuration targets. A concurrent
writer must fail or serialize without losing another edit. PRV-101 must prove a bounded
writer protocol; abandoned lock recovery must never rely on PID age alone. Read-only
loading should not require a writer lock. A failed mutation leaves valid prior bytes.

Provide add/list/show/remove commands, with removal explicit by ID. Existing profile
changes use an explicit replace operation with an expected prior configuration digest;
never silently overwrite on duplicate add. User can edit the validated JSON file too.
Mutating configuration never changes the target of an already running request.

## 2. Identity, precedence and the catalog

The primary identity is `(providerId, exactWireModelId)`, never model ID alone. Keep
built-in aliases for legacy callers through a compatibility resolver. New execution
code consumes one resolved immutable target:

- Provider ID/name, transport and normalized base URL.
- Exact wire model ID and display metadata.
- Authentication reference, never key material in a serializable descriptor.
- Validated request options, declared capabilities and matching observed probe evidence.
- A canonical nonsecret configuration digest used for cache/session binding.

A credential is resolved privately once per run, used only by that run's transport,
and never attached to events, errors or the serializable target. Freeze endpoint,
authentication selection and request options for the whole tool loop and every retry.

Selection precedence is explicit:

| Invocation                                         | Resolution                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `--provider lab --model 'a/B:tag'`                 | Exact ID on profile lab, even if absent from any catalog                 |
| `--provider lab`                                   | Profile's explicitly configured defaultModel, otherwise actionable error |
| No provider, existing `--model` alias              | Preserve existing built-in/legacy selection behavior                     |
| No provider or model                               | Preserve the current Local Forge default                                 |
| Explicit unknown provider or unsupported transport | Error; no fallback                                                       |
| Explicit profile and global endpoint/key overrides | Profile wins; unrelated globals are ignored                              |

Explicit built-in selection also binds to its own endpoint/auth policy. OpenRouter
must not be redirected by unrelated `MATRIX_API_BASE` or `OPENAI_BASE_URL` when selected
explicitly. Built-in Ollama may use its dedicated documented host/key settings. Keep
legacy global override behavior only in the no-explicit-provider compatibility path,
with characterization tests. Do not fix unrelated compatibility quirks silently.

Expose one catalog snapshot to CLI, UI, doctor and evaluation. Include built-ins,
manually configured models and bounded discovered entries. A model's availability is
computed from its own profile, not a global `hasKey` boolean. Show disabled/missing-key
states honestly; distinguish unknown cost from zero/free. Built-in Local Forge stays
usable if custom configuration is invalid, with a visible diagnostic; explicit use of
invalid custom configuration must fail. Do not silently treat corruption as an empty file.

## 3. Endpoint and transport contract

`baseUrl` is the API directory, e.g. `https://host.example/team/v1`. Preserve custom
path prefixes; append `/chat/completions` or `/models` exactly once. Named profiles
reject a full completions endpoint with a corrective message. Legacy full-endpoint
overrides continue through their compatibility path.

Parse with the URL API. Allow HTTPS and HTTP on literal loopback/localhost for local
servers. Other HTTP targets require explicit `allowInsecureHttp: true` in the user
profile and a visible configuration warning. Local-network servers are supported;
this setting is not a sandbox network policy. Reject URL userinfo, query strings,
fragments and unsupported schemes. Do not classify a hostname as loopback by a
substring match. Never print raw invalid input that could contain a credential.

Requests must reject redirects; credentials cannot follow 3xx responses to another
origin. Discovery cannot rewrite endpoint/auth fields. Environment references and
returned model strings are data, never commands or instructions.

Reuse the existing streaming parser, cancellation and bounded retry/deadline logic.
Transport selection should not duplicate the parser or invent alternate terminal
success predicates. Keep public compatibility exports while migrating internal callers
from string model IDs to resolved targets. No request may re-resolve global environment
variables mid-run.

For custom profiles, send only the standard messages/model/stream/token-limit fields
and needed tool fields. Do not send OpenRouter-specific routing, reasoning options,
HTTP-Referer or X-Title by default. `tokenLimitField` is a closed enum of `max_tokens`
and `max_completion_tokens`; emit exactly one. `includeUsage` controls the optional
stream usage request; missing usage stays unknown. Reject arbitrary payload overrides
that could replace messages, model, tools or authority. Preserve existing OpenRouter
options in its explicit adapter and characterize existing Ollama behavior.

Server errors, echoed bodies and headers are untrusted. Bound them and redact the
active key and recognized credential forms before display or persistence. Preserve
errors for unsupported fields/protocols rather than retrying with weaker tools or
silently changing models. Retrying must not duplicate an already emitted assistant/tool
stream or execute a tool twice. Cancellation must close the stream and finish once.

## 4. Discovery and capability evidence

Manual exact model selection is the first milestone and never depends on `/models`.
`providers models ID` reads the local snapshot. Only `--refresh` makes a network request.
Use the selected profile's auth and same base URL; no automatic network call on startup,
picker rendering, doctor or configuration load.

Bound discovery to 1 MiB of response bytes, 1,000 returned entries, a 15-second total
deadline and no implicit pagination. Reject over-limit/malformed responses honestly;
abort closes the connection. Accept the common `{ "data": [{ "id": "..." }] }` shape;
unrecognized metadata cannot declare tools, context or pricing. A missing endpoint or
failed refresh preserves manual models and the last valid cache with stale/error labels.
Deduplicate by provider plus exact ID; configured metadata wins over discovery data.

Store any cache privately outside the repository, keyed by provider/configuration
digest. Bound it to one current snapshot per profile and remove invalidated snapshots.
Discovered models cannot supply URLs, auth, instructions or executable configuration.

Keep three distinct evidence layers: user-declared capabilities, probe observations
and unknowns. A declaration of tool support permits a normal attempt, not a verified
badge. Unknown tool support also permits an explicitly selected normal run using the
existing tool protocol; warn once that it is unverified. Declared unsupported tools
blocks a coding-agent run with an actionable explanation. Do not silently run a coding
task as a text-only substitute. A model's prose claiming success is not verification
of edits/tests; preserve the existing outcome contract. Failed probes are displayed
as observed failures, not hidden or generalized to unrelated transports/models.

`providers test ID --model EXACT --checks text,tools` is explicit opt-in network use.
It sends synthetic fixtures only, never repository contents. The text check observes
stream completion; the tools check observes a schema-valid synthetic no-op tool call
and a subsequent response to its tool result. No filesystem, shell or real Matrix
tools are executed by a probe. Unsupported or ignored tool calls fail the tool check.

Limit one invocation to three requests total, including retries, at most 256 requested
completion tokens per request and 30 seconds total. Disable automatic retries where
necessary to preserve that cap. These are request limits, not a guaranteed dollar cost.
Record provider/model/configuration digest, timestamp, requested checks, actual checks,
usage if returned and pass/fail/not-evaluated results. Never claim this small probe proves
coding quality, maximum context length or complete protocol compatibility. Store at
most the latest record per model, capped at 256 models per profile with explicit oldest
record eviction. Editing a profile invalidates matching badges until re-tested.

## 5. CLI, UI, sessions and evaluation integration

The full flow is configuration → resolved target → controller → model agent → transport.
Audit every call that currently reduces a model to `model.id`. An environment-only
endpoint shortcut does not satisfy this phase.

The UI picker groups by provider and shows model name/ID, credential availability,
capability evidence and unknown pricing. It offers manual exact ID entry for a chosen
provider without source changes, validates it, and allows adding it to that profile
through explicit user action. Reload configuration/catalog explicitly; keep selection
stable by tuple rather than array index, and pin active runs to their original target.
Model changes during a run apply only to the next run. Preserve keyboard accessibility,
narrow widths and reduced-motion/screen-reader paths.

Sessions and saved evaluation configurations persist provider ID, exact model ID and
nonsecret configuration digest, never credentials. On reload, resolve through trusted
current user configuration. Missing or changed bindings must be visible and require
explicit reselection before remote execution; never fall back silently to Local Forge
or a different endpoint. Legacy sessions with recognized built-in IDs keep working;
unresolvable historical IDs show a repair path. Headless mismatch exits without a request.
Session data cannot override a provider URL, inject a key or authorize a tool.

Doctor reports configuration validity and per-provider credential presence without
connecting. Help explains API directory URLs, environment references, manual models,
unknown metadata and explicit probe spending. Evaluation accepts the same resolved
identity. Keep offline/mocked contracts as the default and separate any opt-in live
runner with recorded settings, task revision, token/request limits and exact results.
A later capability benchmark can compare models fairly; this phase provides access
and reproducibility, not a declaration of the best model.

## 6. Compatibility and scope

Preserve Local Forge offline behavior, built-in aliases, legacy endpoint overrides,
existing request bounds, approved tool schemas, exact undo and separate edit/test
permissions. Remote-provider support must not expand workspace access or command
privileges. The parallel CLI remains Local Forge until its separate phase is accepted.

PRV-101's decision record must pin schema defaults, public interfaces, digest fields,
writer protocol, legacy migration and error codes. Any smaller implementation must
still meet the mandatory acceptance matrix; do not relabel omitted requirements as
future enhancements to obtain acceptance.
