# Matrix next phase: dynamic custom providers first

Prepared 2026-10-29 against `e1b3c66`. This is an implementation plan; provider support
specified here has not been implemented or accepted. The owner has prioritized this
phase so better models can be configured and evaluated before later engineering work.

## Read and dispatch

1. Read [AGENTS.md](AGENTS.md) and current runtime documentation.
2. Read the [provider design contract](docs/next-phase/PROVIDERS.md).
3. Claim one [provider assignment](docs/next-phase/PROVIDER_TASKS.md).
4. Follow the [provider acceptance matrix](docs/next-phase/PROVIDER_AUDIT.md) and the
   submission/review rules in [AUDIT.md](docs/next-phase/AUDIT.md).
5. Record ownership, candidate identity and evidence in [STATUS.md](docs/next-phase/STATUS.md).

This is the active backlog. Historical engineering-plan DONE labels are not acceptance
evidence. User instructions take precedence. The chief plans, reviews and integrates;
implementation agents submit bounded changes and cannot approve their own work.

## User outcome

Add a named provider using its API base URL, an environment-variable reference for its
key, and any exact model ID. Select it in the terminal UI or headless CLI without editing
Matrix source. Use it for ordinary coding tasks and explicit compatibility/evaluation
runs through the existing approval, test and undo paths.

The first transport is streaming Chat Completions compatibility. This does not promise
native Anthropic Messages, Gemini, Responses, or arbitrary authentication protocols.
Unknown capabilities and pricing remain unknown. A successful connection is not proof
that a model is better at coding.

`providers add`, `providers models --refresh`, headless `--provider`, and interactive
picker selection of configured models are available; `providers test`, a TTY `--provider`
preset and explicit built-in provider routing remain acceptance targets:

```sh
matrix providers add --id lab --base-url https://inference.example/v1 --api-key-env LAB_API_KEY --model 'vendor/Model-X:latest'
matrix --provider lab --model 'vendor/Model-X:latest' 'Inspect this repository and propose a fix'
matrix providers models lab --refresh
matrix providers test lab --model 'vendor/Model-X:latest' --checks text,tools
```

The user supplies `LAB_API_KEY` through their environment. Do not put a key value into
command arguments or the provider file. A provider without `/models` must still work
with a manually specified model. No automatic network probes on startup or picker render.

## Existing behavior and required changes

| Area            | Current baseline                            | Required outcome                                                  |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| Endpoints       | Global environment overrides                | Named profiles with isolated URL/auth binding                     |
| Model selection | Static catalog plus arbitrary Ollama tags   | Exact arbitrary IDs under an explicit provider                    |
| Transport       | OpenRouter-oriented streaming               | Shared bounded parser and explicit transport options              |
| UI/doctor       | Static picker and largely global key status | One catalog, availability per provider/model                      |
| Sessions        | Model ID only                               | Provider/model identity and nonsecret configuration binding       |
| Evaluation      | Local/mocked contracts                      | Deterministic integration plus opt-in live compatibility evidence |

Inspect `lib/models.mjs`, `lib/credentials.mjs`, `lib/openrouter.mjs`,
`lib/model-agent.mjs`, `lib/controller.mjs`, `lib/session.mjs`, `bin/matrix.mjs`,
`src/matrix.mjs` and `src/screens/model.mjs` before changing interfaces. Verify actual
paths and callers; module names proposed by this plan are ownership boundaries.

## Sequence and gates

| Wave | Work                                                             | Gate                                                                                |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0    | PRV-101 configuration, identity and interface contracts          | P0: schema, selection precedence and secret-boundary tests accepted                 |
| 1    | PRV-102 transport; PRV-103 catalog/discovery                     | Independent files after P0; freeze interfaces before integration                    |
| 2    | PRV-104 CLI/UI/session integration                               | P1: manual custom model completes the real coding workflow with a local mock server |
| 3    | PRV-105 probes/evaluation; PRV-106 independent adversarial audit | P2: bounded discovery/probes and acceptance matrix pass                             |
| 4    | PRV-107 chief integration                                        | P3: exact integrated candidate passes Linux Node 22/24 and regression gates         |

PRV-103 delivers the manual catalog interface before optional network discovery, so
P1 is not delayed by a provider lacking a discovery endpoint. PRV-106 can prepare
independent fixtures after P0; final execution uses the integrated candidate.

At most three implementers plus the chief/reviewer work concurrently. Record exact
file reservations and checkout/base revision first. Shared-file edits require a handoff;
worktrees do not remove interface conflicts. The chief owns shared docs, package/config
and test helpers. No dependency additions without a written rationale and chief review.
No commits or pushes without the owner's instruction.

## Definition of done

- Two named providers can use the same wire model ID with distinct endpoints and keys.
- An ID absent from the shipped catalog reaches the intended provider unchanged.
- Interactive and headless runs preserve edit approvals, separate test authority,
  cancellation, truthful outcomes, protected paths and exact undo.
- Discovery failure does not disable manual models; refresh and probes are explicit,
  bounded and cancellable. Declared, observed and unknown capabilities are distinguishable.
- Sessions never silently switch provider, endpoint or model on reload.
- No credential appears in persisted configuration, session exports, logs or test evidence.
- All mandatory [audit cases](docs/next-phase/PROVIDER_AUDIT.md) have evidence on the
  candidate. Live checks are recorded separately, including NOT EVALUATED where absent.
- README/help/doctor explain working commands, profile paths and limitations. Existing
  Local Forge, OpenRouter, Ollama and legacy endpoint workflows retain their tested behavior.

This phase enables model choice for normal Matrix agents and evaluation. It does not
add remote-model execution to the existing Local Forge parallel CLI, automatic routing,
background agents, new shell authority, or a durable execution engine.

## What follows

After PRV-107 is ACCEPTED, release the preserved [durable execution phase](docs/next-phase/DURABLE_PHASE.md),
including its architecture, agent tasks and crash audit. Then plan persistent development
workspaces, LSP-001, coherent multi-file changes and independent verification. Remote-model
parallel work remains a separate phase with its own authority and integration review.

**First dispatch: PRV-101.** This planning delivery launches no agents, changes no runtime
behavior, and performs no live inference or spending. See the dispatch board for actual state.
