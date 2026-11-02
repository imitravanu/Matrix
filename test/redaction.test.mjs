import test from "node:test";
import assert from "node:assert/strict";

import {
  REDACTED,
  WITHHELD,
  containsSecretFragment,
  createRedactor,
  redactedDetail,
  redactSecrets,
  secretVariants,
  truncateText,
} from "../lib/redaction.mjs";

const KEY = "sk-live/abc+def:ghi";

test("encoded credential forms are redacted, not just the literal key", () => {
  const forms = {
    literal: KEY,
    uri: encodeURIComponent(KEY),
    json: JSON.stringify(KEY).slice(1, -1),
    base64: Buffer.from(KEY, "utf8").toString("base64"),
    base64url: Buffer.from(KEY, "utf8").toString("base64url"),
    bearerBase64: Buffer.from(`Bearer ${KEY}`, "utf8").toString("base64"),
    lowerPercent: encodeURIComponent(KEY).replace(/%[0-9a-f]{2}/gi, (m) => m.toLowerCase()),
  };
  for (const [name, form] of Object.entries(forms)) {
    assert.ok(form.length > 0, name);
    const redacted = redactSecrets(`provider echoed ${form} in the body`, [KEY]);
    assert.equal(redacted.includes(form), false, `${name} form survived: ${redacted}`);
    assert.ok(redacted.includes(REDACTED), `${name} form was not marked`);
  }
  assert.ok(secretVariants(KEY).length >= 5);
  assert.deepEqual(secretVariants(""), []);
});

test("short credentials are matched as whole tokens instead of being skipped", () => {
  const redacted = redactSecrets("key=ab; notes about ab and xabcx", ["ab"]);
  assert.equal(redacted.includes("key=ab"), false);
  assert.equal(redacted.includes("about ab"), false);
  assert.equal(redacted.includes("xabcx"), true, "a substring match would corrupt ordinary words");
  assert.ok(redacted.includes(REDACTED));
});

test("redactedDetail redacts before truncating so no key prefix survives", () => {
  const prefix = "x".repeat(150);
  const detail = redactedDetail(`${prefix}${KEY}tail`, { secrets: [KEY], maxChars: 160 });
  assert.ok(detail.length <= 160);
  for (let index = 0; index + 4 <= KEY.length; index++) {
    assert.equal(detail.includes(KEY.slice(index, index + 4)), false, "key fragment leaked");
  }
  assert.ok(detail.startsWith(prefix));
});

test("an unknown encoding with a surviving fragment withholds the whole detail", () => {
  const fragment = KEY.slice(0, 5);
  const detail = redactedDetail(`HTTP 400 rejected ${fragment}...`, {
    secrets: [KEY],
    maxChars: 160,
  });
  assert.equal(detail, WITHHELD);
  assert.equal(
    redactedDetail("plain provider text", { secrets: [KEY], maxChars: 160 }),
    "plain provider text",
  );
  assert.equal(containsSecretFragment(fragment, KEY), true);
  assert.equal(containsSecretFragment("unrelated", KEY), false);
  assert.equal(containsSecretFragment("ab", "ab"), false);
});

test("the withheld marker's own text is never mistaken for key material", () => {
  const plain = redactedDetail("nothing secret here", { secrets: ["reda"], maxChars: 160 });
  assert.equal(plain, "nothing secret here");
  assert.equal(truncateText("abcdef", 3), "abc");
  assert.equal(truncateText("abc", 0), "");
});

test("createRedactor keeps short explicit values but ignores short environment values", () => {
  const redactor = createRedactor({ env: { COPY_TOKEN: "ab" }, secretValues: ["zz"] });
  assert.equal(redactor.text("value zz and token zz").includes("zz"), false);
  assert.equal(redactor.text("COPY_TOKEN=ab").includes("COPY_TOKEN=ab"), false);
  assert.equal(redactor.text("value ab").includes("value ab"), true);

  const long = createRedactor({ secretValues: [KEY] });
  assert.equal(long.text(`Authorization: Bearer ${KEY}`).includes(KEY), false);
  assert.equal(
    long.text(`token ${encodeURIComponent(KEY)}`).includes(encodeURIComponent(KEY)),
    false,
  );
});
