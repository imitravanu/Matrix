// ============================================================================
// Matrix — spatial agent workbench.
//
// This file is the orchestrator: real project detection, a real run controller,
// real swarm events, real session persistence, and six screens. The visual
// language is the existing forge theme; the behaviour underneath is no longer a
// simulation.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useAnimation, useApp, useInput, usePaste } from "ink";

import { reducedMotion, useLayout } from "../lib/term.mjs";
import { parseTerminalMouse } from "../lib/mouse.mjs";
import {
  completeSlash,
  createInputState,
  insertText,
  setValue,
  slashMatches,
  submit,
} from "../lib/input.mjs";
import { detectProjectAsync, invalidateProjectCache, readFileSafe } from "../lib/project.mjs";
import { parseScopes, scopeAtLine } from "../lib/scope.mjs";
import { runTests } from "../lib/process.mjs";
import { addProviderModel, loadProviderConfig } from "../lib/provider-config.mjs";
import { buildProviderCatalog } from "../lib/provider-catalog.mjs";
import { readProbeRecord } from "../lib/provider-probe.mjs";
import { LOCAL_MODEL, formatCost, resolveModel } from "../lib/models.mjs";
import {
  buildPickerModels,
  findPickerModel,
  pickerIndexFor,
  pickerKeyFor,
  pickerModelFromTarget,
} from "./provider-picker.mjs";
import {
  isProviderCredentialAvailable,
  PROVIDER_LIMITS,
  resolveProviderSelection,
  targetDigest,
} from "../lib/provider-contracts.mjs";
import { createRunController } from "../lib/controller.mjs";
import { applySwarmEvent, createSwarmState, focusLane } from "../lib/swarm.mjs";
import { newRunId, saveSession, listSessions, matrixHome } from "../lib/session.mjs";
import { runDoctorAsync, formatDoctor } from "../lib/doctor.mjs";
import { writePng } from "../lib/raster.mjs";
import { buildVisionCanvas, VISION_MODES } from "./screens/vision.mjs";
import { Header, InputBar, KeyHints, SlashMenu, StatusBar } from "./screens/common.mjs";
import { isOpenRouterAvailable } from "./credentials.mjs";
import { SCREENS, scopeFilesFor } from "./views.mjs";
import { ScreenView } from "./frame.mjs";
import { makeLive, reduceRunEvent } from "./event-reducer.mjs";
import { applyKeyboardInput, decideKeyboard } from "./keyboard.mjs";
import { projectDirectTestResult, projectResult } from "./result-projection.mjs";
import {
  accumulateTokenStats,
  appendHistory,
  hasRetainedVerificationOutput,
  historyFromSession,
  lastContext,
  lastVerification,
  normalizeUsage,
  promptHistoryFrom,
  RETAINED_OUTPUT_LIMIT,
  sessionSnapshot,
} from "./session-codec.mjs";
import {
  formatCodeBlock,
  formatTokens,
  renderContentWithCodeBlocks,
  renderEditFileCard,
  renderPlanCard,
  renderReadFileCard,
  renderThoughtCard,
  renderVerifyTestsCard,
} from "./cards.mjs";

const h = React.createElement;
const MAX_MANUAL_PICKER_MODELS = 256;

function pickerObservation(target, config) {
  if (target?.kind !== "custom") return null;
  const profile = config?.providers.find((entry) => entry.id === target.providerId);
  if (!profile || targetDigest(profile) !== target.configDigest) return null;
  const record = readProbeRecord(matrixHome(), profile, target.modelId);
  return record
    ? {
        text: record.checks.text.status,
        tools: record.checks.tools.status,
        testedAt: record.testedAt,
      }
    : null;
}

// ---------------------------------------------------------------------------
// MatrixApp
// ---------------------------------------------------------------------------

export function MatrixApp({
  cwd = process.cwd(),
  initialTask = "",
  initialModel = null,
  initialSelection = null,
  initialSession = null,
  initialProvider = null,
  autoApprove: initialAutoApprove = false,
  offline = false,
  enableCommands = false,
  providerCatalog: initialProviderCatalog = null,
  providerConfig: initialProviderConfig = null,
  checkCredentialAvailability = isOpenRouterAvailable,
} = {}) {
  const { exit } = useApp();
  const { cols, height } = useLayout();
  const width = Math.max(20, cols - 2);

  const [providerCatalog, setProviderCatalog] = useState(initialProviderCatalog);
  const [providerConfig, setProviderConfig] = useState(initialProviderConfig);

  const initialHistory = useMemo(() => historyFromSession(initialSession), [initialSession]);
  const basePickerModels = useMemo(
    () => buildPickerModels({ catalog: providerCatalog, config: providerConfig }),
    [providerCatalog, providerConfig],
  );
  // A saved provider identity is authoritative even when the model is absent
  // from discovery or was entered manually. Rebuild the exact target instead of
  // asking the legacy model resolver, which would silently choose Local Forge
  // for an arbitrary built-in or uncatalogued custom wire ID.
  const sessionSelection = useMemo(() => {
    if (!initialProvider) return null;
    try {
      const target = resolveProviderSelection({
        providerId: initialProvider.id,
        modelQuery: initialProvider.modelId,
        config: providerConfig ?? undefined,
      }).target;
      return pickerModelFromTarget(target, {
        source: "session",
        available:
          target.kind === "custom" ? isProviderCredentialAvailable(target, process.env) : null,
        description: `Saved session model on ${target.providerName}`,
        observation: pickerObservation(target, providerConfig),
      });
    } catch {
      return null;
    }
  }, [initialProvider, providerConfig]);
  const [extraPickerModels, setExtraPickerModels] = useState(() => {
    const initial = initialSelection
      ? {
          ...initialSelection,
          observation: pickerObservation(initialSelection.providerTarget, providerConfig),
        }
      : sessionSelection;
    return initial ? [initial] : [];
  });
  const pickerModels = useMemo(() => {
    if (extraPickerModels.length === 0) return basePickerModels;
    const extras = new Map(extraPickerModels.map((entry) => [pickerKeyFor(entry), entry]));
    const merged = basePickerModels.map((entry) => {
      const extra = extras.get(pickerKeyFor(entry));
      return extra ? { ...extra, observation: entry.observation ?? null } : entry;
    });
    const remaining = extraPickerModels.filter(
      (entry) => !basePickerModels.some((base) => pickerKeyFor(base) === pickerKeyFor(entry)),
    );
    return [...merged, ...remaining];
  }, [basePickerModels, extraPickerModels]);
  const [project, setProject] = useState(null);
  const [model, setModel] = useState(() => {
    if (initialSelection) {
      return findPickerModel(pickerModels, initialSelection.pickerKey) ?? initialSelection;
    }
    if (sessionSelection) return sessionSelection;
    if (initialProvider) {
      const bound = findPickerModel(
        pickerModels,
        `provider:${initialProvider.id}:${initialProvider.modelId}`,
      );
      if (bound) return bound;
    }
    return resolveModel(offline ? "local" : (initialModel ?? initialSession?.modelId ?? "local"));
  });
  const modelAvailability = useCallback(
    (candidate) => {
      if (!candidate) return false;
      const target = candidate.providerTarget;
      if (target?.kind === "custom") {
        return candidate.available === true && !candidate.targetError;
      }
      if (target?.kind === "builtin") {
        return target.providerId === "ollama" || target.providerId === "matrix"
          ? true
          : checkCredentialAvailability(candidate.id);
      }
      return checkCredentialAvailability(candidate.id);
    },
    [checkCredentialAvailability],
  );
  const [hasKey, setHasKey] = useState(() => modelAvailability(model));
  const [history, setHistory] = useState(initialHistory);
  const [inputState, setInputState] = useState(() =>
    createInputState("", promptHistoryFrom(initialHistory)),
  );
  const [screen, setScreen] = useState(() =>
    initialTask ? "chat" : initialHistory.length > 0 ? "chat" : "empty",
  );
  const [returnScreen, setReturnScreen] = useState("chat");
  const [running, setRunning] = useState(false);
  const reduceMotion = reducedMotion();
  const { frame } = useAnimation({
    interval: 90,
    isActive: !reduceMotion && running && (screen === "chat" || screen === "swarm"),
  });
  const [permission, setPermission] = useState(null);
  const [commandTrustRequest, setCommandTrustRequest] = useState(null);
  const [commandTrustScroll, setCommandTrustScroll] = useState(0);
  const commandTrustBoundsRef = useRef({ total: 0, height: 10, maxOffset: 0 });
  const commandTrustResolved = useRef(false);
  const [testTrustRequest, setTestTrustRequest] = useState(null);
  const [testTrustScroll, setTestTrustScroll] = useState(0);
  const testTrustBoundsRef = useRef({ total: 0, height: 10, maxOffset: 0 });
  const testTrustResolved = useRef(false);
  const [permissionScroll, setPermissionScroll] = useState(0);
  const [permissionBounds, setPermissionBounds] = useState({ total: 0, height: 10 });
  const [helpScroll, setHelpScroll] = useState(0);
  const helpBoundsRef = useRef({ total: 0, height: 10, maxOffset: 0 });
  const reportHelpBounds = useCallback((bounds) => {
    helpBoundsRef.current = bounds;
  }, []);
  const [chatScroll, setChatScroll] = useState(0);
  const [chatBounds, setChatBounds] = useState({ total: 0, height: 10 });
  const [autoApprove, setAutoApprove] = useState(Boolean(initialAutoApprove));
  const [thoughtsExpanded, setThoughtsExpanded] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [swarmState, setSwarmState] = useState(() => createSwarmState({ project: null }));
  const [scopeFile, setScopeFile] = useState(() => lastContext(initialHistory, null)?.file ?? null);
  const [scopeSelection, setScopeSelection] = useState(0);
  const [visionMode, setVisionMode] = useState("scope");
  const [visionStatus, setVisionStatus] = useState("");
  const [pickerIndex, setPickerIndex] = useState(() => pickerIndexFor(pickerModels, model));
  const [manualPicker, setManualPicker] = useState({
    active: false,
    text: "",
    error: "",
    providerId: null,
    providerName: null,
  });
  const [slashIndex, setSlashIndex] = useState(0);
  const [status, setStatus] = useState("");
  const [tokenStats, setTokenStats] = useState(() => normalizeUsage(initialSession?.tokenStats));
  const [metrics, setMetrics] = useState(initialSession?.metrics ?? {});
  const [, setLiveVersion] = useState(0);
  const [projectRevision, setProjectRevision] = useState(0);
  const [sessionId, setSessionId] = useState(() => initialSession?.id ?? newRunId());

  const liveRef = useRef(null);
  const liveTimer = useRef(null);
  const autoApproveDefault = useRef(Boolean(initialAutoApprove));
  const historyRef = useRef(history);
  const projectRef = useRef(project);
  const projectRequestRef = useRef(0);
  const modelRef = useRef(model);
  const tokenStatsRef = useRef(tokenStats);
  const autoApproveRef = useRef(autoApprove);
  const runningRef = useRef(running);
  const screenRef = useRef(screen);
  const permissionRef = useRef(permission);
  const statusTimer = useRef(null);
  const runBaseTokens = useRef({ ...tokenStats });
  const resultHandled = useRef(false);
  const warnedToolSupport = useRef(new Set());
  const startedInitial = useRef(false);
  const handleEventRef = useRef(null);
  const saveRef = useRef(null);
  const permissionResolved = useRef(false);
  const testAbortRef = useRef(null);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  const selectModel = useCallback(
    (chosen) => {
      const available = modelAvailability(chosen);
      modelRef.current = chosen;
      setModel(chosen);
      setHasKey(available);
      return available;
    },
    [modelAvailability],
  );
  useEffect(() => {
    tokenStatsRef.current = tokenStats;
  }, [tokenStats]);
  useEffect(() => {
    autoApproveRef.current = autoApprove;
  }, [autoApprove]);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);
  useEffect(() => {
    permissionRef.current = permission;
  }, [permission]);
  useEffect(() => {
    setSlashIndex(0);
  }, [inputState.value]);

  const requestCommandApproval = useCallback((request) => {
    return new Promise((resolve) => {
      commandTrustResolved.current = false;
      setCommandTrustScroll(0);
      setReturnScreen(screenRef.current === "empty" ? "chat" : screenRef.current);
      setCommandTrustRequest({ ...request, resolve });
      setScreen("permission");
    });
  }, []);
  const reportCommandTrustBounds = useCallback((bounds) => {
    commandTrustBoundsRef.current = bounds;
  }, []);
  const settleCommandTrust = useCallback(
    (decision) => {
      const request = commandTrustRequest;
      if (!request || commandTrustResolved.current) return;
      commandTrustResolved.current = true;
      setCommandTrustRequest(null);
      setScreen(returnScreen);
      request.resolve(decision);
    },
    [commandTrustRequest, returnScreen],
  );

  const requestTestApproval = useCallback((request) => {
    return new Promise((resolve) => {
      testTrustResolved.current = false;
      setTestTrustScroll(0);
      setReturnScreen(screenRef.current === "empty" ? "chat" : screenRef.current);
      setTestTrustRequest({ ...request, resolve });
      setScreen("permission");
    });
  }, []);
  const reportTestTrustBounds = useCallback((bounds) => {
    testTrustBoundsRef.current = bounds;
  }, []);
  const settleTestTrust = useCallback(
    (decision) => {
      const request = testTrustRequest;
      if (!request || testTrustResolved.current) return;
      testTrustResolved.current = true;
      setTestTrustRequest(null);
      setScreen(returnScreen);
      request.resolve(decision);
    },
    [testTrustRequest, returnScreen],
  );

  const controller = useMemo(
    () =>
      createRunController({
        onEvent: (event) => handleEventRef.current?.(event),
        onTestTrustRequest: requestTestApproval,
        onCommandTrustRequest: requestCommandApproval,
        enableCommands,
        home: matrixHome(),
      }),
    [enableCommands, requestCommandApproval, requestTestApproval],
  );

  // Resuming a session should not be read-only: re-arm the complete run when
  // every exact post-image still matches. Legacy single patches migrate here.
  useEffect(() => {
    const savedUndo = initialSession?.undoRun ?? initialSession?.lastPatch;
    if (savedUndo) controller.restoreFromSession(savedUndo, { root: cwd });
  }, [controller, cwd, initialSession]);

  const bumpLive = useCallback((immediate = false) => {
    if (immediate) {
      if (liveTimer.current) {
        clearTimeout(liveTimer.current);
        liveTimer.current = null;
      }
      setLiveVersion((value) => value + 1);
      return;
    }
    if (liveTimer.current) return;
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      setLiveVersion((value) => value + 1);
    }, 40);
  }, []);

  const flash = useCallback((message, ms = 4000) => {
    setStatus(String(message ?? ""));
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(""), ms);
  }, []);

  const resetAutoApprove = useCallback(() => {
    const value = autoApproveDefault.current;
    setAutoApprove(value);
    autoApproveRef.current = value;
  }, []);

  const refreshProject = useCallback(
    async ({ refresh = true } = {}) => {
      const requestId = ++projectRequestRef.current;
      if (refresh) invalidateProjectCache(cwd);
      try {
        const next = await detectProjectAsync(cwd, { refresh });
        if (requestId !== projectRequestRef.current) return projectRef.current;
        if (!next.snapshotStale) {
          setProject(next);
          projectRef.current = next;
          setProjectRevision((value) => value + 1);
        }
        return next;
      } catch (error) {
        if (requestId === projectRequestRef.current)
          flash(`index refresh failed: ${error.message}`, 6000);
        return projectRef.current;
      }
    },
    [cwd, flash],
  );

  useEffect(() => {
    refreshProject({ refresh: false });
    return () => {
      projectRequestRef.current += 1;
    };
  }, [refreshProject]);

  const scopeFiles = useMemo(() => scopeFilesFor(project), [project]);
  const scopeData = useMemo(() => {
    if (!scopeFile || !project?.root) return { file: scopeFile ?? null, source: "", parsed: null };
    const readable = readFileSafe(`${project.root}/${scopeFile}`);
    if (!readable.ok) return { file: scopeFile, source: "", parsed: null };
    return {
      file: scopeFile,
      source: readable.content,
      parsed: parseScopes(readable.content, scopeFile, { truncated: Boolean(readable.truncated) }),
    };
  }, [scopeFile, project?.root ?? null, projectRevision]);

  useEffect(() => {
    if (!scopeFile && scopeFiles.length > 0) setScopeFile(scopeFiles[0]);
  }, [scopeFiles, scopeFile]);

  useEffect(() => {
    if (!scopeFile) return;
    const context = lastContext(historyRef.current, liveRef.current);
    if (context?.file === scopeFile && scopeData.parsed) {
      const node = scopeAtLine(scopeData.parsed, context.line);
      const flat = (scopeData.parsed.flat ?? []).filter((item) => item.kind !== "module");
      const index = node ? flat.findIndex((item) => item.id === node.id) : -1;
      setScopeSelection(index >= 0 ? index : 0);
    } else {
      setScopeSelection(0);
    }
  }, [scopeFile, scopeData.parsed]);

  const saveSnapshot = useCallback(
    (historyArg = historyRef.current, finalMetrics = null) => {
      try {
        // The controller publishes on the first applied event, so this is the
        // current complete run even when the agent later fails or a result card
        // contains only a truncated/last-file projection.
        const undoRun = controller.getUndoRun();
        const persistedMetrics = finalMetrics ?? metrics;
        const snapshot = sessionSnapshot({
          project: projectRef.current,
          history: historyArg,
          model: modelRef.current,
          tokenStats: tokenStatsRef.current,
          metrics: persistedMetrics,
          undoRun,
          cwd,
          sessionId,
          elapsedMs: persistedMetrics?.elapsedMs ?? 0,
        });
        const saved = saveSession(snapshot, { home: matrixHome() });
        if (!saved.ok) {
          flash(`session save failed: ${saved.warnings.at(-1)?.message ?? "unknown error"}`, 7000);
        } else if (saved.warnings.length > 0) {
          flash(`session warning: ${saved.warnings.at(-1).message}`, 5000);
        }
      } catch {
        // A full disk must not take down the workbench.
      }
    },
    [controller, cwd, metrics, sessionId],
  );
  saveRef.current = saveSnapshot;

  const finalizeResult = useCallback(
    (result) => {
      if (!result || resultHandled.current) return;
      resultHandled.current = true;
      if (commandTrustRequest) settleCommandTrust("n");
      if (testTrustRequest) settleTestTrust("n");
      const { normalized, finalMetrics, message } = projectResult(result, {
        liveVerification: liveRef.current?.verifyTests,
        modelName: modelRef.current?.name ?? "MATRIX",
      });
      setMetrics(finalMetrics);
      const next = appendHistory(historyRef.current, message);
      historyRef.current = next;
      setHistory(next);
      setLiveVersion((value) => value + 1);
      liveRef.current = null;
      setRunning(false);
      setPermission(null);
      resetAutoApprove();
      if (!normalized.ok)
        flash(normalized.failure ?? normalized.summary ?? normalized.status, 8000);
      else if (normalized.summary) flash(normalized.summary, 5000);
      saveRef.current?.(next, finalMetrics);
    },
    [
      commandTrustRequest,
      flash,
      resetAutoApprove,
      settleCommandTrust,
      settleTestTrust,
      testTrustRequest,
    ],
  );

  handleEventRef.current = (event) => {
    setSwarmState((previous) => applySwarmEvent(previous, event));
    const reduction = reduceRunEvent(event, {
      live: liveRef.current,
      modelName: modelRef.current?.name ?? "MATRIX",
      autoApprove: autoApproveRef.current,
    });
    liveRef.current = reduction.live;

    if (reduction.runStart) {
      runBaseTokens.current = normalizeUsage(tokenStatsRef.current);
      resultHandled.current = false;
      permissionResolved.current = false;
      setRunning(true);
      setScreen("chat");
      setPermission(null);
      setChatScroll(0);
    }
    if (reduction.proposal) {
      setPermission({ ...reduction.proposal, status: "pending" });
      permissionResolved.current = false;
      if (reduction.showPermission) {
        setScreen("permission");
        setPermissionScroll(0);
      }
    }
    if (reduction.approvalRequest && !autoApproveRef.current && permissionRef.current) {
      setScreen("permission");
    }
    if (reduction.hasApprovalResult) {
      const status = reduction.approvalDecision === "n" ? "denied" : "approved";
      setPermission((previous) => (previous ? { ...previous, status } : previous));
      if (!autoApproveRef.current) setScreen("chat");
    }
    if (reduction.hasUsage) {
      setTokenStats(accumulateTokenStats(runBaseTokens.current, reduction.tokenSnapshot));
    }
    if (reduction.hasMetrics) setMetrics(reduction.metrics);
    if (reduction.hasResult) finalizeResult(reduction.result);
    if (reduction.hasError) flash(reduction.error, 8000);
    if (reduction.done) setRunning(false);
    if (reduction.hasUndo) {
      const message = {
        id: `system-${Date.now()}`,
        role: "system",
        content: reduction.undoText,
        timestamp: Date.now(),
      };
      const next = appendHistory(historyRef.current, message);
      historyRef.current = next;
      setHistory(next);
      flash(reduction.undoText);
    }
    if (reduction.bump) bumpLive(reduction.bump === "immediate");
  };

  const startTask = useCallback(
    async (task) => {
      const clean = String(task ?? "").trim();
      if (!clean) return;
      if (runningRef.current) {
        flash("a run is already active · Ctrl+C aborts it");
        return;
      }
      if (
        modelRef.current?.custom &&
        (!modelRef.current.providerTarget || modelRef.current.targetError)
      ) {
        flash(
          `provider unavailable · ${modelRef.current.targetError ?? "configuration could not be resolved"}`,
          7000,
        );
        return;
      }
      if (modelRef.current?.providerTarget?.capabilities?.tools === "unsupported") {
        flash("This model declares no tool support · choose a tool-capable model for coding", 7000);
        return;
      }
      const target = modelRef.current?.providerTarget;
      if (target?.capabilities?.tools === "unknown") {
        const identity = `${target.providerId}\0${target.modelId}\0${target.configDigest ?? ""}`;
        if (!warnedToolSupport.current.has(identity)) {
          if (warnedToolSupport.current.size >= MAX_MANUAL_PICKER_MODELS) {
            const oldest = warnedToolSupport.current.values().next().value;
            if (oldest !== undefined) warnedToolSupport.current.delete(oldest);
          }
          warnedToolSupport.current.add(identity);
          flash("Tool support is unverified for this model · run providers test to check", 7000);
        }
      }
      const userMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: clean,
        timestamp: Date.now(),
      };
      const next = appendHistory(historyRef.current, userMessage);
      historyRef.current = next;
      setHistory(next);
      setInputState((previous) => createInputState("", previous.history));
      setScreen("chat");
      setChatScroll(0);
      setPermission(null);
      setDiffExpanded(false);
      setOutputExpanded(false);
      setRunning(true);
      liveRef.current = makeLive(clean, modelRef.current?.name ?? "MATRIX");
      runBaseTokens.current = normalizeUsage(tokenStatsRef.current);
      resultHandled.current = false;
      const runProject = await refreshProject();
      if (!runProject || runProject.snapshotStale) {
        setRunning(false);
        liveRef.current = null;
        flash("workspace index is stale; retry the task", 6000);
        bumpLive(true);
        return;
      }
      setSwarmState(createSwarmState({ task: clean, project: runProject }));
      bumpLive(true);

      const outcome = await controller.start({
        task: clean,
        project: runProject,
        model: modelRef.current,
        providerTarget: modelRef.current?.providerTarget ?? null,
        autoApprove: autoApproveRef.current,
        extraContext: historyRef.current,
      });
      if (!resultHandled.current) {
        if (outcome?.result) finalizeResult(outcome.result);
        else {
          const fallback = {
            role: "assistant",
            content: outcome?.error
              ? `Run failed: ${outcome.error}`
              : "Run ended without a result.",
            error: true,
            summary: outcome?.error ?? "no result",
            modelName: modelRef.current?.name,
          };
          finalizeResult(fallback);
        }
      }
      setRunning(false);
    },
    [bumpLive, controller, finalizeResult, flash, refreshProject],
  );

  const runTestsDirect = useCallback(async () => {
    if (runningRef.current) {
      flash("a run is already active");
      return;
    }
    const current = await refreshProject();
    if (!current || !current.test) {
      flash("no test runner detected in this workspace");
      return;
    }
    setRunning(true);
    setScreen("chat");
    setChatScroll(0);
    setOutputExpanded(false);
    const task = `/test · ${current.test.display}`;
    liveRef.current = makeLive(task, "matrix/test");
    liveRef.current.phase = "verifying";
    liveRef.current.verifyTests = {
      cmd: current.test.display,
      results: [],
      running: true,
      output: [],
      outputLineCount: 0,
      outputTruncated: false,
    };
    bumpLive(true);
    const abortController = new AbortController();
    testAbortRef.current = abortController;
    try {
      const result = await runTests(current.test, {
        cwd: current.test.cwd,
        signal: abortController.signal,
        requestTestApproval,
        onLine: (line) => {
          if (!liveRef.current) return;
          liveRef.current.verifyLines.push(String(line ?? ""));
          if (liveRef.current.verifyLines.length > RETAINED_OUTPUT_LIMIT)
            liveRef.current.verifyLines.shift();
          if (liveRef.current.verifyTests) {
            liveRef.current.verifyTests.output = liveRef.current.verifyLines;
            liveRef.current.verifyTests.outputLineCount =
              (liveRef.current.verifyTests.outputLineCount ?? 0) + 1;
            liveRef.current.verifyTests.outputTruncated =
              liveRef.current.verifyTests.outputLineCount > liveRef.current.verifyLines.length;
          }
          bumpLive();
        },
      });
      const { normalized, message } = projectDirectTestResult(result, {
        aborted: abortController.signal.aborted,
      });
      liveRef.current = null;
      const next = appendHistory(historyRef.current, message);
      historyRef.current = next;
      setHistory(next);
      setRunning(false);
      bumpLive(true);
      flash(normalized.ok ? message.summary : (normalized.failure ?? message.summary));
      saveRef.current?.(next, message.metrics);
    } catch (error) {
      liveRef.current = null;
      setRunning(false);
      bumpLive(true);
      flash(`test runner failed: ${error.message}`, 8000);
    } finally {
      if (testAbortRef.current === abortController) testAbortRef.current = null;
    }
  }, [bumpLive, flash, refreshProject, requestTestApproval]);

  const openScope = useCallback(
    (fileHint = null) => {
      const context = lastContext(historyRef.current, liveRef.current);
      const target = fileHint ?? context?.file ?? scopeFile ?? scopeFiles[0] ?? null;
      if (target) {
        setScopeFile(target);
        const index = scopeFiles.indexOf(target);
        if (index >= 0) setScopeSelection(0);
      }
      setScreen("scope");
    },
    [scopeFile, scopeFiles],
  );

  const cycleScopeFile = useCallback(
    (delta) => {
      if (scopeFiles.length === 0) {
        flash("no source files in this workspace");
        return;
      }
      const index = Math.max(0, scopeFiles.indexOf(scopeFile ?? scopeFiles[0]));
      const next = (index + delta + scopeFiles.length) % scopeFiles.length;
      setScopeFile(scopeFiles[next]);
      setScopeSelection(0);
      flash(`scope · ${scopeFiles[next]}`, 2000);
    },
    [flash, scopeFile, scopeFiles],
  );

  const cycleVision = useCallback((delta = 1) => {
    setVisionMode((current) => {
      const index = VISION_MODES.indexOf(current);
      return VISION_MODES[(index + delta + VISION_MODES.length) % VISION_MODES.length];
    });
  }, []);

  const exportVision = useCallback(() => {
    try {
      const graph = buildVisionCanvas({
        mode: visionMode,
        parsed: scopeData.parsed,
        file: scopeData.file ?? "vision",
        activeLine: lastContext(historyRef.current, liveRef.current)?.line ?? 1,
        project,
        usage: tokenStatsRef.current,
        metrics,
        testResult: lastVerification(historyRef.current, liveRef.current),
        modelName: modelRef.current?.name ?? "LOCAL",
        width,
        rows: Math.max(8, height - 9),
      });
      const stamp = new Date()
        .toISOString()
        .replace(/[-:.TZ]/g, "")
        .slice(0, 15);
      const path = `${matrixHome()}/vision-${stamp}.png`;
      const written = writePng(graph.canvas, path);
      setVisionStatus(
        `exported ${written.path} · ${written.width}×${written.height} · ${written.bytes} bytes`,
      );
      flash(`PNG written · ${written.path}`, 6000);
    } catch (error) {
      setVisionStatus(`export failed: ${error.message}`);
      flash(`PNG export failed: ${error.message}`, 6000);
    }
  }, [flash, height, metrics, project, scopeData, visionMode, width]);

  const runUndo = useCallback(async () => {
    const result = controller.undoLast();
    // A partial undo has already changed disk and the pending recovery stack;
    // persist that journal before reporting the failure so resume can retry it.
    if (result.ok || result.restored?.length > 0) {
      saveRef.current?.();
      await refreshProject();
      saveRef.current?.();
    }
    if (!result.ok) {
      const prefix =
        result.restored?.length > 0
          ? `partial undo · restored ${result.restored.join(", ")} · `
          : "";
      const retry =
        result.pending?.length > 0 ? ` · pending ${result.pending.join(", ")}; retry /undo` : "";
      flash(`${prefix}${result.error}${retry}`, 8000);
      return;
    }
    flash(`restored ${result.files.join(", ")}`);
  }, [controller, flash, refreshProject]);

  const showSession = useCallback(() => {
    const sessions = listSessions({
      onWarning: (warning) => flash(`session warning: ${warning.message}`, 5000),
    });
    const latest = sessions[0];
    const lines = [
      `workspace  ${project?.name ?? "no workspace"}`,
      `root       ${project?.root ?? cwd}`,
      `branch     ${project?.branch ?? "not a git repository"}`,
      `files      ${project?.fileCount ?? 0}${project?.truncated ? " (index truncated)" : ""}`,
      `tests      ${project?.test?.display ?? "none detected"}`,
      `model      ${model.name} · ${model.id}`,
      `session    ${sessionId}`,
      `messages   ${historyRef.current.length}`,
      `tokens     ↑${tokenStats.inputTokens} ↓${tokenStats.outputTokens} · ${formatCost(tokenStats.cost)}${model.remote ? ` · ${tokenStats.costProvenance ?? "legacy"}${Number.isFinite(tokenStats.cost) && tokenStats.costComplete === false ? " · partial" : ""}` : ""}`,
      `sessions   ${sessions.length} saved · ${latest ? latest.id : "none"}`,
      `home       ${matrixHome()}`,
    ];
    const message = {
      id: `session-${Date.now()}`,
      role: "system",
      content: lines.join("\n"),
      timestamp: Date.now(),
    };
    const next = appendHistory(historyRef.current, message);
    historyRef.current = next;
    setHistory(next);
    setScreen("chat");
  }, [model, project, sessionId, tokenStats, flash]);

  const runDoctorCommand = useCallback(async () => {
    try {
      const report = await runDoctorAsync({ cwd, stdout: process.stdout });
      const text = formatDoctor(report, { color: false });
      const message = {
        id: `doctor-${Date.now()}`,
        role: "assistant",
        content: text,
        modelName: "matrix doctor",
        timestamp: Date.now(),
      };
      const next = appendHistory(historyRef.current, message);
      historyRef.current = next;
      setHistory(next);
      setScreen("chat");
    } catch (error) {
      flash(`doctor failed: ${error.message}`);
    }
  }, [cwd, flash]);

  const handleSlash = useCallback(
    async (value) => {
      const [head, ...rest] = value.trim().split(/\s+/);
      const arg = rest.join(" ").trim();
      switch (head) {
        case "/help":
          setReturnScreen(screenRef.current === "help" ? "chat" : screenRef.current);
          setHelpScroll(0);
          setScreen("help");
          break;
        case "/new": {
          const next = [];
          historyRef.current = next;
          setHistory(next);
          setInputState(createInputState("", []));
          setScreen("empty");
          setChatScroll(0);
          setOutputExpanded(false);
          setPermission(null);
          setTokenStats({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 });
          setMetrics({});
          setSessionId(newRunId());
          controller.clearUndo();
          setAutoApprove(false);
          autoApproveRef.current = false;
          flash("new session");
          break;
        }
        case "/clear": {
          historyRef.current = [];
          setHistory([]);
          setInputState((previous) => createInputState("", previous.history));
          setScreen("empty");
          setChatScroll(0);
          setOutputExpanded(false);
          flash("transcript cleared");
          break;
        }
        case "/test":
          await runTestsDirect();
          break;
        case "/auto": {
          if (runningRef.current) {
            flash("auto-approve can be changed between runs");
            break;
          }
          const next = !autoApproveRef.current;
          setAutoApprove(next);
          autoApproveRef.current = next;
          flash(`auto-approve ${next ? "on for the next run" : "off"}`);
          break;
        }
        case "/diff":
          if (permissionRef.current) {
            setScreen("permission");
          } else {
            const last = historyRef.current.findLast?.((message) => message.editFile);
            if (last?.editFile) {
              setPermission({
                file: last.editFile.path,
                scope: last.editFile.scope,
                patch: last.editFile.patch ?? last.editFile.diff?.join("\n"),
                hunks: last.editFile.hunks,
                stats: last.editFile.stats,
                reason: "last applied patch",
                status: last.editFile.status,
              });
              setScreen("permission");
            } else {
              flash("no patch in this session yet");
            }
          }
          break;
        case "/chat":
          setScreen(historyRef.current.length > 0 ? "chat" : "empty");
          break;
        case "/scope":
        case "/ast":
          openScope();
          break;
        case "/swarm":
          setScreen("swarm");
          break;
        case "/plan":
          setScreen("swarm");
          setSwarmState((previous) => ({ ...previous, focusedLane: 0 }));
          break;
        case "/vision":
          setScreen("vision");
          if (arg && VISION_MODES.includes(arg)) setVisionMode(arg);
          break;
        case "/export":
          exportVision();
          break;
        case "/thoughts":
        case "/reasoning":
          setThoughtsExpanded((value) => {
            const next = !value;
            flash(next ? "reasoning thoughts expanded" : "reasoning thoughts collapsed");
            return next;
          });
          break;
        case "/model":
          if (arg) {
            const picked = findPickerModel(pickerModels, arg);
            const found = picked ?? resolveModel(arg);
            if (
              found &&
              (picked ||
                found !== LOCAL_MODEL ||
                arg.toLowerCase().includes("local") ||
                arg.toLowerCase().includes("forge"))
            ) {
              selectModel(found);
              flash(`model · ${found.name}${found.custom ? ` · ${found.providerName}` : ""}`);
              break;
            }
          }
          setHasKey(checkCredentialAvailability(modelRef.current.id));
          setReturnScreen(screenRef.current);
          setPickerIndex(pickerIndexFor(pickerModels, modelRef.current));
          setScreen("model");
          break;
        case "/undo":
          runUndo();
          break;
        case "/session":
          showSession();
          break;
        case "/doctor":
          await runDoctorCommand();
          break;
        case "/quit":
          saveRef.current?.();
          exit();
          break;
        default:
          flash(`unknown command ${head} · /help for the list`);
      }
    },
    [
      checkCredentialAvailability,
      controller,
      exit,
      flash,
      openScope,
      pickerModels,
      resetAutoApprove,
      runDoctorCommand,
      runTestsDirect,
      runUndo,
      selectModel,
      showSession,
    ],
  );

  const submitInput = useCallback(() => {
    if (runningRef.current) {
      flash("run active · Ctrl+C aborts it");
      return;
    }
    const matches = slashMatches(inputState.value);
    if (matches.length > 0 && !inputState.value.trim().includes(" ")) {
      const exact = matches.find((item) => item.name === inputState.value.trim());
      const chosen = exact ?? matches[Math.min(slashIndex, matches.length - 1)] ?? matches[0];
      if (!exact) {
        const { state: next } = submit(setValue(inputState, chosen.name));
        setInputState(next);
        handleSlash(chosen.name);
        return;
      }
    }
    const { state: next, value } = submit(inputState);
    if (!value) return;
    setInputState(next);
    if (value.startsWith("/")) {
      handleSlash(value);
      return;
    }
    startTask(value);
  }, [flash, handleSlash, inputState, slashIndex, startTask]);

  const toggleOutput = useCallback(() => {
    if (!hasRetainedVerificationOutput(historyRef.current, liveRef.current)) {
      flash("no retained test output");
      return;
    }
    setScreen("chat");
    setChatScroll(0);
    setOutputExpanded((value) => {
      const next = !value;
      flash(next ? "retained output expanded · PgUp/PgDn scroll" : "retained output collapsed");
      return next;
    });
  }, [flash]);

  const toggleModelPicker = useCallback(() => {
    if (screenRef.current === "model") {
      setScreen(returnScreen);
      return;
    }
    setHasKey(modelAvailability(modelRef.current));
    setReturnScreen(screenRef.current);
    setPickerIndex(pickerIndexFor(pickerModels, modelRef.current));
    setScreen("model");
  }, [modelAvailability, pickerModels, returnScreen]);

  useEffect(() => {
    if (screen !== "model")
      setManualPicker((previous) =>
        previous.active ? { ...previous, active: false, text: "", error: "" } : previous,
      );
  }, [screen]);

  const beginManualPicker = useCallback(() => {
    const chosen = pickerModels[Math.min(Math.max(0, pickerIndex), pickerModels.length - 1)];
    if (!chosen) return;
    setManualPicker({
      active: true,
      text: "",
      error: "",
      providerId: chosen.providerId ?? chosen.provider ?? "matrix",
      providerName: chosen.providerName ?? chosen.provider ?? "this provider",
    });
  }, [pickerIndex, pickerModels]);

  const submitManualPicker = useCallback(() => {
    const providerId = manualPicker.providerId;
    const query = manualPicker.text;
    if (!providerId) return;
    if (manualPicker.error) return;
    if (!query.trim()) {
      setManualPicker((previous) => ({ ...previous, error: "enter an exact model id" }));
      return;
    }
    try {
      const target = resolveProviderSelection({
        providerId,
        modelQuery: query,
        config: providerConfig,
      }).target;
      const available =
        target.kind === "custom"
          ? isProviderCredentialAvailable(target, process.env)
          : target.kind === "builtin"
            ? target.providerId === "ollama" || target.providerId === "matrix"
              ? true
              : checkCredentialAvailability(target.modelId)
            : true;
      const candidate = pickerModelFromTarget(target, {
        source: "manual",
        available,
        description: `Manual exact model on ${target.providerName}`,
        observation: pickerObservation(target, providerConfig),
      });
      const existing = pickerModels.find((entry) => pickerKeyFor(entry) === candidate.pickerKey);
      const chosen = target.kind === "custom" && existing ? existing : candidate;
      if (chosen === candidate) {
        setExtraPickerModels((previous) =>
          [
            ...previous.filter((entry) => pickerKeyFor(entry) !== candidate.pickerKey),
            candidate,
          ].slice(-MAX_MANUAL_PICKER_MODELS),
        );
      }
      const selected = selectModel(chosen);
      setManualPicker({ active: false, text: "", error: "", providerId: null, providerName: null });
      setScreen(returnScreen);
      if (chosen.remote && !selected) {
        flash(`${chosen.name} needs a key for ${chosen.providerName ?? "this provider"}`, 7000);
      } else {
        flash(`model · ${chosen.name} · ${chosen.providerName}`);
      }
    } catch (error) {
      setManualPicker((previous) => ({
        ...previous,
        error: error?.message ?? "could not resolve that provider model",
      }));
    }
  }, [
    checkCredentialAvailability,
    flash,
    manualPicker.providerId,
    manualPicker.error,
    manualPicker.text,
    pickerModels,
    providerConfig,
    returnScreen,
    selectModel,
  ]);

  const reloadProviderPicker = useCallback(() => {
    const home = matrixHome();
    const loaded = loadProviderConfig({ home });
    const config = loaded.status === "valid" ? loaded.config : null;
    const catalog = buildProviderCatalog({ home, env: process.env, loaded });
    const focused = pickerModels[pickerIndex];
    const current = modelRef.current;
    const nextModels = buildPickerModels({ catalog, config });
    const nextIndex = nextModels.findIndex(
      (entry) => pickerKeyFor(entry) === pickerKeyFor(focused),
    );
    setProviderConfig(config);
    setProviderCatalog(catalog);
    setExtraPickerModels([]);
    setPickerIndex(nextIndex >= 0 ? nextIndex : 0);
    if (current?.custom) {
      const profile = config?.providers.find((entry) => entry.id === current.providerId);
      if (!profile || targetDigest(profile) !== current.providerTarget?.configDigest) {
        selectModel({
          ...current,
          targetError: "provider configuration changed; reselect a model",
        });
      } else {
        const replacement = nextModels.find(
          (entry) => pickerKeyFor(entry) === pickerKeyFor(current),
        );
        if (replacement) selectModel(replacement);
        else {
          const target = resolveProviderSelection({
            providerId: profile.id,
            modelQuery: current.id,
            config,
          }).target;
          const manual = pickerModelFromTarget(target, {
            source: "manual",
            available: isProviderCredentialAvailable(target, process.env),
            observation: pickerObservation(target, config),
          });
          setExtraPickerModels([manual]);
          selectModel(manual);
        }
      }
    }
    flash(
      loaded.status === "invalid"
        ? `provider reload failed · ${loaded.error.message}`
        : "providers reloaded",
      7000,
    );
  }, [flash, pickerIndex, pickerModels, selectModel]);

  const savePickerModel = useCallback(async () => {
    const chosen = pickerModels[Math.min(Math.max(0, pickerIndex), pickerModels.length - 1)];
    if (!chosen?.custom || !chosen.providerTarget || chosen.targetError) {
      flash("select a custom provider model to save", 7000);
      return;
    }
    try {
      const home = matrixHome();
      const loaded = loadProviderConfig({ home });
      if (loaded.status !== "valid") throw new Error("provider configuration is unavailable");
      const profile = loaded.config.providers.find((entry) => entry.id === chosen.providerId);
      if (!profile || targetDigest(profile) !== chosen.providerTarget.configDigest) {
        throw new Error("provider configuration changed; reload and reselect");
      }
      await addProviderModel(
        profile.id,
        { id: chosen.id },
        { home, expectedDigest: loaded.digest },
      );
      reloadProviderPicker();
      flash(`saved ${chosen.id} to ${profile.name}`, 7000);
    } catch (error) {
      flash(`could not save model · ${error?.message ?? "unknown error"}`, 7000);
    }
  }, [flash, pickerIndex, pickerModels, reloadProviderPicker]);

  useInput((ch, key) => {
    const mouse = parseTerminalMouse(ch);
    if (mouse) {
      if (mouse.direction === "up") {
        if (screen === "chat" || screen === "empty") {
          setChatScroll((offset) =>
            Math.min(Math.max(0, chatBounds.total - chatBounds.height), offset + 3),
          );
        } else if (screen === "permission" && commandTrustRequest) {
          setCommandTrustScroll((offset) => Math.max(0, offset - 3));
        } else if (screen === "permission" && testTrustRequest) {
          setTestTrustScroll((offset) => Math.max(0, offset - 3));
        } else if (screen === "permission") {
          setPermissionScroll((offset) => Math.max(0, offset - 3));
        } else if (screen === "model") {
          setPickerIndex((index) => (index - 1 + pickerModels.length) % pickerModels.length);
        } else if (screen === "scope") {
          setScopeSelection((index) => Math.max(0, index - 1));
        } else if (screen === "swarm") {
          setSwarmState((previous) => focusLane(previous, -1));
        } else if (screen === "vision") {
          cycleVision(-1);
        }
      } else if (mouse.direction === "down") {
        if (screen === "chat" || screen === "empty") {
          setChatScroll((offset) => Math.max(0, offset - 3));
        } else if (screen === "permission" && commandTrustRequest) {
          const bounds = commandTrustBoundsRef.current;
          setCommandTrustScroll((offset) => Math.min(bounds.maxOffset, offset + 3));
        } else if (screen === "permission" && testTrustRequest) {
          const bounds = testTrustBoundsRef.current;
          setTestTrustScroll((offset) => Math.min(bounds.maxOffset, offset + 3));
        } else if (screen === "permission") {
          setPermissionScroll((offset) =>
            Math.min(Math.max(0, permissionBounds.total - permissionBounds.height), offset + 3),
          );
        } else if (screen === "model") {
          setPickerIndex((index) => (index + 1) % pickerModels.length);
        } else if (screen === "scope") {
          const scopes = (scopeData.parsed?.flat ?? []).filter((item) => item.kind !== "module");
          setScopeSelection((index) => Math.min(Math.max(0, scopes.length - 1), index + 1));
        } else if (screen === "swarm") {
          setSwarmState((previous) => focusLane(previous, 1));
        } else if (screen === "vision") {
          cycleVision(1);
        }
      }
      return;
    }

    // Exact-ID entry owns printable keys while active; Ctrl+C still falls
    // through to the ordinary abort/quit path.
    if (screen === "model" && manualPicker.active && !(key.ctrl && ch === "c")) {
      if (key.escape) {
        setManualPicker({
          active: false,
          text: "",
          error: "",
          providerId: null,
          providerName: null,
        });
        return;
      }
      if (key.return) {
        submitManualPicker();
        return;
      }
      if (key.backspace || key.delete) {
        setManualPicker((previous) => ({
          ...previous,
          text: previous.text.slice(0, -1),
          error: "",
        }));
        return;
      }
      if (typeof ch === "string" && ch.length > 0 && !key.ctrl && !key.meta) {
        const printable = Array.from(ch)
          .filter((character) => character >= " " && character !== "\x7f")
          .join("");
        if (printable) {
          setManualPicker((previous) => {
            const text = `${previous.text}${printable}`;
            return text.length > PROVIDER_LIMITS.modelIdChars
              ? {
                  ...previous,
                  error: `model ID exceeds ${PROVIDER_LIMITS.modelIdChars} characters`,
                }
              : { ...previous, text, error: "" };
          });
        }
        return;
      }
      return;
    }

    const slashCount = key.upArrow || key.downArrow ? slashMatches(inputState.value).length : 0;
    const scopeCount =
      screen === "scope" && inputState.value.length === 0 && (key.upArrow || key.downArrow)
        ? (scopeData.parsed?.flat ?? []).filter((item) => item.kind !== "module").length
        : 0;
    const action = decideKeyboard(
      {
        screen,
        inputValue: inputState.value,
        permission,
        commandTrustActive: Boolean(commandTrustRequest),
        testTrustActive: Boolean(testTrustRequest),
        permissionResolved: permissionResolved.current,
        running: runningRef.current,
        chatBounds,
        permissionBounds,
        helpBounds: helpBoundsRef.current,
        commandTrustBounds: commandTrustBoundsRef.current,
        testTrustBounds: testTrustBoundsRef.current,
        slashMatchCount: slashCount,
        scopeCount,
        hasLiveEdit: Boolean(liveRef.current?.editFile),
      },
      ch,
      key,
    );

    switch (action.type) {
      case "ctrl-c": {
        if (commandTrustRequest) {
          if (runningRef.current) controller.abort();
          settleCommandTrust("n");
          return;
        }
        if (testTrustRequest) {
          if (runningRef.current) {
            if (testAbortRef.current) testAbortRef.current.abort();
            else controller.abort();
          }
          settleTestTrust("n");
          return;
        }
        if (runningRef.current) {
          if (testAbortRef.current) {
            testAbortRef.current.abort();
            flash("aborting test run…");
          } else {
            controller.abort();
            flash("aborting run…");
          }
        } else {
          saveRef.current?.();
          exit();
        }
        return;
      }
      case "primary-view": {
        if (action.screen === "permission") {
          const overlay = commandTrustRequest || testTrustRequest || permission;
          setScreen(overlay ? "permission" : "chat");
          if (!overlay) flash("no approval waiting");
        } else if (action.screen === "scope") {
          openScope();
        } else {
          setScreen(action.screen);
        }
        return;
      }
      case "screen":
        setScreen(action.screen);
        return;
      case "picker-step":
        setPickerIndex(
          (index) => (index + action.delta + pickerModels.length) % pickerModels.length,
        );
        return;
      case "picker-page":
        setPickerIndex((index) =>
          action.delta < 0
            ? Math.max(0, index + action.delta)
            : Math.min(pickerModels.length - 1, index + action.delta),
        );
        return;
      case "picker-edge":
        setPickerIndex(action.edge === "home" ? 0 : pickerModels.length - 1);
        return;
      case "picker-manual-start":
        beginManualPicker();
        return;
      case "picker-reload":
        reloadProviderPicker();
        return;
      case "picker-save-model":
        void savePickerModel();
        return;
      case "model-select": {
        const chosen = pickerModels[Math.min(Math.max(0, pickerIndex), pickerModels.length - 1)];
        if (chosen?.providerPlaceholder) {
          flash("press e to enter an exact model ID for this provider", 7000);
          return;
        }
        const available = selectModel(chosen);
        setScreen(returnScreen);
        if (chosen.custom && !chosen.providerTarget) {
          flash(
            `${chosen.providerName} is unavailable · ${chosen.targetError ?? "configuration could not be resolved"}`,
            7000,
          );
        } else if (chosen.remote && !available) {
          flash(
            `${chosen.name} needs a key for ${chosen.providerName ?? "OpenRouter"} · Local Forge remains available`,
            7000,
          );
        } else {
          flash(
            `model · ${chosen.name}${chosen.custom ? ` · ${chosen.providerName}` : chosen.free ? " · free tier" : ""}`,
          );
        }
        return;
      }
      case "return-screen":
        setScreen(returnScreen);
        return;
      case "command-trust":
        settleCommandTrust(action.decision);
        return;
      case "test-trust":
        settleTestTrust(action.decision);
        return;
      case "approve": {
        permissionResolved.current = true;
        if (action.decision === "a") {
          setAutoApprove(true);
          autoApproveRef.current = true;
        }
        setPermission((previous) =>
          previous
            ? { ...previous, status: action.decision === "n" ? "denied" : "approved" }
            : previous,
        );
        setScreen("chat");
        controller.approve(action.decision);
        flash(
          action.decision === "n"
            ? "patch denied · file unchanged"
            : action.decision === "a"
              ? "approved · auto-approve enabled"
              : "approved · writing file",
        );
        return;
      }
      case "escape-permission":
        if (permission.status === "pending") {
          permissionResolved.current = true;
          setPermission((previous) => (previous ? { ...previous, status: "denied" } : previous));
          setScreen("chat");
          controller.approve("n");
        } else {
          setScreen("chat");
        }
        return;
      case "toggle-diff":
        setDiffExpanded((value) => !value);
        return;
      case "toggle-thoughts":
        setThoughtsExpanded((value) => !value);
        return;
      case "scroll": {
        const setter =
          action.target === "help"
            ? setHelpScroll
            : action.target === "command-trust"
              ? setCommandTrustScroll
              : action.target === "test-trust"
                ? setTestTrustScroll
                : action.target === "permission"
                  ? setPermissionScroll
                  : setChatScroll;
        if (action.absolute !== undefined) setter(action.absolute);
        else setter((offset) => Math.min(action.maxOffset, Math.max(0, offset + action.delta)));
        return;
      }
      case "focus-lane":
        setSwarmState((previous) => focusLane(previous, action.delta));
        return;
      case "cycle-scope":
        cycleScopeFile(action.delta);
        return;
      case "cycle-vision":
        cycleVision(action.delta);
        return;
      case "scope-selection":
        setScopeSelection((index) =>
          Math.min(Math.max(0, action.scopeCount - 1), Math.max(0, index + action.delta)),
        );
        return;
      case "toggle-output":
        toggleOutput();
        return;
      case "open-help":
        setReturnScreen(screenRef.current);
        setHelpScroll(0);
        setScreen("help");
        return;
      case "toggle-model":
        toggleModelPicker();
        return;
      case "undo":
        if (controller.canUndo()) runUndo();
        else flash("no applied patch to undo");
        return;
      case "escape":
        if (runningRef.current) {
          if (testAbortRef.current) {
            testAbortRef.current.abort();
            flash("aborting test run…");
          } else {
            controller.abort();
            flash("aborting run…");
          }
        } else if (screen !== "chat" && screen !== "empty") {
          setScreen(historyRef.current.length > 0 ? "chat" : "empty");
        } else if (inputState.value) {
          setInputState((previous) => setValue(previous, ""));
        }
        return;
      case "tab": {
        const completed = completeSlash(inputState);
        if (completed && completed.value !== inputState.value) setInputState(completed);
        else setInputState((previous) => insertText(previous, "  "));
        return;
      }
      case "slash-step":
        setSlashIndex((index) => (index + action.delta + slashCount) % slashCount);
        return;
      case "submit":
        submitInput();
        return;
      case "input":
        setInputState((previous) => applyKeyboardInput(previous, action));
        return;
      default:
        return;
    }
  });

  usePaste((text) => {
    if (text) setInputState((previous) => insertText(previous, text));
  });

  useEffect(() => {
    if (startedInitial.current) return;
    startedInitial.current = true;
    if (initialTask) {
      const task = String(initialTask);
      const timer = setTimeout(() => startTask(task), 60);
      return () => clearTimeout(timer);
    }
    if (initialHistory.length > 0) setScreen("chat");
  }, [initialHistory.length, initialTask, startTask]);

  useEffect(() => {
    return () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
      if (liveTimer.current) clearTimeout(liveTimer.current);
      saveRef.current?.();
      controller.dispose();
    };
  }, [controller]);

  const live = running && liveRef.current ? { ...liveRef.current } : null;
  const historicalContext = useMemo(() => lastContext(history, null), [history]);
  const historicalVerification = useMemo(() => lastVerification(history, null), [history]);
  const context =
    live && (live.editFile?.path || live.readFile?.path)
      ? lastContext([live], null)
      : historicalContext;
  const activeLine = context?.line ?? 1;
  const testResult = live?.verifyTests ? live.verifyTests : historicalVerification;
  const slashRows =
    !running &&
    !["permission", "model", "help"].includes(screen) &&
    slashMatches(inputState.value).length > 0
      ? Math.min(5, slashMatches(inputState.value).length)
      : 0;
  const showInput = !["permission", "model", "help"].includes(screen);
  const fixedRows = 3 + 1 + 1 + (showInput ? 3 : 0) + slashRows;
  const contentHeight = Math.max(3, height - fixedRows);
  const chatScrollInfo =
    chatBounds.total > chatBounds.height
      ? {
          start: Math.max(
            1,
            chatBounds.total -
              chatBounds.height -
              Math.min(chatScroll, chatBounds.total - chatBounds.height) +
              1,
          ),
          end: Math.max(
            1,
            chatBounds.total - Math.min(chatScroll, chatBounds.total - chatBounds.height),
          ),
          total: chatBounds.total,
        }
      : null;

  useEffect(() => {
    if (screen !== "chat" && screen !== "empty") setChatScroll(0);
  }, [screen]);

  return h(
    Box,
    { flexDirection: "column", height, paddingX: 1 },
    h(Header, {
      screen,
      model,
      project,
      running,
      waiting:
        screen === "permission" &&
        (Boolean(commandTrustRequest) ||
          Boolean(testTrustRequest) ||
          (permission?.status ?? "pending") === "pending"),
      phase: live?.phase ?? "idle",
      tokenStats,
      commandTrust: Boolean(commandTrustRequest),
      testTrust: Boolean(testTrustRequest),
    }),
    h(
      Box,
      { height: contentHeight, flexShrink: 0, overflow: "hidden" },
      h(ScreenView, {
        screen,
        width,
        height: contentHeight,
        project,
        model,
        history,
        live,
        prompt: live?.prompt ?? "",
        frame,
        permission,
        permissionExpanded: diffExpanded,
        permissionScroll,
        onPermissionBounds: setPermissionBounds,
        commandTrustRequest,
        commandTrustScroll,
        onCommandTrustBounds: reportCommandTrustBounds,
        testTrustRequest,
        testTrustScroll,
        onTestTrustBounds: reportTestTrustBounds,
        helpScroll,
        onHelpBounds: reportHelpBounds,
        chatScroll,
        onChatBounds: setChatBounds,
        thoughtsExpanded,
        diffExpanded,
        outputExpanded,
        swarmState,
        scopeFile: scopeData.file,
        scopeSource: scopeData.source,
        scopeParsed: scopeData.parsed,
        scopeSelection,
        scopeFiles,
        visionMode,
        activeLine,
        usage: live?.usage ?? tokenStats,
        metrics: live?.metrics ?? metrics,
        testResult,
        modelName: model.name,
        visionStatus,
        models: pickerModels,
        activeKey: pickerKeyFor(model),
        pickerIndex,
        hasKey,
        manual: manualPicker.active
          ? {
              providerName: manualPicker.providerName,
              text: manualPicker.text,
              error: manualPicker.error,
            }
          : null,
        session: initialSession,
        status,
      }),
    ),
    slashRows > 0
      ? h(SlashMenu, {
          value: inputState.value,
          selected: slashIndex,
          width,
          maxRows: slashRows,
        })
      : null,
    showInput
      ? h(InputBar, {
          input: inputState,
          placeholder:
            screen === "permission"
              ? "awaiting decision"
              : running
                ? "agent running · Ctrl+C aborts"
                : "Describe a task, or type / for commands",
          disabled: false,
          running,
          phase: live?.phase ?? "idle",
          autoApprove: commandTrustRequest || testTrustRequest ? false : autoApprove,
        })
      : null,
    h(StatusBar, {
      screen,
      model,
      running,
      status,
      cols,
      scroll: chatScrollInfo,
      autoApprove: commandTrustRequest || testTrustRequest ? false : autoApprove,
    }),
    h(KeyHints, {
      screen,
      running,
      waiting:
        screen === "permission" &&
        (Boolean(commandTrustRequest) ||
          Boolean(testTrustRequest) ||
          (permission?.status ?? "pending") === "pending"),
      autoApprove: commandTrustRequest || testTrustRequest ? false : autoApprove,
      cols,
      commandTrust: Boolean(commandTrustRequest),
      testTrust: Boolean(testTrustRequest),
    }),
  );
}

// Legacy exports kept for renderers and external callers.
export { Frame } from "./frame.mjs";
export { ScreenView, ScreenView as MatrixScreens, accumulateTokenStats };
export {
  formatCodeBlock,
  formatTokens,
  renderContentWithCodeBlocks,
  renderEditFileCard,
  renderPlanCard,
  renderReadFileCard,
  renderThoughtCard,
  renderVerifyTestsCard,
};
export { ChatScreen, buildChatLines } from "./screens/chat.mjs";
export { buildPermissionLines } from "./screens/permission.mjs";
export { buildCommandTrustLines } from "./screens/command-trust.mjs";
export { buildVisionCanvas, SCREENS };
