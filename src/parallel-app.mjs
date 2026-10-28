import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { runParallelInteractive } from "../lib/parallel-interactive.mjs";
import { applyParallelSwarmEvent, createParallelSwarmState } from "../lib/parallel-swarm.mjs";
import { forge } from "../lib/forge.mjs";
import { useLayout } from "../lib/term.mjs";
import { sanitizeText, truncateToWidth, wrapCodeToWidth } from "../lib/text.mjs";
import { SwarmScreen } from "./screens/swarm.mjs";

const h = React.createElement;
const MAX_REVIEW_CHARS = 24 * 1024 * 1024;

/** Separate Ink review for the real parallel batch; it does not use single-run lanes. */
export function ParallelApp({
  root,
  home,
  jobs,
  scratchDir,
  onComplete = null,
  run = runParallelInteractive,
}) {
  const { exit } = useApp();
  const size = useLayout();
  const width = Math.max(20, size.content);
  const swarmHeight = Math.min(jobs.length + 1, Math.max(3, Math.floor(size.height / 2)));
  const reviewHeight = Math.max(3, size.height - swarmHeight - 5);
  const [swarm, setSwarm] = useState(() => createParallelSwarmState(jobs));
  const [review, setReview] = useState("");
  const [question, setQuestion] = useState(null);
  const [input, setInput] = useState("");
  const [offset, setOffset] = useState(0);
  const [finished, setFinished] = useState(null);
  const pending = useRef(null);
  const inputRef = useRef("");
  const textRef = useRef("");
  const abortRef = useRef(null);
  const activeRef = useRef(true);
  const wrapped = useMemo(() => wrapCodeToWidth(sanitizeText(review), width), [review, width]);
  const maxOffset = Math.max(0, wrapped.length - reviewHeight);
  const visible = wrapped.slice(
    Math.min(offset, maxOffset),
    Math.min(offset, maxOffset) + reviewHeight,
  );

  useEffect(() => {
    const abort = new AbortController();
    abortRef.current = abort;
    activeRef.current = true;
    const write = (text) => {
      if (!activeRef.current) return;
      if (textRef.current.length + text.length > MAX_REVIEW_CHARS) {
        throw new Error("Parallel review exceeds the interactive display budget");
      }
      textRef.current += text;
      setReview(textRef.current);
    };
    const ask = (prompt) =>
      new Promise((resolve) => {
        pending.current = resolve;
        setQuestion(prompt);
        setInput("");
        setOffset(0);
      });
    void run({
      root,
      home,
      jobs,
      scratchDir,
      signal: abort.signal,
      write,
      ask,
      onEvent: (event) => {
        if (activeRef.current) setSwarm((previous) => applyParallelSwarmEvent(previous, event));
      },
    }).then(
      (result) => {
        if (!activeRef.current) return;
        setFinished({ result, error: null });
        setQuestion(null);
        if (onComplete) onComplete({ result, error: null });
      },
      (error) => {
        if (!activeRef.current) return;
        setFinished({ result: null, error: error.message });
        setQuestion(null);
        if (onComplete) onComplete({ result: null, error: error.message });
      },
    );
    return () => {
      activeRef.current = false;
      abort.abort();
      if (pending.current) {
        pending.current("n");
        pending.current = null;
      }
    };
  }, [root, home, jobs, scratchDir, onComplete, run]);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (finished) {
        exit();
        return;
      }
      abortRef.current?.abort();
      if (pending.current) {
        pending.current("n");
        pending.current = null;
        setQuestion(null);
      }
      return;
    }
    if (key.pageUp) {
      setOffset((value) => Math.max(0, value - reviewHeight));
      return;
    }
    if (key.pageDown) {
      setOffset((value) => Math.min(maxOffset, value + reviewHeight));
      return;
    }
    if (key.upArrow) {
      setOffset((value) => Math.max(0, value - 1));
      return;
    }
    if (key.downArrow) {
      setOffset((value) => Math.min(maxOffset, value + 1));
      return;
    }
    if (key.home) {
      setOffset(0);
      return;
    }
    if (key.end) {
      setOffset(maxOffset);
      return;
    }
    if (key.return && finished) {
      exit();
      return;
    }
    if (!question || !pending.current) return;
    if (key.return) {
      const resolve = pending.current;
      pending.current = null;
      setQuestion(null);
      const answer = inputRef.current.trim();
      inputRef.current = "";
      setInput("");
      textRef.current = "";
      setReview("");
      setOffset(0);
      resolve(answer);
    } else if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1);
      setInput(inputRef.current);
    } else if (ch && !key.ctrl && !key.meta) {
      inputRef.current = (inputRef.current + ch).slice(0, 16);
      setInput(inputRef.current);
    }
  });

  const prompt = finished
    ? `${finished.error ? `Failed: ${finished.error}` : `Finished: ${finished.result?.status}`} · Enter to exit`
    : question
      ? `${question} ${input}`
      : "Running · Ctrl+C aborts";
  const promptLines = wrapCodeToWidth(sanitizeText(prompt), width).slice(0, 3);
  return h(
    Box,
    { flexDirection: "column", width, height: size.height, overflow: "hidden" },
    h(SwarmScreen, { state: swarm, width, height: swarmHeight }),
    h(
      Text,
      { color: forge.muted, wrap: "truncate" },
      truncateToWidth(
        `REVIEW · ${wrapped.length ? Math.min(offset, maxOffset) + 1 : 0}/${wrapped.length} · PgUp/PgDn`,
        width,
      ),
    ),
    h(
      Box,
      { flexDirection: "column", height: reviewHeight, overflow: "hidden" },
      ...visible.map((line, index) =>
        h(Text, { key: index, color: forge.text, wrap: "truncate" }, line),
      ),
    ),
    h(
      Box,
      { flexDirection: "column", height: 3, overflow: "hidden" },
      ...promptLines.map((line, index) =>
        h(Text, { key: index, color: forge.accent, wrap: "truncate" }, line),
      ),
    ),
    h(
      Text,
      { color: forge.muted, wrap: "truncate" },
      truncateToWidth("Enter submit · arrows scroll · Ctrl+C abort", width),
    ),
  );
}
