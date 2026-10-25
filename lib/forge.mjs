// ============================================================================
// Matrix theme tokens
//
// Colour roles are load-bearing, not decorative:
//   - `text`  body copy that must always be readable
//   - `muted` secondary copy, still readable
//   - `dim`   rules, separators and decoration ONLY. Never readable text.
//   Keeping these roles distinct is what makes contrast testable; see
//   test/contrast.test.mjs, which asserts a contrast ratio for each role.
// ============================================================================

export const forge = {
  text: "#E6F8EE", // primary text: light phosphor green-white
  muted: "#84A98C", // secondary text: readable matrix sage green
  dim: "#2E593F", // rules and decoration ONLY: deep emerald green
  rule: "#1B382B", // rule divider: dark matrix green
  accent: "#00FF41", // iconic Matrix phosphor green
  steel: "#00FF41", // resting colour of the matrix wordmark

  // Wordmark digital rain heat ramp: [k, color], k = 1 white-hot ... 0 matrix green.
  // Interpolated linearly in RGB by heatColor().
  heat: [
    [0, "#00FF41"],
    [0.25, "#22E555"],
    [0.5, "#4EFA75"],
    [0.75, "#99FFB3"],
    [1, "#E8FFE8"],
  ],

  spark: { flash: "#E8FFE8", core: "#A6FFB8" }, // glowing core above the "i"

  ok: "#00FF41",
  warn: "#FFB347",
  err: "#FF6B6B",
  info: "#00E5FF",
};

// Diff backgrounds, used in the permission screen. Kept near-black with
// just enough tint to read as a change without shifting foreground contrast.
export const forgeBg = {
  del: "#331B1B",
  add: "#1B3322",
};

// --- colour maths -----------------------------------------------------------

const hexCache = new Map();

/** "#RRGGBB" -> [r, g, b] 0..255. Memoised: called once per pixel per frame.
 * Returns a fresh copy each call so callers cannot corrupt the cache. */
export function hexToRgb(hex) {
  const key = typeof hex === "string" ? hex.toLowerCase() : hex;
  const hit = hexCache.get(key);
  if (hit) return [...hit];
  let out;
  if (typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    const n = parseInt(hex.slice(1), 16);
    out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else {
    out = [255, 255, 255]; // fail loud in colour, not in layout
  }
  hexCache.set(key, out);
  return [...out];
}

/** [r, g, b] (floats) -> "#RRGGBB", rounded and clamped. */
export function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/**
 * Sample the heat ramp at k in [0, 1]. Clamped outside the range so callers
 * never have to bounds-check. Returns a valid lowercase "#RRGGBB" for every input.
 */
export function heatColor(k) {
  const ramp = forge.heat;
  if (typeof k !== "number" || Number.isNaN(k) || k <= 0) return ramp[0][1].toLowerCase();
  if (k >= 1) return ramp[ramp.length - 1][1].toLowerCase();
  for (let i = 0; i < ramp.length - 1; i++) {
    const [k0, c0] = ramp[i];
    const [k1, c1] = ramp[i + 1];
    if (k >= k0 && k <= k1) {
      const f = k1 === k0 ? 0 : (k - k0) / (k1 - k0);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      return rgbToHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
    }
  }
  return forge.steel.toLowerCase();
}
