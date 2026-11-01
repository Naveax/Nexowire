import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Offline CSS contract checks. These do not substitute for browser layout,
// viewport screenshots, keyboard navigation, or device acceptance tests.
const cssPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/styles.css");
const css = readFileSync(cssPath, "utf8");
const fixture = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "overflow-fixtures.html"), "utf8");

type Rule = {
  selectors: string[];
  declarations: Record<string, string>;
  maxWidth: number | null;
  features: string[];
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
  function walk(input: string, activeMaxWidth: number | null, features: string[]): void {
    for (const { header, body } of blocks(input)) {
      if (header.startsWith("@media")) {
        const match = /^@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)$/.exec(header);
        if (match) {
          walk(body, Math.min(activeMaxWidth ?? Infinity, Number(match[1])), features);
          continue;
        }
        const feature = /^@media\s*\(\s*(forced-colors|prefers-reduced-motion)\s*:\s*(active|reduce)\s*\)$/.exec(header);
        if (feature) walk(body, activeMaxWidth, [...features, `${feature[1]}:${feature[2]}`]);
        continue;
      }
      if (header.startsWith("@")) continue; // keyframes, supports, etc.
      const declarations: Record<string, string> = {};
      for (const part of body.split(";")) {
        const colon = part.indexOf(":");
        if (colon > -1) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
      found.push({ selectors: header.split(",").map((x) => x.trim()), declarations, maxWidth: activeMaxWidth, features });
    }
  }
  walk(cleaned, null, []);
  return found;
}

function property(rules: Rule[], selector: string, name: string, viewport: number, features: string[] = []): string | undefined {
  let value: string | undefined;
  for (const rule of rules) {
    if ((rule.maxWidth === null || viewport <= rule.maxWidth) &&
        rule.features.every((f) => features.includes(f)) && rule.selectors.includes(selector)) {
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
    assert.equal(property(rules, ".topbar", "padding", viewport), "10px 16px");
  }
});

test("narrow headers and connection cards wrap instead of forcing horizontal scrolling", () => {
  for (const viewport of [320, 375, 620]) {
    assert.equal(property(rules, ".topbar", "height", viewport), "auto");
    assert.equal(property(rules, ".topbar", "min-height", viewport), "62px");
    assert.equal(property(rules, ".topbar", "flex-wrap", viewport), "wrap");
    assert.equal(property(rules, ".topbar-right", "min-width", viewport), "0");
    assert.equal(property(rules, ".topbar-right", "flex-wrap", viewport), "wrap");
    assert.equal(property(rules, ".topbar .pill", "white-space", viewport), "normal");
    assert.equal(property(rules, ".topbar .pill", "overflow-wrap", viewport), "anywhere");
    assert.equal(property(rules, ".connect-title-row", "flex-wrap", viewport), "wrap");
    assert.equal(property(rules, ".connect-title-row > *", "min-width", viewport), "0");
  }
  assert.notEqual(property(rules, ".topbar", "flex-wrap", 621), "wrap");
  assert.notEqual(property(rules, ".connect-title-row", "flex-wrap", 621), "wrap");
});

test("form controls have a consistent visible keyboard focus outline", () => {
  for (const selector of ["button:focus-visible", "input:focus-visible", "select:focus-visible", "textarea:focus-visible"]) {
    assert.equal(property(rules, selector, "outline", 375), "2px solid var(--accent)");
    assert.equal(property(rules, selector, "outline-offset", 375), "3px");
  }
});

test("narrow status/error text can break and action rows can wrap", () => {
  for (const selector of [".error-panel", ".folder-feedback", ".folder-assign-status", "#copy-status", "#auto-status"]) {
    assert.equal(property(rules, selector, "overflow-wrap", 320), "anywhere", selector);
  }
  for (const viewport of [320, 375, 620]) {
    assert.equal(property(rules, ".device-foot", "flex-wrap", viewport), "wrap");
    assert.equal(property(rules, ".connect-breadcrumb", "flex-wrap", viewport), "wrap");
  }
  assert.notEqual(property(rules, ".device-foot", "flex-wrap", 621), "wrap");
});

test("disabled action buttons do not inherit enabled hover effects", () => {
  const guarded = [
    ".filter-button:not(:disabled):hover",
    ".layout-button:not(:disabled):hover",
    ".core-shortcut:not(:disabled):hover",
    ".pc-settings-button:not(:disabled):hover",
    '.os-tabs [role="tab"]:not(:disabled):hover',
  ];
  const unguarded = [
    ".filter-button:hover", ".layout-button:hover", ".core-shortcut:hover",
    ".pc-settings-button:hover", '.os-tabs [role="tab"]:hover',
  ];
  for (const selector of guarded) {
    assert.ok(rules.some((rule) => rule.selectors.includes(selector)), `guard absent: ${selector}`);
  }
  for (const selector of unguarded) {
    assert.ok(!rules.some((rule) => rule.selectors.includes(selector)), `disabled hover remains: ${selector}`);
  }
  assert.equal(property(rules, "button:disabled", "cursor", 375), "not-allowed");
});

test("dead overwritten CSS declarations stay removed without changing the final values", () => {
  assert.equal(property(rules, ".connect-shell", "max-width", 900), "870px");
  assert.equal(property(rules, ".policy-steps", "display", 900), "grid");
  assert.equal(property(rules, ".policy-steps", "gap", 900), "0");
  const connectWidths = rules.filter((r) => r.selectors.includes(".connect-shell") && r.declarations["max-width"]);
  const policyGaps = rules.filter((r) => r.selectors.includes(".policy-steps") && r.declarations.gap);
  assert.equal(connectWidths.length, 1, "redundant .connect-shell max-width override reintroduced");
  assert.equal(policyGaps.length, 1, "redundant .policy-steps gap override reintroduced");
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

test("320/375/768px CSS matrix rejects a restored two-column device grid", () => {
  for (const viewport of [320, 375, 768]) {
    assert.equal(property(rules, ".device-list", "grid-template-columns", viewport), "1fr");
    assert.equal(property(rules, ".utility-grid", "grid-template-columns", viewport), "1fr");
    assert.equal(property(rules, ".shell", "width", viewport), viewport <= 620
      ? "calc(100% - 30px)" : "min(1160px,calc(100% - 44px))");
  }
  const broken = parse(css.replace(/(\.device-list\s*\{\s*)grid-template-columns:1fr;/, "$1"));
  assert.notEqual(property(broken, ".device-list", "grid-template-columns", 768), "1fr");
  assert.equal(property(rules, ".metrics", "grid-template-columns", 768), "repeat(3,minmax(0,1fr))");
});

test("long Unicode names and unbroken URLs retain mobile wrap guards", () => {
  assert.match(fixture, /id="unicode-device"/);
  assert.match(fixture, /İŞİİŞİ-🖥️/u);
  assert.match(fixture, /id="long-url">https:\/\/invalid\.example\.test\/tenant\/[a-f0-9]{100,}/);
  assert.match(fixture, /id="url-device"/);
  for (const viewport of [320, 375]) {
    assert.equal(property(rules, ".device-name", "overflow-wrap", viewport), "anywhere");
    assert.equal(property(rules, ".error-panel", "overflow-wrap", viewport), "anywhere");
    assert.equal(property(rules, ".device-header .status", "white-space", viewport), "normal");
    assert.equal(property(rules, ".device-header .status", "overflow-wrap", viewport), "anywhere");
    assert.equal(property(rules, ".device-header .status", "min-width", viewport), "0");
    assert.equal(property(rules, ".bridge-live-status", "overflow-wrap", viewport), "anywhere");
    assert.equal(property(rules, ".pc-settings-label strong", "white-space", viewport), "normal");
  }
});

test("forced-colors focus ring remains visible without relying on accent color", () => {
  for (const selector of [
    "button:focus-visible", "input:focus-visible", "select:focus-visible",
    "textarea:focus-visible", ".bridge-toggle:focus-visible",
  ]) {
    assert.equal(property(rules, selector, "outline", 375, ["forced-colors:active"]), "3px solid Highlight !important");
    assert.equal(property(rules, selector, "outline-offset", 375, ["forced-colors:active"]), "3px");
  }
});

test("200%/400% zoom proxy preserves shrink and mobile fallback contracts", () => {
  // CSS-width proxies (1280px physical viewport / zoom). No browser zoom run is claimed.
  const cases = [
    { zoom: 200, cssWidth: 640, mobile: false },
    { zoom: 400, cssWidth: 320, mobile: true },
  ];
  for (const { cssWidth, mobile } of cases) {
    assert.equal(property(rules, ".device-list", "grid-template-columns", cssWidth), "1fr");
    assert.equal(property(rules, ".device", "min-width", cssWidth), "0");
    assert.equal(property(rules, ".utility-panel", "min-width", cssWidth), "0");
    assert.equal(property(rules, ".topbar", "flex-wrap", cssWidth) === "wrap", mobile);
    assert.equal(property(rules, ".metrics", "grid-template-columns", cssWidth), mobile
      ? "repeat(2,minmax(0,1fr))" : "repeat(3,minmax(0,1fr))");
  }
});

test("busy spinner stays decorative and reduced motion removes its animation", () => {
  const spinner = '#approve[data-busy="true"]::after';
  assert.match(fixture, /id="approve"[^>]+data-busy="true"[^>]+disabled>BAĞLANIYOR/);
  assert.equal(property(rules, spinner, "animation", 375), "button-spin .7s linear infinite");
  assert.equal(property(rules, "*::after", "animation", 375, ["prefers-reduced-motion:reduce"]), "none !important");
  assert.equal(property(rules, spinner, "border-right-color", 375, ["prefers-reduced-motion:reduce"]), "currentColor");
  assert.match(css, /@keyframes button-spin\s*\{/);
});

test("same-selector duplicate cleanup preserves effective CSS values across viewports", () => {
  // This is a limited cascade contract, not a full browser style-equivalence proof.
  const withoutShadowedDisplay = parse(css.replace(/(\.device-list\.list-view \.device\s*\{\s*)display:grid;/, "$1"));
  for (const width of [320, 375, 620, 621, 768, 870, 871, 1280]) {
    for (const [selector, name] of [
      [".device-list.list-view .device", "display"],
      [".connect-shell", "max-width"],
      [".policy-steps", "gap"],
    ]) {
      assert.equal(property(withoutShadowedDisplay, selector, name, width),
        property(rules, selector, name, width), `${selector} ${name} changed at ${width}px`);
    }
  }
  assert.equal(property(rules, ".device-list.list-view .device", "display", 1280), "block");
});
