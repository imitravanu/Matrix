// Public JSDoc contracts shared by project indexing, agents, the controller, and
// interactive projections. This module is type-only: imports in JSDoc do not add
// a runtime dependency or change the ESM execution graph.

/** @typedef {Object<string, *>} UnknownRecord */

/**
 * @typedef {Object} DiffStats
 * @property {number} adds
 * @property {number} dels
 */

/**
 * @typedef {Object} DiffRow
 * @property {string} type
 * @property {string} text
 * @property {number|null} [oldLine]
 * @property {number|null} [newLine]
 * @property {number} [skipped]
 */

/**
 * @typedef {Object} DiffHunk
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {DiffRow[]} rows
 * @property {string} [eol]
 * @property {boolean} [oldFinalNewline]
 * @property {boolean} [newFinalNewline]
 */

/**
 * @typedef {Object} ProjectFile
 * @property {string} path
 * @property {string} rel
 * @property {string} [name]
 * @property {number} size
 * @property {string} [ext]
 * @property {string} language
 * @property {number} [mtimeMs]
 */

/**
 * @typedef {Object} ProjectLanguage
 * @property {string} name
 * @property {number} files
 * @property {number} bytes
 */

/**
 * @typedef {Object} TestPlan
 * @property {string} file
 * @property {string[]} args
 * @property {string} display
 * @property {string} cwd
 * @property {string} framework
 * @property {string} [script]
 */

/**
 * @typedef {Object} ProjectScanMetrics
 * @property {number} [directoriesSeen]
 * @property {number} [entriesSeen]
 * @property {number} [filesSeen]
 * @property {number} [gitCalls]
 * @property {number} [manifestReads]
 * @property {number} [manifestCacheHits]
 * @property {number} [manifestCacheMisses]
 * @property {string} [cacheStatus]
 * @property {number} [snapshotId]
 * @property {number} [snapshotAgeMs]
 */

/**
 * @typedef {Object} Project
 * @property {string} root
 * @property {string} name
 * @property {string|null} branch
 * @property {string|null} repoRoot
 * @property {boolean} nestedRepo
 * @property {boolean} isGit
 * @property {string[]} dirtyFiles
 * @property {boolean} dirtyFilesTruncated
 * @property {number|null} dirty
 * @property {boolean} dirtyAvailable
 * @property {"clean"|"dirty"|"truncated"|"unavailable"|"not-a-repo"} gitStatus
 * @property {ProjectFile[]} files
 * @property {number} fileCount
 * @property {boolean} truncated
 * @property {number} dirsSeen
 * @property {number} entriesSeen
 * @property {boolean} scanIncomplete
 * @property {ProjectLanguage[]} languages
 * @property {TestPlan|null} test
 * @property {number} scannedAt
 * @property {number} scanMs
 * @property {*} packageJson
 * @property {boolean} [snapshotStale]
 * @property {ProjectScanMetrics} [scanMetrics]
 */

/**
 * @typedef {Object} ModelDescriptor
 * @property {string} id
 * @property {string} [name]
 * @property {string} [provider]
 * @property {boolean} [remote]
 */

/**
 * @typedef {Object} PlanStep
 * @property {string|number} [id]
 * @property {string} [title]
 * @property {string} [status]
 */

/**
 * @typedef {Object} UsageInfo
 * @property {number} [inputTokens]
 * @property {number} [outputTokens]
 * @property {number} [cachedTokens]
 * @property {number|null} [cost]
 * @property {"provider"|"estimated"|"mixed"|"unavailable"|"legacy"} [provenance]
 * @property {"provider"|"estimated"|"mixed"|"unavailable"|"legacy"} [usageProvenance]
 * @property {"provider"|"estimated"|"mixed"|"unavailable"|"legacy"} [costProvenance]
 * @property {boolean} [costComplete]
 * @property {UnknownRecord} [provider]
 * @property {UnknownRecord} [estimated]
 * @property {UnknownRecord} [rounds]
 * @property {UnknownRecord} [costRounds]
 */

/**
 * @typedef {Object} RunMetrics
 * @property {number} [elapsedMs]
 * @property {number} [rounds]
 * @property {number} [toolCalls]
 * @property {number|null} [cost]
 * @property {number} [scopeNodes]
 * @property {number} [scopeParses]
 * @property {number} [matches]
 * @property {number} [files]
 * @property {UsageInfo} [usage]
 */

/**
 * @typedef {"verified"|"unverified"|"failed"|"skipped"|"timedOut"|"aborted"} VerificationStatus
 */

/**
 * @typedef {Object} VerificationResult
 * @property {string|null} [command]
 * @property {string|null} [cmd]
 * @property {boolean} [ok]
 * @property {boolean} [processOk]
 * @property {boolean} [verified]
 * @property {VerificationStatus} [verificationStatus]
 * @property {boolean} [skipped]
 * @property {boolean} [aborted]
 * @property {boolean} [timedOut]
 * @property {number} [passed]
 * @property {number} [failed]
 * @property {Array<{name: string, pass: boolean}>} [cases]
 * @property {Array<{name: string, pass: boolean}>} [results]
 * @property {string[]} [lines]
 * @property {string[]} [output]
 * @property {string|null} [summary]
 * @property {number} [durationMs]
 * @property {string} [duration]
 * @property {number} [outputLineCount]
 * @property {boolean} [outputTruncated]
 * @property {boolean} [parseConfident]
 * @property {boolean} [running]
 * @property {string|null} [error]
 * @property {string} [trustStatus]
 * @property {string} [trustReason]
 * @property {string} [trustDecision]
 * @property {string[]} [trustGrants]
 * @property {string} [auditStatus]
 * @property {string} [executionOrigin]
 * @property {*} [testPlan]
 */

/**
 * @typedef {Object} EditProposal
 * @property {string} file
 * @property {string} [absPath]
 * @property {string} [scope]
 * @property {string} [patch]
 * @property {DiffHunk[]} [hunks]
 * @property {UnknownRecord[]} [edits]
 * @property {DiffStats} [stats]
 * @property {string} [reason]
 * @property {boolean} [isCreation]
 * @property {string|null} [original]
 * @property {string} [updatedText]
 * @property {string|null} [backupPath]
 */

/**
 * @typedef {Object} EditCard
 * @property {string} [path]
 * @property {string} [scope]
 * @property {string[]} [diff]
 * @property {string} [patch]
 * @property {DiffHunk[]} [hunks]
 * @property {DiffStats} [stats]
 * @property {string} [status]
 * @property {string|null} [backupPath]
 */

/**
 * @typedef {"success"|"denied"|"failed"|"unverified"|"timedOut"|"aborted"|"budgetExhausted"} OutcomeStatus
 */

/**
 * @typedef {Object} RunResult
 * @property {string} [id]
 * @property {string} [role]
 * @property {string} [mode]
 * @property {string} [model]
 * @property {string} [content]
 * @property {string} [reasoning]
 * @property {PlanStep[]} [plan]
 * @property {*} [readFile]
 * @property {EditCard|null} [editFile]
 * @property {VerificationResult|null} [verifyTests]
 * @property {VerificationResult|null} [verification]
 * @property {UnknownRecord[]} [toolCards]
 * @property {string} [summary]
 * @property {boolean} [ok]
 * @property {OutcomeStatus} [status]
 * @property {OutcomeStatus} [outcome]
 * @property {boolean|string} [error]
 * @property {string|null} [failure]
 * @property {boolean} [aborted]
 * @property {boolean} [timedOut]
 * @property {boolean} [budgetExhausted]
 * @property {boolean} [denied]
 * @property {string} [modelName]
 * @property {UsageInfo|null} [usage]
 * @property {number|null} [cost]
 * @property {RunMetrics} [metrics]
 * @property {number} [elapsedMs]
 * @property {number} [elapsedTime]
 * @property {number} [timestamp]
 * @property {string} [editStatus]
 * @property {boolean} [hasAppliedEdits]
 * @property {boolean} [verificationCurrent]
 * @property {string|null} [finishReason]
 * @property {*} [applied]
 * @property {EditProposal|null} [proposal]
 * @property {*} [matches]
 * @property {*} [recovery]
 * @property {string} [usageProvenance]
 * @property {string} [costProvenance]
 * @property {boolean} [costComplete]
 */

/**
 * @typedef {Object} OutcomeClassification
 * @property {boolean} ok
 * @property {OutcomeStatus} status
 * @property {OutcomeStatus} outcome
 * @property {"complete"|"failed"|"aborted"} phase
 * @property {"done"|"error"|"aborted"} mode
 * @property {boolean} error
 * @property {string|null} failure
 * @property {boolean} aborted
 * @property {boolean} timedOut
 * @property {boolean} budgetExhausted
 */

/** @typedef {RunResult & Omit<OutcomeClassification, "phase"|"mode">} ClassifiedRunResult */

/**
 * @typedef {Object} ToolCard
 * @property {string|null} [id]
 * @property {string} [name]
 * @property {string} [label]
 * @property {UnknownRecord} [args]
 * @property {boolean} [ok]
 * @property {string} [summary]
 * @property {boolean} [running]
 * @property {*} [data]
 */

/**
 * @typedef {Object} LiveRun
 * @property {string} prompt
 * @property {string} task
 * @property {string} reasoning
 * @property {string} content
 * @property {PlanStep[]} plan
 * @property {number} activePlanIdx
 * @property {*} readFile
 * @property {EditCard|null} editFile
 * @property {VerificationResult|null} verifyTests
 * @property {string[]} verifyLines
 * @property {ToolCard[]} toolCards
 * @property {string} phase
 * @property {string} detail
 * @property {UsageInfo|null} usage
 * @property {RunMetrics|null} metrics
 * @property {string} modelName
 * @property {boolean} error
 * @property {string} summary
 * @property {boolean} streaming
 */

/** @typedef {{runId?: string, at?: number}} EventMetadata */
/** @typedef {EventMetadata & {type: "run:start", task?: string, mode?: string, model?: string|ModelDescriptor|null, modelName?: string, plan?: PlanStep[]}} RunStartEvent */
/** @typedef {EventMetadata & {type: "phase", phase?: string, detail?: string}} PhaseEvent */
/** @typedef {EventMetadata & {type: "plan", plan?: PlanStep[], activeIndex?: number}} PlanEvent */
/** @typedef {EventMetadata & {type: "plan:step", index?: number, status?: string, plan?: PlanStep[]}} PlanStepEvent */
/** @typedef {EventMetadata & {type: "thought"|"content", text?: string}} TextEvent */
/** @typedef {EventMetadata & {type: "tool:start", id?: string|null, name?: string, label?: string, args?: UnknownRecord}} ToolStartEvent */
/** @typedef {EventMetadata & {type: "tool:end", id?: string|null, name?: string, ok?: boolean, summary?: string, data?: *}} ToolEndEvent */
/** @typedef {EventMetadata & {type: "proposal", proposal: EditProposal}} ProposalEvent */
/** @typedef {EventMetadata & {type: "approval:request", proposal?: EditProposal}} ApprovalRequestEvent */
/** @typedef {EventMetadata & {type: "approval:result", decision: string}} ApprovalResultEvent */
/** @typedef {EventMetadata & {type: "applied", file?: string, absPath?: string, stats?: DiffStats, backupPath?: string|null, isCreation?: boolean}} AppliedEvent */
/** @typedef {EventMetadata & {type: "verify:start", command: string, cwd?: string}} VerifyStartEvent */
/** @typedef {EventMetadata & {type: "verify:line", line?: string, stream?: string}} VerifyLineEvent */
/** @typedef {EventMetadata & {type: "verify:skipped", reason?: string}} VerifySkippedEvent */
/** @typedef {EventMetadata & {type: "verify:end", result?: VerificationResult}} VerifyEndEvent */
/** @typedef {EventMetadata & {type: "usage", usage?: UsageInfo}} UsageEvent */
/** @typedef {EventMetadata & {type: "metrics", metrics?: RunMetrics}} MetricsEvent */
/** @typedef {EventMetadata & {type: "result", result: RunResult}} ResultEvent */
/** @typedef {EventMetadata & {type: "error", error?: string, aborted?: boolean}} ErrorEvent */
/** @typedef {EventMetadata & {type: "done"}} DoneEvent */
/** @typedef {EventMetadata & {type: "undo", ok?: boolean, files?: string[], restored?: string[], pending?: string[], error?: string}} UndoEvent */
/** @typedef {EventMetadata & {type: "abort:requested"|"execution:start"|"execution:end"|"trust:decision", executionId?: string, status?: string, startedAt?: number, endedAt?: number, origin?: string, trustDecision?: string, trustGrants?: string[], testPlan?: *, processOk?: boolean, verified?: boolean, code?: number|null, signal?: string|null, timedOut?: boolean, aborted?: boolean, durationMs?: number, outputTruncated?: boolean, error?: string|null, reason?: string}} SystemRunEvent */

/**
 * @typedef {RunStartEvent|PhaseEvent|PlanEvent|PlanStepEvent|TextEvent|ToolStartEvent|ToolEndEvent|ProposalEvent|ApprovalRequestEvent|ApprovalResultEvent|AppliedEvent|VerifyStartEvent|VerifyLineEvent|VerifySkippedEvent|VerifyEndEvent|UsageEvent|MetricsEvent|ResultEvent|ErrorEvent|DoneEvent|UndoEvent|SystemRunEvent} RunEvent
 */

/** @typedef {function(RunEvent): void} RunEventListener */

/**
 * @typedef {Object} ProviderMessage
 * @property {string} role
 * @property {string|null} [content]
 * @property {string} [name]
 * @property {UnknownRecord[]} [tool_calls]
 * @property {string|null} [tool_call_id]
 */

/** @typedef {{type: "reasoning"|"content", text: string}} OpenRouterTextEvent */
/** @typedef {{type: "tool_call", index: number|null, key?: string|null, id?: string|null, name?: string|null, arguments?: *}} OpenRouterToolCallEvent */
/** @typedef {{type: "finish", reason: string}} OpenRouterFinishEvent */
/** @typedef {{type: "done", usage?: UsageInfo}} OpenRouterDoneEvent */
/** @typedef {{type: "error", error: string}} OpenRouterErrorEvent */
/** @typedef {OpenRouterTextEvent|OpenRouterToolCallEvent|OpenRouterFinishEvent|OpenRouterDoneEvent|OpenRouterErrorEvent} OpenRouterEvent */

/**
 * @typedef {Object} AgentOptions
 * @property {string} task
 * @property {Project} project
 * @property {ModelDescriptor|null} [model]
 * @property {RunEventListener|null} [onEvent]
 * @property {function(EditProposal): Promise<string>|null} [requestApproval]
 * @property {boolean} [autoApprove]
 * @property {AbortSignal|null} [signal]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [maxRounds]
 * @property {boolean} [autoVerify]
 * @property {number} [testTimeoutMs]
 * @property {ProviderMessage[]|null} [extraContext]
 * @property {"auto"|"interactive"|"headless"} [recoveryMode]
 */

/**
 * @typedef {Object} RunProcessOptions
 * @property {string} file
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string|null} [display]
 * @property {function(string, string): void|null} [onLine]
 * @property {"ignore"|"pipe"|"inherit"} [stdin]
 */

/**
 * @typedef {Object} RetentionOptions
 * @property {number} [historyEntries]
 * @property {number} [historyBytes]
 * @property {number} [stringChars]
 * @property {boolean} [pruneBackups]
 * @property {number} [backupMaxFiles]
 * @property {number} [backupMaxTotalBytes]
 * @property {number} [eventEntries]
 * @property {number} [maxEventBytes]
 * @property {number} [maxFiles]
 * @property {number} [maxTotalBytes]
 */

/**
 * @typedef {Object} UndoEntry
 * @property {string} file
 * @property {string} absPath
 * @property {string|null} original
 * @property {Buffer|null} [originalBytes]
 * @property {string} updatedText
 * @property {string} [patch]
 * @property {DiffStats} [stats]
 * @property {string|null} [backupPath]
 * @property {boolean} isCreation
 * @property {number|null} [appliedAt]
 */

/**
 * @typedef {Object} UndoRun
 * @property {1} version
 * @property {string|null} runId
 * @property {UndoEntry[]} entries
 */

/**
 * @typedef {Object} ControllerStartOptions
 * @property {string} task
 * @property {Project} project
 * @property {ModelDescriptor|null} [model]
 * @property {boolean} [autoApprove]
 * @property {ProviderMessage[]|null} [extraContext]
 * @property {*} [testPolicy]
 * @property {Function|null} [requestTestApproval]
 */

/** @typedef {{ok: false, error: string}} ControllerRejection */
/** @typedef {{ok: boolean, status: OutcomeStatus, outcome: OutcomeStatus, result?: RunResult, runId: string, applied?: number, elapsedMs: number, error?: string}} ControllerCompletion */
/** @typedef {ControllerRejection|ControllerCompletion} ControllerStartResult */

/**
 * @typedef {Object} UndoResult
 * @property {boolean} ok
 * @property {string} [error]
 * @property {boolean} [partial]
 * @property {string[]} [files]
 * @property {string[]} [restored]
 * @property {string[]} [pending]
 */

/**
 * @typedef {Object} ActiveRun
 * @property {string} runId
 * @property {string} task
 * @property {Project} project
 * @property {ModelDescriptor|null|undefined} model
 * @property {number} startedAt
 * @property {boolean} autoApprove
 * @property {boolean} aborted
 */

/**
 * @typedef {Object} RunController
 * @property {function(ControllerStartOptions): Promise<ControllerStartResult>} start
 * @property {function(string): boolean} approve
 * @property {function(): boolean} abort
 * @property {function(): UndoResult} undoLast
 * @property {function(): boolean} canUndo
 * @property {function(): void} clearUndo
 * @property {function(): UndoEntry|null} lastApplied
 * @property {function(): UndoRun|null} getUndoRun
 * @property {function(*, {root?: string|null}=): boolean} restoreFromSession
 * @property {function(): boolean} isRunning
 * @property {function(): boolean} isWaitingForApproval
 * @property {function(): ActiveRun|null} currentRun
 * @property {function(RunEventListener|null): void} setListener
 * @property {function(): void} dispose
 */

/**
 * @typedef {Object} ControllerOptions
 * @property {RunEventListener|null} [onEvent]
 * @property {string} [home]
 * @property {function(string, string|Buffer): *} [writeUndo]
 * @property {*} [testPolicy]
 * @property {Function|null} [onTestTrustRequest]
 * @property {boolean} [headless]
 * @property {boolean} [allowTests]
 */

export {};
