// ============================================================================
// Matrix — spatial agent workbench.
//
// This file is the orchestrator: real project detection, a real run controller,
// real swarm events, real session persistence, and six screens. The visual
// language is the existing forge theme; the behaviour underneath is no longer a
// simulation.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useAnimation, useApp, useInput, usePaste } from "ink";

import { forge } from "../lib/forge.mjs";
import { useLayout } from "../lib/term.mjs";
import { parseTerminalMouse } from "../lib/mouse.mjs";
import {
  backspace,
  completeSlash,
  createInputState,
  deleteForward,
  deleteWordLeft,
  historyNext,
  historyPrevious,
  insertText,
  killLine,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  setValue,
  slashMatches,
  submit,
} from "../lib/input.mjs";
import { detectProject, readFileSafe } from "../lib/project.mjs";
import { parseScopes, scopeAtLine } from "../lib/scope.mjs";
import { runTests } from "../lib/process.mjs";
import { isOpenRouterAvailable } from "../lib/openrouter.mjs";
import { LOCAL_MODEL, MODELS, estimateCost, formatCost, modelIndex, resolveModel } from "../lib/models.mjs";
import { createRunController } from "../lib/controller.mjs";
import { applySwarmEvent, createSwarmState, focusLane } from "../lib/swarm.mjs";
import { newRunId, saveSession, loadLatestSession, listSessions, matrixHome } from "../lib/session.mjs";
import { runDoctor, formatDoctor } from "../lib/doctor.mjs";
import { writePng } from "../lib/raster.mjs";
import { buildVisionCanvas, VISION_MODES, VisionScreen } from "./screens/vision.mjs";
import { buildChatLines, ChatScreen } from "./screens/chat.mjs";
import { buildPermissionLines, PermissionScreen } from "./screens/permission.mjs";
import { SwarmScreen } from "./screens/swarm.mjs";
import { ScopeScreen } from "./screens/scope.mjs";
import { EmptyScreen } from "./screens/empty.mjs";
import { ModelScreen } from "./screens/model.mjs";
import { HelpScreen } from "./screens/help.mjs";
import { Header, InputBar, KeyHints, SlashMenu, StatusBar } from "./screens/common.mjs";
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

const SCREENS = ["empty", "chat", "permission", "swarm", "scope", "vision"];
const DEFAULT_SCOPE_EXTENSIONS = new Set([
  ".py",
  ".pyi",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".rs",
  ".go",
  ".rb",
]);

function historyFromSession(session) {
  if (!session || !Array.isArray(session.history)) return [];
  return session.history
    .filter((message) => message && typeof message === "object" && message.role)
    .slice(-60)
    .map((message, index) => ({
      ...message,
      id: message.id ?? `resumed-${index}`,
      content: String(message.content ?? ""),
    }));
}

function promptHistoryFrom(history) {
  return history.filter((message) => message.role === "user").map((message) => message.content).slice(-60);
}

function sessionSnapshot({ project, history, model, tokenStats, metrics, lastPatch, cwd, sessionId, elapsedMs }) {
  return {
    id: sessionId,
    cwd,
    project: project
      ? {
          name: project.name,
          root: project.root,
          branch: project.branch,
          fileCount: project.fileCount,
          languages: project.languages?.slice(0, 8) ?? [],
          test: project.test?.display ?? null,
        }
      : null,
    modelId: model?.id ?? "local",
    history: history.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      summary: message.summary,
      reasoning: message.reasoning,
      plan: message.plan,
      readFile: message.readFile ? { ...message.readFile, absPath: undefined } : null,
      editFile: message.editFile
        ? {
            path: message.editFile.path,
            scope: message.editFile.scope,
            diff: message.editFile.diff,
            stats: message.editFile.stats,
            status: message.editFile.status,
            backupPath: message.editFile.backupPath,
          }
        : null,
      verifyTests: message.verifyTests,
      toolCards: message.toolCards,
      modelName: message.modelName,
      error: message.error,
      timestamp: message.timestamp,
    })),
    tokenStats,
    metrics,
    lastPatch: lastPatch
      ? {
          file: lastPatch.file,
          absPath: lastPatch.absPath,
          patch: lastPatch.patch,
          stats: lastPatch.stats,
          backupPath: lastPatch.backupPath,
          original: lastPatch.original,
          updatedText: lastPatch.updatedText,
          status: "applied",
        }
      : null,
    elapsedMs,
  };
}

function lastContext(history, live) {
  const messages = live ? [...history, live] : history;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.editFile?.path) {
      const line = message.editFile.hunks?.[0]?.oldStart ?? message.editFile.edits?.[0]?.startLine ?? 1;
      return { file: message.editFile.path, line, kind: "edit" };
    }
    if (message.readFile?.path) {
      return { file: message.readFile.path, line: message.readFile.line ?? 1, kind: "read" };
    }
  }
  return null;
}

function lastVerification(history, live) {
  const messages = live ? [...history, live] : history;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.verifyTests) return messages[i].verifyTests;
  }
  return null;
}

function scopeFilesFor(project) {
  if (!project) return [];
  return project.files
    .filter((file) => file.size < 220_000)
    .filter((file) => DEFAULT_SCOPE_EXTENSIONS.has(file.ext) || ["python", "javascript", "rust", "go", "ruby"].includes(file.language))
    .map((file) => file.rel)
    .slice(0, 400);
}

function makeLive(task, modelName) {
  return {
    prompt: task,
    task,
    reasoning: "",
    content: "",
    plan: [],
    activePlanIdx: 0,
    readFile: null,
    editFile: null,
    verifyTests: null,
    verifyLines: [],
    toolCards: [],
    phase: "planning",
    detail: "",
    usage: null,
    metrics: null,
    modelName,
    error: false,
    summary: "",
    streaming: true,
  };
}

function normalizeViewModel(screen) {
  if (screen === "ast") return "scope";
  if (screen === "perm") return "permission";
  return screen;
}

// ---------------------------------------------------------------------------
// ScreenView: one pure routing point shared by the live app and Frame.
// ---------------------------------------------------------------------------

export function ScreenView({
  screen = "chat",
  width = 78,
  height = 20,
  project = null,
  model = null,
  history = [],
  live = null,
  prompt = "",
  frame = 0,
  permission = null,
  permissionExpanded = false,
  permissionScroll = 0,
  onPermissionBounds = null,
  chatScroll = 0,
  onChatBounds = null,
  thoughtsExpanded = false,
  diffExpanded = false,
  swarmState = null,
  scopeFile = null,
  scopeSource = "",
  scopeParsed = null,
  scopeSelection = 0,
  scopeFiles = [],
  visionMode = "scope",
  activeLine = 1,
  usage = null,
  metrics = {},
  testResult = null,
  modelName = "LOCAL",
  visionStatus = "",
  models = MODELS,
  pickerIndex = 0,
  hasKey = false,
  session = null,
  animTime = null,
  status = "",
}) {
  const view = normalizeViewModel(screen);
  if (view === "empty") {
    return h(EmptyScreen, { project, model, session, animTime });
  }
  if (view === "permission") {
    return h(PermissionScreen, {
      proposal: permission,
      width,
      height,
      expanded: permissionExpanded,
      scrollOffset: permissionScroll,
      onBounds: onPermissionBounds,
    });
  }
  if (view === "swarm") {
    return h(SwarmScreen, { state: swarmState, width, height, frame });
  }
  if (view === "scope") {
    return h(ScopeScreen, {
      file: scopeFile,
      source: scopeSource,
      parsed: scopeParsed,
      selectedScopeIndex: scopeSelection,
      width,
      height,
      files: scopeFiles,
    });
  }
  if (view === "vision") {
    return h(VisionScreen, {
      mode: visionMode,
      parsed: scopeParsed,
      file: scopeFile,
      activeLine,
      project,
      usage,
      metrics,
      testResult,
      modelName,
      width,
      height,
      status: visionStatus,
    });
  }
  if (view === "model") {
    return h(ModelScreen, {
      models,
      selected: pickerIndex,
      activeId: model?.id ?? "local",
      hasKey,
      width,
      height,
    });
  }
  if (view === "help") {
    return h(HelpScreen, { width, height });
  }
  return h(ChatScreen, {
    history,
    live,
    prompt,
    width,
    height,
    frame,
    scrollOffset: chatScroll,
    onBounds: onChatBounds,
    thoughtsExpanded,
    diffExpanded,
  });
}

// A thin wrapper so ScreenView does not import the vision module's hook twice.
// ---------------------------------------------------------------------------
// Frame: presentational frame used by renderers, dumps and tests.
// ---------------------------------------------------------------------------

export function Frame(props) {
  const {
    screen = "empty",
    inputValue = "",
    model = MODELS[0],
    project = null,
    chatHistory = [],
    live = null,
    prompt = "",
    choice = null,
    isDiffExpanded = false,
    swarmState = null,
    scopeFile = null,
    scopeSource = "",
    scopeParsed = null,
    scopeSelection = 0,
    visionMode = "scope",
    animTime = 2000,
    status = "",
    frame = 0,
    thoughtsExpanded = false,
    tokenStats = null,
    chatScroll = 0,
  } = props;

  const { cols, height } = useLayout();
  const width = Math.max(20, cols - 2);
  const input = createInputState(inputValue);
  const view = normalizeViewModel(screen);
  const showInput = !["permission", "model", "help"].includes(view);
  const fixed = 3 + 1 + 1 + (showInput ? 3 : 0);
  const contentHeight = Math.max(3, height - fixed);
  const permission =
    props.permission ??
    (view === "permission" && props.proposal
      ? props.proposal
      : null);
  const waiting = view === "permission" && (permission?.status ?? "pending") === "pending";

  return h(
    Box,
    { flexDirection: "column", height, paddingX: 1 },
    h(Header, {
      screen: view,
      model,
      project,
      running: Boolean(live),
      waiting,
      phase: live?.phase ?? "idle",
      tokenStats,
    }),
    h(
      Box,
      { height: contentHeight, flexShrink: 0, overflow: "hidden" },
      h(ScreenView, {
        ...props,
        screen: view,
        width,
        height: contentHeight,
        history: chatHistory,
        permission,
        chatScroll,
        frame,
        thoughtsExpanded,
        diffExpanded: isDiffExpanded,
        swarmState,
        scopeFile,
        scopeSource,
        scopeParsed,
        scopeSelection,
        visionMode,
        status,
        animTime,
      })
    ),
    showInput ? h(InputBar, { input, placeholder: "Describe a task, or type / for commands" }) : null,
    h(StatusBar, {
      screen: view,
      model,
      running: Boolean(live),
      status: choice ? `decision: ${choice}` : status,
      cols,
    }),
    h(KeyHints, { screen: view, running: Boolean(live), waiting, cols })
  );
}

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
} = {}) {
  const { exit } = useApp();
  const { cols, height } = useLayout();
  const { frame } = useAnimation({ interval: 90, isActive: true });
  const width = Math.max(20, cols - 2);

  const initialProject = useMemo(() => detectProject(cwd), [cwd]);
  const initialHistory = useMemo(() => historyFromSession(initialSession), [initialSession]);
  const [project, setProject] = useState(initialProject);
  const [model, setModel] = useState(() =>
    resolveModel(offline ? "local" : initialModel ?? initialSession?.modelId ?? "local")
  );
  const [history, setHistory] = useState(initialHistory);
  const [inputState, setInputState] = useState(() => createInputState("", promptHistoryFrom(initialHistory)));
  const [screen, setScreen] = useState(() =>
    initialTask ? "chat" : initialHistory.length > 0 ? "chat" : "empty"
  );
  const [returnScreen, setReturnScreen] = useState("chat");
  const [running, setRunning] = useState(false);
  const [permission, setPermission] = useState(null);
  const [permissionScroll, setPermissionScroll] = useState(0);
  const [permissionBounds, setPermissionBounds] = useState({ total: 0, height: 10 });
  const [chatScroll, setChatScroll] = useState(0);
  const [chatBounds, setChatBounds] = useState({ total: 0, height: 10 });
  const [autoApprove, setAutoApprove] = useState(Boolean(initialAutoApprove));
  const [thoughtsExpanded, setThoughtsExpanded] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [swarmState, setSwarmState] = useState(() => createSwarmState({ project: initialProject }));
  const [scopeFile, setScopeFile] = useState(() => lastContext(initialHistory, null)?.file ?? null);
  const [scopeSelection, setScopeSelection] = useState(0);
  const [visionMode, setVisionMode] = useState("scope");
  const [visionStatus, setVisionStatus] = useState("");
  const [pickerIndex, setPickerIndex] = useState(() => modelIndex(model.id));
  const [slashIndex, setSlashIndex] = useState(0);
  const [status, setStatus] = useState("");
  const [tokenStats, setTokenStats] = useState(() => ({
    inputTokens: initialSession?.tokenStats?.inputTokens ?? 0,
    outputTokens: initialSession?.tokenStats?.outputTokens ?? 0,
    cachedTokens: initialSession?.tokenStats?.cachedTokens ?? 0,
    cost: initialSession?.tokenStats?.cost ?? 0,
  }));
  const [metrics, setMetrics] = useState(initialSession?.metrics ?? {});
  const [liveVersion, setLiveVersion] = useState(0);
  const [projectRevision, setProjectRevision] = useState(0);
  const [sessionId, setSessionId] = useState(() => initialSession?.id ?? newRunId());

  const liveRef = useRef(null);
  const liveTimer = useRef(null);
  const autoApproveDefault = useRef(Boolean(initialAutoApprove));
  const historyRef = useRef(history);
  const projectRef = useRef(project);
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
  const savedPatchRef = useRef(initialSession?.lastPatch ?? null);
  const handleEventRef = useRef(null);
  const saveRef = useRef(null);
  const permissionResolved = useRef(false);
  const testAbortRef = useRef(null);
  const pendingShortcutRef = useRef(null);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
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

  const controller = useMemo(
    () => createRunController({ onEvent: (event) => handleEventRef.current?.(event) }),
    []
  );

  // Resuming a session should not be read-only: if the exact post-patch file
  // is still on disk and its backup exists, re-arm the same undo safety net.
  useEffect(() => {
    if (initialSession?.lastPatch) controller.restoreFromSession(initialSession.lastPatch, { root: cwd });
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

  const refreshProject = useCallback(() => {
    const next = detectProject(cwd);
    setProject(next);
    projectRef.current = next;
    setProjectRevision((value) => value + 1);
    return next;
  }, [cwd]);

  const scopeFiles = useMemo(() => scopeFilesFor(project), [project]);
  const scopeData = useMemo(() => {
    if (!scopeFile) return { file: null, source: "", parsed: null };
    const readable = readFileSafe(`${project.root}/${scopeFile}`);
    if (!readable.ok) return { file: scopeFile, source: "", parsed: null };
    return { file: scopeFile, source: readable.content, parsed: parseScopes(readable.content, scopeFile) };
  }, [scopeFile, project.root, projectRevision]);

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
    (historyArg = historyRef.current, lastResult = null) => {
      try {
        const edit = lastResult?.editFile;
        const resultPatch =
          edit?.status === "approved" || edit?.status === "applied"
            ? {
                file: edit.path,
                absPath: edit.absPath ?? lastResult.proposal?.absPath ?? null,
                patch: edit.patch ?? lastResult.proposal?.patch ?? "",
                stats: edit.stats ?? lastResult.proposal?.stats ?? { adds: 0, dels: 0 },
                backupPath: edit.backupPath ?? lastResult.applied?.backupPath ?? null,
                original: lastResult.proposal?.original ?? lastResult.applied?.original ?? null,
                updatedText: lastResult.proposal?.updatedText ?? lastResult.applied?.updatedText ?? null,
              }
            : null;
        // A denied or failed proposal must never be remembered as an applied
        // patch. Only a genuinely approved edit (or a prior saved patch when a
        // non-edit run like /test finishes) survives in the session.
        const lastPatch =
          controller.lastApplied() ??
          resultPatch ??
          (edit ? null : savedPatchRef.current);
        savedPatchRef.current = lastPatch
          ? {
              file: lastPatch.file,
              absPath: lastPatch.absPath,
              patch: lastPatch.patch,
              stats: lastPatch.stats,
              backupPath: lastPatch.backupPath,
              original: lastPatch.original,
              updatedText: lastPatch.updatedText,
              status: "applied",
            }
          : null;
        const snapshot = sessionSnapshot({
          project: projectRef.current,
          history: historyArg,
          model: modelRef.current,
          tokenStats: tokenStatsRef.current,
          metrics,
          lastPatch,
          cwd,
          sessionId,
          elapsedMs: metrics?.elapsedMs ?? 0,
        });
        saveSession(snapshot, { home: matrixHome() });
      } catch {
        // A full disk must not take down the workbench.
      }
    },
    [controller, cwd, metrics, sessionId]
  );
  saveRef.current = saveSnapshot;

  const finalizeResult = useCallback(
    (result) => {
      if (!result || resultHandled.current) return;
      resultHandled.current = true;
      const message = {
        id: result.id ?? `asst-${Date.now()}`,
        role: "assistant",
        content: result.content ?? "",
        reasoning: result.reasoning ?? "",
        plan: result.plan ?? [],
        readFile: result.readFile ?? null,
        editFile: result.editFile ?? null,
        verifyTests: result.verifyTests ?? null,
        toolCards: result.toolCards ?? [],
        summary: result.summary ?? "",
        error: Boolean(result.error),
        failure: result.failure ?? null,
        modelName: result.modelName ?? modelRef.current?.name ?? "MATRIX",
        usage: result.usage ?? null,
        cost: result.cost ?? 0,
        elapsedTime: result.elapsedTime ?? 0,
        timestamp: Date.now(),
      };
      const next = [...historyRef.current, message];
      historyRef.current = next;
      setHistory(next);
      setLiveVersion((value) => value + 1);
      liveRef.current = null;
      setRunning(false);
      setPermission(null);
      resetAutoApprove();
      if (result.error) flash(result.failure ?? result.summary ?? "run failed", 8000);
      else if (result.summary) flash(result.summary, 5000);
      refreshProject();
      saveRef.current?.(next, result);
    },
    [flash, refreshProject, resetAutoApprove]
  );

  handleEventRef.current = (event) => {
    setSwarmState((previous) => applySwarmEvent(previous, event));
    switch (event.type) {
      case "run:start": {
        liveRef.current = makeLive(event.task ?? "", event.modelName ?? modelRef.current?.name ?? "MATRIX");
        liveRef.current.phase = "planning";
        liveRef.current.plan = (event.plan ?? []).map((step) => ({ ...step }));
        liveRef.current.activePlanIdx = 0;
        runBaseTokens.current = { ...tokenStatsRef.current };
        resultHandled.current = false;
        permissionResolved.current = false;
        setRunning(true);
        setScreen("chat");
        setPermission(null);
        setChatScroll(0);
        bumpLive(true);
        break;
      }
      case "phase": {
        if (!liveRef.current) break;
        liveRef.current.phase = event.phase ?? liveRef.current.phase;
        if (event.detail) liveRef.current.detail = event.detail;
        bumpLive();
        break;
      }
      case "plan": {
        if (!liveRef.current) break;
        liveRef.current.plan = (event.plan ?? []).map((step) => ({ ...step }));
        liveRef.current.activePlanIdx = Math.max(
          0,
          (event.plan ?? []).findIndex((step) => step.status === "active")
        );
        bumpLive(true);
        break;
      }
      case "plan:step": {
        if (!liveRef.current) break;
        liveRef.current.plan = (event.plan ?? liveRef.current.plan).map((step) => ({ ...step }));
        liveRef.current.activePlanIdx = Math.max(
          0,
          liveRef.current.plan.findIndex((step) => step.status === "active")
        );
        bumpLive(true);
        break;
      }
      case "thought": {
        if (!liveRef.current) break;
        liveRef.current.reasoning += event.text ?? "";
        bumpLive();
        break;
      }
      case "content": {
        if (!liveRef.current) break;
        liveRef.current.content += event.text ?? "";
        bumpLive();
        break;
      }
      case "tool:start": {
        if (!liveRef.current) break;
        liveRef.current.toolCards.push({
          id: event.id,
          name: event.name,
          label: event.label,
          args: event.args,
          ok: true,
          summary: "running…",
          running: true,
        });
        bumpLive(true);
        break;
      }
      case "tool:end": {
        if (!liveRef.current) break;
        const card = liveRef.current.toolCards.find((item) => item.id === event.id);
        if (card) {
          card.ok = event.ok !== false;
          card.summary = event.summary ?? "";
          card.data = event.data ?? null;
          card.running = false;
        }
        bumpLive(true);
        break;
      }
      case "proposal": {
        if (!liveRef.current) break;
        const proposal = event.proposal;
        liveRef.current.editFile = {
          path: proposal.file,
          scope: proposal.scope,
          diff: proposal.patch?.split("\n").filter(Boolean) ?? [],
          patch: proposal.patch,
          hunks: proposal.hunks,
          stats: proposal.stats,
          status: "pending",
        };
        setPermission({ ...proposal, status: "pending" });
        permissionResolved.current = false;
        if (!autoApproveRef.current) {
          setScreen("permission");
          setPermissionScroll(0);
        }
        bumpLive(true);
        break;
      }
      case "approval:request": {
        if (!autoApproveRef.current && permissionRef.current) {
          setScreen("permission");
        }
        break;
      }
      case "approval:result": {
        if (event.decision === "n") {
          setPermission((previous) => (previous ? { ...previous, status: "denied" } : previous));
            if (!autoApproveRef.current) setScreen("chat");
        } else {
          setPermission((previous) => (previous ? { ...previous, status: "approved" } : previous));
          if (!autoApproveRef.current) setScreen("chat");
        }
        bumpLive(true);
        break;
      }
      case "applied": {
        if (liveRef.current?.editFile) {
          liveRef.current.editFile = {
            ...liveRef.current.editFile,
            status: "applied",
            backupPath: event.backupPath ?? null,
          };
        }
        bumpLive(true);
        break;
      }
      case "verify:start": {
        if (!liveRef.current) break;
        liveRef.current.phase = "verifying";
        liveRef.current.verifyLines = [];
        liveRef.current.verifyTests = {
          cmd: event.command,
          results: [],
          running: true,
          output: [],
          summary: "",
        };
        bumpLive(true);
        break;
      }
      case "verify:line": {
        if (!liveRef.current) break;
        liveRef.current.verifyLines.push(event.line);
        if (liveRef.current.verifyLines.length > 80) liveRef.current.verifyLines.shift();
        bumpLive();
        break;
      }
      case "verify:skipped": {
        if (!liveRef.current) break;
        liveRef.current.verifyTests = {
          cmd: null,
          results: [],
          skipped: true,
          summary: event.reason ?? "no test runner",
          output: [],
        };
        bumpLive(true);
        break;
      }
      case "verify:end": {
        if (!liveRef.current) break;
        const verify = event.result ?? {};
        liveRef.current.verifyTests = {
          cmd: verify.command,
          results: (verify.cases ?? []).map((item) => ({ name: item.name, pass: item.pass })),
          passed: verify.passed,
          failed: verify.failed,
          duration: verify.durationMs != null ? `${Math.round(verify.durationMs)}ms` : "",
          output: verify.lines?.slice(-40) ?? [],
          summary: verify.summary,
          ok: verify.ok,
          skipped: verify.skipped,
        };
        bumpLive(true);
        break;
      }
      case "usage": {
        const base = runBaseTokens.current;
        const usage = event.usage ?? {};
        setTokenStats({
          inputTokens: base.inputTokens + Number(usage.prompt_tokens ?? 0),
          outputTokens: base.outputTokens + Number(usage.completion_tokens ?? 0),
          cachedTokens: base.cachedTokens + Number(usage.cached_tokens ?? 0),
          cost: base.cost + Number(usage.cost ?? 0),
        });
        if (liveRef.current) liveRef.current.usage = usage;
        bumpLive();
        break;
      }
      case "metrics": {
        setMetrics(event.metrics ?? {});
        if (liveRef.current) liveRef.current.metrics = event.metrics;
        bumpLive();
        break;
      }
      case "result": {
        finalizeResult(event.result);
        break;
      }
      case "error": {
        if (liveRef.current) {
          liveRef.current.error = true;
          liveRef.current.summary = event.error ?? "run failed";
        }
        flash(event.error ?? "run failed", 8000);
        bumpLive(true);
        break;
      }
      case "done": {
        setRunning(false);
        bumpLive(true);
        break;
      }
      case "undo": {
        const text = `restored ${event.files?.join(", ") ?? "file"}`;
        const message = { id: `system-${Date.now()}`, role: "system", content: text, timestamp: Date.now() };
        const next = [...historyRef.current, message];
        historyRef.current = next;
        setHistory(next);
        flash(text);
        break;
      }
      default:
        break;
    }
  };

  const startTask = useCallback(
    async (task) => {
      const clean = String(task ?? "").trim();
      if (!clean) return;
      if (runningRef.current) {
        flash("a run is already active · Ctrl+C aborts it");
        return;
      }
      const userMessage = { id: `user-${Date.now()}`, role: "user", content: clean, timestamp: Date.now() };
      const next = [...historyRef.current, userMessage];
      historyRef.current = next;
      setHistory(next);
      setInputState((previous) => createInputState("", previous.history));
      setScreen("chat");
      setChatScroll(0);
      setPermission(null);
      setDiffExpanded(false);
      setRunning(true);
      liveRef.current = makeLive(clean, modelRef.current?.name ?? "MATRIX");
      runBaseTokens.current = { ...tokenStatsRef.current };
      resultHandled.current = false;
      const runProject = refreshProject();
      setSwarmState(createSwarmState({ task: clean, project: runProject }));
      bumpLive(true);

      const outcome = await controller.start({
        task: clean,
        project: runProject,
        model: modelRef.current,
        autoApprove: autoApproveRef.current,
      });
      if (!resultHandled.current) {
        if (outcome?.result) finalizeResult(outcome.result);
        else {
          const fallback = {
            role: "assistant",
            content: outcome?.error ? `Run failed: ${outcome.error}` : "Run ended without a result.",
            error: true,
            summary: outcome?.error ?? "no result",
            modelName: modelRef.current?.name,
          };
          finalizeResult(fallback);
        }
      }
      setRunning(false);
    },
    [bumpLive, controller, finalizeResult, flash, refreshProject]
  );

  const runTestsDirect = useCallback(async () => {
    if (runningRef.current) {
      flash("a run is already active");
      return;
    }
    const current = refreshProject();
    if (!current.test) {
      flash("no test runner detected in this workspace");
      return;
    }
    setRunning(true);
    setScreen("chat");
    const task = `/test · ${current.test.display}`;
    liveRef.current = makeLive(task, "matrix/test");
    liveRef.current.phase = "verifying";
    liveRef.current.verifyTests = { cmd: current.test.display, results: [], running: true, output: [] };
    bumpLive(true);
    const abortController = new AbortController();
    testAbortRef.current = abortController;
    try {
      const result = await runTests(current.test, {
        cwd: current.test.cwd,
        signal: abortController.signal,
        onLine: (line) => {
          if (!liveRef.current) return;
          liveRef.current.verifyLines.push(line);
          bumpLive();
        },
      });
      const aborted = Boolean(result.aborted);
      const verify = {
        cmd: result.command,
        results: (result.cases ?? []).map((item) => ({ name: item.name, pass: item.pass })),
        passed: result.passed,
        failed: result.failed,
        duration: `${Math.round(result.durationMs)}ms`,
        output: result.lines?.slice(-40) ?? [],
        summary: aborted ? "test run aborted" : result.summary,
        ok: result.ok,
        skipped: result.skipped,
        aborted,
        timedOut: Boolean(result.timedOut),
      };
      const message = {
        id: `test-${Date.now()}`,
        role: "assistant",
        content: aborted
          ? "Test run aborted. No file was modified by /test."
          : result.ok
          ? ""
          : "Tests failed. The output is above; no file was modified by /test.",
        verifyTests: verify,
        summary: aborted ? "test run aborted" : result.summary ?? `${result.passed} passed · ${result.failed} failed`,
        error: !result.ok && !aborted,
        modelName: "matrix/test",
        timestamp: Date.now(),
      };
      liveRef.current = null;
      const next = [...historyRef.current, message];
      historyRef.current = next;
      setHistory(next);
      setRunning(false);
      bumpLive(true);
      flash(message.summary);
      saveRef.current?.(next, message);
    } catch (error) {
      liveRef.current = null;
      setRunning(false);
      bumpLive(true);
      flash(`test runner failed: ${error.message}`, 8000);
    } finally {
      if (testAbortRef.current === abortController) testAbortRef.current = null;
    }
  }, [bumpLive, flash, refreshProject]);

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
    [scopeFile, scopeFiles]
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
    [flash, scopeFile, scopeFiles]
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
      const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15);
      const path = `${matrixHome()}/vision-${stamp}.png`;
      const written = writePng(graph.canvas, path);
      setVisionStatus(`exported ${written.path} · ${written.width}×${written.height} · ${written.bytes} bytes`);
      flash(`PNG written · ${written.path}`, 6000);
    } catch (error) {
      setVisionStatus(`export failed: ${error.message}`);
      flash(`PNG export failed: ${error.message}`, 6000);
    }
  }, [flash, height, metrics, project, scopeData, visionMode, width]);

  const runUndo = useCallback(() => {
    const result = controller.undoLast();
    if (!result.ok) {
      flash(result.error, 6000);
      return;
    }
    savedPatchRef.current = null;
    refreshProject();
    saveRef.current?.();
    flash(`restored ${result.files.join(", ")}`);
  }, [controller, flash, refreshProject]);

  const showSession = useCallback(() => {
    const sessions = listSessions();
    const latest = sessions[0];
    const lines = [
      `workspace  ${project.name}`,
      `root       ${project.root}`,
      `branch     ${project.branch ?? "not a git repository"}`,
      `files      ${project.fileCount}${project.truncated ? " (index truncated)" : ""}`,
      `tests      ${project.test?.display ?? "none detected"}`,
      `model      ${model.name} · ${model.id}`,
      `session    ${sessionId}`,
      `messages   ${historyRef.current.length}`,
      `tokens     ↑${tokenStats.inputTokens} ↓${tokenStats.outputTokens} · $${formatCost(tokenStats.cost)}`,
      `sessions   ${sessions.length} saved · ${latest ? latest.id : "none"}`,
      `home       ${matrixHome()}`,
    ];
    const message = { id: `session-${Date.now()}`, role: "system", content: lines.join("\n"), timestamp: Date.now() };
    const next = [...historyRef.current, message];
    historyRef.current = next;
    setHistory(next);
    setScreen("chat");
  }, [model, project, sessionId, tokenStats]);

  const runDoctorCommand = useCallback(() => {
    try {
      const report = runDoctor({ cwd, stdout: process.stdout });
      const text = formatDoctor(report, { color: false });
      const message = { id: `doctor-${Date.now()}`, role: "assistant", content: text, modelName: "matrix doctor", timestamp: Date.now() };
      const next = [...historyRef.current, message];
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
          setScreen("help");
          break;
        case "/new": {
          const next = [];
          historyRef.current = next;
          setHistory(next);
          setInputState(createInputState("", []));
          setScreen("empty");
          setChatScroll(0);
          setPermission(null);
          setTokenStats({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 });
          setMetrics({});
          setSessionId(newRunId());
          savedPatchRef.current = null;
          controller.clearUndo();
          resetAutoApprove();
          flash("new session");
          break;
        }
        case "/clear": {
          historyRef.current = [];
          setHistory([]);
          setInputState((previous) => createInputState("", previous.history));
          setScreen("empty");
          setChatScroll(0);
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
            if (found && (found !== LOCAL_MODEL || arg.toLowerCase().includes("local") || arg.toLowerCase().includes("forge"))) {
              setModel(found);
              modelRef.current = found;
              flash(`model · ${found.name}`);
              break;
            }
          }
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
          runDoctorCommand();
          break;
        case "/quit":
          saveRef.current?.();
          exit();
          break;
        default:
          flash(`unknown command ${head} · /help for the list`);
      }
    },
    [controller, exit, flash, openScope, resetAutoApprove, runDoctorCommand, runTestsDirect, runUndo, showSession]
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

  const toggleModelPicker = useCallback(() => {
    if (screenRef.current === "model") {
      setScreen(returnScreen);
      return;
    }
    setReturnScreen(screenRef.current);
    setPickerIndex(modelIndex(modelRef.current?.id));
    setScreen("model");
  }, [returnScreen]);

  useInput((ch, key) => {
    let hadPending = false;
    if (pendingShortcutRef.current) {
      clearTimeout(pendingShortcutRef.current.timer);
      const pending = pendingShortcutRef.current;
      pendingShortcutRef.current = null;
      if (key.backspace || key.delete || key.escape) {
        return;
      }
      if (pending.isScreenKey && ch >= "1" && ch <= "6" && !key.ctrl && !key.meta) {
        pending.action();
      } else {
        hadPending = true;
        setInputState((previous) => insertText(previous, pending.ch));
      }
    }

    const mouse = parseTerminalMouse(ch);
    if (mouse) {
      if (mouse.direction === "up") {
        if (screen === "chat" || screen === "empty") {
          setChatScroll((offset) => Math.min(Math.max(0, chatBounds.total - chatBounds.height), offset + 3));
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
        } else if (screen === "permission") {
          setPermissionScroll((offset) => Math.min(Math.max(0, permissionBounds.total - permissionBounds.height), offset + 3));
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

    if (key.ctrl && ch === "c") {
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

    // Overlays that own the keyboard.
    if (screen === "model") {
      if (ch >= "1" && ch <= "6") {
        const target = SCREENS[Number(ch) - 1];
        if (target) {
          setScreen(target);
          return;
        }
      }
      if (key.upArrow || ch === "k") {
        setPickerIndex((index) => (index - 1 + MODELS.length) % MODELS.length);
      } else if (key.downArrow || ch === "j") {
        setPickerIndex((index) => (index + 1) % MODELS.length);
      } else if (key.pageUp) {
        setPickerIndex((index) => Math.max(0, index - 5));
      } else if (key.pageDown) {
        setPickerIndex((index) => Math.min(MODELS.length - 1, index + 5));
      } else if (key.home || ch === "g") {
        setPickerIndex(0);
      } else if (key.end || ch === "G") {
        setPickerIndex(MODELS.length - 1);
      } else if (key.return) {
        const chosen = MODELS[Math.min(Math.max(0, pickerIndex), MODELS.length - 1)];
        setModel(chosen);
        modelRef.current = chosen;
        setScreen(returnScreen);
        if (chosen.remote && !isOpenRouterAvailable()) {
          flash(`${chosen.name} needs an OpenRouter key · Local Forge remains available`, 7000);
        } else {
          flash(`model · ${chosen.name}${chosen.free ? " · free tier" : ""}`);
        }
      } else if (key.escape || ch === "m") {
        setScreen(returnScreen);
      }
      return;
    }
    if (screen === "help") {
      if (ch >= "1" && ch <= "6") {
        const target = SCREENS[Number(ch) - 1];
        if (target) {
          setScreen(target);
          return;
        }
      }
      if (key.escape || ch === "?" || key.return) setScreen(returnScreen);
      return;
    }
    if (screen === "permission") {
      if (!permission) {
        setScreen("chat");
        return;
      }
      if (permission.status === "pending") {
        if (ch === "y" || ch === "a" || ch === "n") {
          if (permissionResolved.current) return;
          permissionResolved.current = true;
          if (ch === "a") {
            setAutoApprove(true);
            autoApproveRef.current = true;
          }
          setPermission((previous) => (previous ? { ...previous, status: ch === "n" ? "denied" : "approved" } : previous));
          setScreen("chat");
          controller.approve(ch);
          flash(ch === "n" ? "patch denied · file unchanged" : ch === "a" ? "approved · auto-approve enabled" : "approved · writing file");
          return;
        }
      }
      if (key.escape) {
        if (permission.status === "pending") {
          permissionResolved.current = true;
          setPermission((previous) => (previous ? { ...previous, status: "denied" } : previous));
          setScreen("chat");
          controller.approve("n");
        } else {
          setScreen("chat");
        }
        return;
      }
      if (ch === "f" || ch === "F") setDiffExpanded((value) => !value);
      if (key.upArrow || ch === "k") setPermissionScroll((offset) => Math.max(0, offset - 1));
      if (key.downArrow || ch === "j") setPermissionScroll((offset) => Math.min(Math.max(0, permissionBounds.total - permissionBounds.height), offset + 1));
      if (key.pageUp) setPermissionScroll((offset) => Math.max(0, offset - Math.max(2, Math.floor(permissionBounds.height / 2))));
      if (key.pageDown) setPermissionScroll((offset) => Math.min(Math.max(0, permissionBounds.total - permissionBounds.height), offset + Math.max(2, Math.floor(permissionBounds.height / 2))));
      if (key.home) setPermissionScroll(0);
      if (key.end) setPermissionScroll(Math.max(0, permissionBounds.total - permissionBounds.height));
      return;
    }

    if (key.escape) {
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
    }

    if (key.pageUp || key.pageDown) {
      const step = Math.max(2, Math.floor(chatBounds.height / 2));
      setChatScroll((offset) => {
        const max = Math.max(0, chatBounds.total - chatBounds.height);
        return Math.min(max, Math.max(0, offset + (key.pageUp ? step : -step)));
      });
      return;
    }
    if (key.home && inputState.value.length === 0) {
      setChatScroll(Math.max(0, chatBounds.total - chatBounds.height));
      return;
    }
    if (key.end && inputState.value.length === 0) {
      setChatScroll(0);
      return;
    }

    if (screen === "swarm" && inputState.value.length === 0) {
      if (key.leftArrow) {
        setSwarmState((previous) => focusLane(previous, -1));
        return;
      }
      if (key.rightArrow || key.tab) {
        setSwarmState((previous) => focusLane(previous, 1));
        return;
      }
    }

    if (screen === "scope" && inputState.value.length === 0) {
      if (key.leftArrow) {
        cycleScopeFile(-1);
        return;
      }
      if (key.rightArrow) {
        cycleScopeFile(1);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const delta = key.downArrow ? 1 : -1;
        const scopes = (scopeData.parsed?.flat ?? []).filter((item) => item.kind !== "module");
        setScopeSelection((index) =>
          Math.min(Math.max(0, scopes.length - 1), Math.max(0, index + delta))
        );
        return;
      }
    }

    if (screen === "vision" && inputState.value.length === 0) {
      if (key.rightArrow || key.tab) {
        cycleVision(1);
        return;
      }
      if (key.leftArrow) {
        cycleVision(-1);
        return;
      }
    }

    const scheduleShortcut = (char, action, isScreenKey = false) => {
      pendingShortcutRef.current = {
        ch: char,
        action,
        isScreenKey,
        timer: setTimeout(() => {
          pendingShortcutRef.current = null;
          action();
        }, 50),
      };
    };

    if (!hadPending && inputState.value.length === 0 && !key.ctrl && !key.meta) {
      if (ch === "?" && !runningRef.current) {
        scheduleShortcut("?", () => {
          setReturnScreen(screenRef.current);
          setScreen("help");
        });
        return;
      }
      if (ch === "m" && !runningRef.current) {
        scheduleShortcut("m", () => {
          toggleModelPicker();
        });
        return;
      }
      if (ch === "u" && !runningRef.current) {
        scheduleShortcut("u", () => {
          if (controller.canUndo()) runUndo();
          else flash("no applied patch to undo");
        });
        return;
      }
      if (runningRef.current && (ch === "f" || ch === "F")) {
        scheduleShortcut(ch, () => {
          if (liveRef.current?.editFile) setDiffExpanded((value) => !value);
          else setThoughtsExpanded((value) => !value);
        });
        return;
      }
      if (!runningRef.current && ch >= "1" && ch <= "6") {
        scheduleShortcut(
          ch,
          () => {
            if (ch === "1") setScreen("empty");
            else if (ch === "2") setScreen("chat");
            else if (ch === "3") {
              setScreen(permission ? "permission" : "chat");
              if (!permission) flash("no patch waiting");
            } else if (ch === "4") setScreen("swarm");
            else if (ch === "5") openScope();
            else if (ch === "6") setScreen("vision");
          },
          true
        );
        return;
      }
    }

    if (key.tab) {
      const completed = completeSlash(inputState);
      if (completed && completed.value !== inputState.value) {
        setInputState(completed);
      } else {
        setInputState((previous) => insertText(previous, "  "));
      }
      return;
    }

    const slashOpen = slashMatches(inputState.value).length > 0 && !inputState.value.includes(" ");
    if (slashOpen && (key.upArrow || key.downArrow)) {
      const count = slashMatches(inputState.value).length;
      setSlashIndex((index) => (index + (key.downArrow ? 1 : -1) + count) % count);
      return;
    }

    if (key.return) {
      submitInput();
      return;
    }
    if (key.backspace || key.delete) {
      setInputState((previous) => (key.backspace ? backspace(previous) : deleteForward(previous)));
      return;
    }
    if (key.leftArrow) {
      setInputState((previous) => (key.meta || key.ctrl ? moveWordLeft(previous) : moveLeft(previous)));
      return;
    }
    if (key.rightArrow) {
      setInputState((previous) => (key.meta || key.ctrl ? moveWordRight(previous) : moveRight(previous)));
      return;
    }
    if (key.upArrow) {
      setInputState((previous) => historyPrevious(previous));
      return;
    }
    if (key.downArrow) {
      setInputState((previous) => historyNext(previous));
      return;
    }
    if (key.home) {
      setInputState((previous) => moveHome(previous));
      return;
    }
    if (key.end) {
      setInputState((previous) => moveEnd(previous));
      return;
    }
    if (key.ctrl && ch === "a") {
      setInputState((previous) => moveHome(previous));
      return;
    }
    if (key.ctrl && ch === "e") {
      setInputState((previous) => moveEnd(previous));
      return;
    }
    if (key.ctrl && ch === "u") {
      setInputState((previous) => setValue(previous, ""));
      return;
    }
    if (key.ctrl && ch === "w") {
      setInputState((previous) => deleteWordLeft(previous));
      return;
    }
    if (key.ctrl && ch === "k") {
      setInputState((previous) => killLine(previous));
      return;
    }
    if (key.ctrl && ch === "l") {
      setChatScroll(0);
      return;
    }
    if (key.ctrl && ch === "b") {
      setInputState((previous) => moveLeft(previous));
      return;
    }
    if (key.ctrl && ch === "f") {
      setInputState((previous) => moveRight(previous));
      return;
    }
    if (key.ctrl && ch === "p") {
      setInputState((previous) => historyPrevious(previous));
      return;
    }
    if (key.ctrl && ch === "n") {
      setInputState((previous) => historyNext(previous));
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      setInputState((previous) => insertText(previous, ch));
    }
  });

  usePaste((text) => {
    if (text) {
      if (pendingShortcutRef.current) {
        clearTimeout(pendingShortcutRef.current.timer);
        const pendingCh = pendingShortcutRef.current.ch;
        pendingShortcutRef.current = null;
        setInputState((previous) => insertText(previous, pendingCh + text));
      } else {
        setInputState((previous) => insertText(previous, text));
      }
    }
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
      if (pendingShortcutRef.current) clearTimeout(pendingShortcutRef.current.timer);
      saveRef.current?.();
      controller.dispose();
    };
  }, [controller]);

  const live = running && liveRef.current ? { ...liveRef.current } : null;
  const context = lastContext(history, live);
  const activeLine = context?.line ?? 1;
  const scopeNode = scopeData.parsed ? scopeAtLine(scopeData.parsed, activeLine) : null;
  const testResult = lastVerification(history, live);
  const slashRows =
    !running && !["permission", "model", "help"].includes(screen) && slashMatches(inputState.value).length > 0
      ? Math.min(5, slashMatches(inputState.value).length)
      : 0;
  const showInput = !["permission", "model", "help"].includes(screen);
  const fixedRows = 3 + 1 + 1 + (showInput ? 3 : 0) + slashRows;
  const contentHeight = Math.max(3, height - fixedRows);
  const chatScrollInfo =
    chatBounds.total > chatBounds.height
      ? {
          start: Math.max(1, chatBounds.total - chatBounds.height - Math.min(chatScroll, chatBounds.total - chatBounds.height) + 1),
          end: Math.max(1, chatBounds.total - Math.min(chatScroll, chatBounds.total - chatBounds.height)),
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
      waiting: screen === "permission" && Boolean(permission),
      phase: live?.phase ?? "idle",
      tokenStats,
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
        chatScroll,
        onChatBounds: setChatBounds,
        thoughtsExpanded,
        diffExpanded,
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
        hasKey: isOpenRouterAvailable(),
        session: initialSession,
        status,
      })
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
          autoApprove,
        })
      : null,
    h(StatusBar, {
      screen,
      model,
      running,
      autoApprove,
      status,
      cols,
      scroll: chatScrollInfo,
    }),
    h(KeyHints, { screen, running, waiting: screen === "permission", autoApprove, cols })
  );
}

// Legacy exports kept for renderers and external callers.
export { ScreenView as MatrixScreens };
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
export { ChatScreen, buildChatLines, buildPermissionLines, buildVisionCanvas, SCREENS };
