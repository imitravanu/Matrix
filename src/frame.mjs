// Presentational routing and frame composition shared by the live app, dumps,
// smoke checks, and benchmarks. This module must not import runtime/agent code.

import React, { useRef } from "react";
import { Box } from "ink";

import { useLayout } from "../lib/term.mjs";
import { createInputState } from "../lib/input.mjs";
import { MODELS } from "../lib/models.mjs";
import { isOpenRouterAvailable } from "./credentials.mjs";
import { normalizeViewModel } from "./views.mjs";
import { VisionScreen } from "./screens/vision.mjs";
import { ChatScreen } from "./screens/chat.mjs";
import { PermissionScreen } from "./screens/permission.mjs";
import { SwarmScreen } from "./screens/swarm.mjs";
import { ScopeScreen } from "./screens/scope.mjs";
import { EmptyScreen } from "./screens/empty.mjs";
import { ModelScreen } from "./screens/model.mjs";
import { HelpScreen } from "./screens/help.mjs";
import { TestTrustScreen } from "./screens/test-trust.mjs";
import { CommandTrustScreen } from "./screens/command-trust.mjs";
import { Header, InputBar, KeyHints, StatusBar } from "./screens/common.mjs";

const h = React.createElement;

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
  commandTrustRequest = null,
  commandTrustScroll = 0,
  onCommandTrustBounds = null,
  testTrustRequest = null,
  testTrustScroll = 0,
  onTestTrustBounds = null,
  helpScroll = 0,
  onHelpBounds = null,
  chatScroll = 0,
  onChatBounds = null,
  thoughtsExpanded = false,
  diffExpanded = false,
  outputExpanded = false,
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
  status: _status = "",
}) {
  const view = normalizeViewModel(screen);
  if (view === "empty") {
    return h(EmptyScreen, { project, model, session, animTime });
  }
  if (view === "permission" && commandTrustRequest) {
    return h(CommandTrustScreen, {
      request: commandTrustRequest,
      width,
      height,
      scrollOffset: commandTrustScroll,
      onBounds: onCommandTrustBounds,
    });
  }
  if (view === "permission" && testTrustRequest) {
    return h(TestTrustScreen, {
      request: testTrustRequest,
      width,
      height,
      scrollOffset: testTrustScroll,
      onBounds: onTestTrustBounds,
    });
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
    return h(HelpScreen, { width, height, scrollOffset: helpScroll, onBounds: onHelpBounds });
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
    outputExpanded,
  });
}

export function Frame(props) {
  const {
    screen = "empty",
    inputValue = "",
    model = MODELS[0],
    project = null,
    chatHistory = [],
    live = null,
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
    checkCredentialAvailability = isOpenRouterAvailable,
  } = props;

  const { cols, height } = useLayout();
  const width = Math.max(20, cols - 2);
  const input = createInputState(inputValue);
  const view = normalizeViewModel(screen);
  const modelId = model?.id ?? "local";
  const credentialRef = useRef({ modelId: null, hasKey: false });
  if (props.hasKey === undefined && credentialRef.current.modelId !== modelId) {
    credentialRef.current = { modelId, hasKey: checkCredentialAvailability(modelId) };
  }
  const hasKey = props.hasKey ?? credentialRef.current.hasKey;
  const showInput = !["permission", "model", "help"].includes(view);
  const fixed = 3 + 1 + 1 + (showInput ? 3 : 0);
  const contentHeight = Math.max(3, height - fixed);
  const permission =
    props.permission ?? (view === "permission" && props.proposal ? props.proposal : null);
  const waiting =
    view === "permission" &&
    (Boolean(props.commandTrustRequest) ||
      Boolean(props.testTrustRequest) ||
      (permission?.status ?? "pending") === "pending");

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
      commandTrust: Boolean(props.commandTrustRequest),
      testTrust: Boolean(props.testTrustRequest),
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
        hasKey,
      }),
    ),
    showInput
      ? h(InputBar, { input, placeholder: "Describe a task, or type / for commands" })
      : null,
    h(StatusBar, {
      screen: view,
      model,
      running: Boolean(live),
      status: choice ? `decision: ${choice}` : status,
      cols,
    }),
    h(KeyHints, {
      screen: view,
      running: Boolean(live),
      waiting,
      cols,
      commandTrust: Boolean(props.commandTrustRequest),
      testTrust: Boolean(props.testTrustRequest),
    }),
  );
}
