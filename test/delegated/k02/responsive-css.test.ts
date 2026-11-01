import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Offline CSS contract checks. These do not substitute for browser layout,
// viewport screenshots, keyboard navigation, or device acceptance tests.
const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/styles.css");
const css = readFileSync(cssPath, "utf8");

type Rule = {
  selectors: string[];
  declarations: Record<string, string>;
  maxWidth: number | null;
};

function blocks(source: string): Array<{ header: string; body: string }> {
  const found: Array<{ header: string; body: string }> = [];
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf("{", cursor);
    if (opening < 0) {
      assert.equal(source.slice(cursor).trim(), "", "unclosed or unexpected CSS text");
      break;
    }
    const header = source.slice(cursor, opening).trim();
    let depth = 1;
    let closing = opening + 1;
    for (; closing < source.length && depth > 0; closing++) {
      if (source[closing] === "{") depth++;
      else if (source[closing] === "}") depth--;
    }
    assert.equal(depth, 0, `unclosed CSS block: ${header}`);
    found.push({ header, body: source.slice(opening + 1, closing - 1) });
    cursor = closing;
  }
  return found;
}

function parse(source: string): Rule[] {
  const cleaned = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Rule[] = [];
  function walk(input: string, activeMaxWidth: number | null): void {
    for (const { header, body } of blocks(input)) {
      if (header.startsWith("@media")) {
        const match = /^@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)$/.exec(header);
        if (match) walk(body, Math.min(activeMaxWidth ?? Infinity, Number(match[1])));
        continue;
      }
      if (header.startsWith("@")) continue; // keyframes, supports, etc.
      const declarations: Record<string, string> = {};
      for (const part of body.split(";")) {
        const colon = part.indexOf(":");
        if (colon > -1) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
      found.push({ selectors: header.split(",").map((x) => x.trim()), declarations, maxWidth: activeMaxWidth });
    }
  }
  walk(cleaned, null);
  return found;
}

function property(rules: Rule[], selector: string, name: string, viewport: number): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if ((rule.maxWidth === null || viewport <= rule.maxWidth) && rule.selectors.includes(selector)) {
      value = rule.declarations[name] ?? value;
    }
  }
  return value;
}

const rules = parse(css);

test("responsive CSS blocks are balanced and both breakpoint thresholds are present", () => {
  assert.ok(rules.length > 80, "CSS parser unexpectedly skipped most of the stylesheet");
  assert.ok(rules.some((r) => r.maxWidth === 870), "870px breakpoint missing");
  assert.ok(rules.some((r) => r.maxWidth === 620), "620px breakpoint missing");
});

test("device and utility grids collapse at 870px, not above it", () => {
  for (const selector of [".device-list", ".utility-grid"]) {
    assert.equal(property(rules, selector, "grid-template-columns", 870), "1fr");
    assert.notEqual(property(rules, selector, "grid-template-columns", 871), "1fr");
  }
});

test("mobile shell and metrics use two columns at 620px and narrower", () => {
  assert.equal(property(rules, ".metrics", "grid-template-columns", 621), "repeat(3,minmax(0,1fr))");
  assert.equal(property(rules, ".shell", "width", 621), "min(1160px,calc(100% - 44px))");
  for (const viewport of [620, 375, 320]) {
    assert.equal(property(rules, ".metrics", "grid-template-columns", viewport), "repeat(2,minmax(0,1fr))");
    assert.equal(property(rules, ".usage-card", "grid-column", viewport), "1/-1");
    assert.equal(property(rules, ".shell", "width", viewport), "calc(100% - 30px)");
    assert.equal(property(rules, ".topbar", "padding", viewport), "0 16px");
  }
});

test("installation commands can wrap and their controls use full mobile width", () => {
  for (const viewport of [320, 375, 620]) {
    assert.equal(property(rules, ".install-command-row", "flex-wrap", viewport), "wrap");
    assert.equal(property(rules, ".install-command-row input", "flex-basis", viewport), "100%");
    assert.equal(property(rules, ".install-command-row button", "width", viewport), "100%");
  }
  assert.notEqual(property(rules, ".install-command-row", "flex-wrap", 621), "wrap");
});

test("intrinsic size guards prevent known text and grid min-content overflow", () => {
  assert.equal(property(rules, "*", "box-sizing", 320), "border-box");
  for (const selector of [".device", ".device-identity", ".utility-panel", ".install-command-row input"]) {
    assert.equal(property(rules, selector, "min-width", 320), "0", `${selector} lost min-width:0`);
  }
  assert.equal(property(rules, ".device-name", "overflow-wrap", 320), "anywhere");
  assert.equal(property(rules, ".policy-line>span:last-child", "overflow-wrap", 320), "anywhere");
  assert.equal(property(rules, ".policy-line", "grid-template-columns", 375), "60px minmax(0,1fr)");
  assert.equal(property(rules, ".device-list", "grid-template-columns", 900), "repeat(2,minmax(0,1fr))");
  assert.doesNotMatch(css, /(?:body|html)\s*\{[^}]*overflow-x\s*:\s*hidden/i, "do not hide page-level overflow to mask a layout defect");
});

test("regression sentinels reject removed mobile wrap and shrink protection", () => {
  const withoutWrap = parse(css.replace(/(\.install-command-row\s*\{\s*)flex-wrap:wrap;/, "$1"));
  assert.notEqual(property(withoutWrap, ".install-command-row", "flex-wrap", 375), "wrap");
  const withoutShrink = parse(css.replace(/(\.device-identity\s*\{[^}]*?)min-width:\s*0;/, "$1"));
  assert.notEqual(property(withoutShrink, ".device-identity", "min-width", 320), "0");
});
