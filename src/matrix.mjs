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
import { LOCAL_MODEL, MODELS, formatCost, modelIndex, resolveModel } from "../lib/models.mjs";
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

// ---------------------------------------------------------------------------
// MatrixApp
// ---------------------------------------------------------------------------

export function MatrixApp({
  cwd = process.cwd(),
  initialTask = "",
  initialModel = null,
  initialSession = null,
  autoApprove: initialAutoApprove = false,
  offline = false,
  enableCommands = false,
  checkCredentialAvailability = isOpenRouterAvailable,
} = {}) {
  const { exit } = useApp();
  const { cols, height } = useLayout();
  const width = Math.max(20, cols - 2);

  const initialHistory = useMemo(() => historyFromSession(initialSession), [initialSession]);
  const [project, setProject] = useState(null);
  const [model, setModel] = useState(() =>
    resolveModel(offline ? "local" : (initialModel ?? initialSession?.modelId ?? "local")),
  );
  const [hasKey, setHasKey] = useState(() => checkCredentialAvailability(model.id));
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
  const [pickerIndex, setPickerIndex] = useState(() => modelIndex(model.id));
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
      const available = checkCredentialAvailability(chosen.id);
      modelRef.current = chosen;
      setModel(chosen);
      setHasKey(available);
      return available;
    },
    [checkCredentialAvailability],
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
            const found = resolveModel(arg);
            if (
              found &&
              (found !== LOCAL_MODEL ||
                arg.toLowerCase().includes("local") ||
                arg.toLowerCase().includes("forge"))
            ) {
              selectModel(found);
              flash(`model · ${found.name}`);
              break;
            }
          }
          setHasKey(checkCredentialAvailability(modelRef.current.id));
          setReturnScreen(screenRef.current);
          setPickerIndex(modelIndex(modelRef.current?.id));
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
    setHasKey(checkCredentialAvailability(modelRef.current.id));
    setReturnScreen(screenRef.current);
    setPickerIndex(modelIndex(modelRef.current?.id));
    setScreen("model");
  }, [checkCredentialAvailability, returnScreen]);

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
          setPickerIndex((index) => (index - 1 + MODELS.length) % MODELS.length);
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
          setPickerIndex((index) => (index + 1) % MODELS.length);
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
        setPickerIndex((index) => (index + action.delta + MODELS.length) % MODELS.length);
        return;
      case "picker-page":
        setPickerIndex((index) =>
          action.delta < 0
            ? Math.max(0, index + action.delta)
            : Math.min(MODELS.length - 1, index + action.delta),
        );
        return;
      case "picker-edge":
        setPickerIndex(action.edge === "home" ? 0 : MODELS.length - 1);
        return;
      case "model-select": {
        const chosen = MODELS[Math.min(Math.max(0, pickerIndex), MODELS.length - 1)];
        const available = selectModel(chosen);
        setScreen(returnScreen);
        if (chosen.remote && !available) {
          flash(`${chosen.name} needs an OpenRouter key · Local Forge remains available`, 7000);
        } else {
          flash(`model · ${chosen.name}${chosen.free ? " · free tier" : ""}`);
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
        models: MODELS,
        pickerIndex,
        hasKey,
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
