import test from "node:test";
import assert from "node:assert/strict";

import { forge, forgeBg, hexToRgb } from "../lib/forge.mjs";

function luminance(hex) {
  const channels = hexToRgb(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("readable theme roles meet WCAG AA on workbench backgrounds", () => {
  const backgrounds = ["#0B0C0E", "#000000", forgeBg.add, forgeBg.del];
  const roles = ["text", "muted", "accent", "ok", "warn", "err", "info"];
  for (const role of roles) {
    for (const background of backgrounds) {
      const ratio = contrast(forge[role], background);
      assert.ok(ratio >= 4.5, `${role} on ${background}: ${ratio.toFixed(2)}:1 is below 4.5:1`);
    }
  }
});

test("decorative dim is not needed for functional text contrast", () => {
  assert.ok(contrast(forge.dim, "#0B0C0E") < 4.5);
  for (const background of ["#0B0C0E", forgeBg.add, forgeBg.del]) {
    assert.ok(contrast(forge.muted, background) >= 4.5);
  }
});
