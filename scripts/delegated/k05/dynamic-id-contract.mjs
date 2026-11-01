// Source-only checks for dynamically rendered device-card IDs; no JS execution.
export function inspectDeviceCardIds(js) {
  const findings = [];
  const expression = js.match(/row\.innerHTML\s*=\s*\[([\s\S]*?)\]\.join\(''\)/);
  if (!expression) return ['missing-card-template'];
  const quoted = /'((?:\\.|[^'\\])*)'/g;
  const literals = [...expression[1].matchAll(quoted)];
  const remainder = expression[1].replace(quoted, '').replace(/[\s,]/g, '');
  if (remainder || !literals.length) findings.push('nonliteral-card-template');
  const html = literals.map((match) => match[1]).join('');
  if (/\bid\s*=\s*["']/i.test(html)) findings.push('repeated-static-id-in-card');
  if (!/<button\b[^>]*class="pc-settings-button"/i.test(html) ||
      !/<div\b[^>]*class="pc-settings-panel"/i.test(html)) {
    findings.push('missing-settings-button-or-panel');
  }
  if (!/pcPanel\.id\s*=\s*'pc-settings-'\s*\+\s*devices\.indexOf\(device\)/.test(js)) {
    findings.push('missing-indexed-panel-id');
  }
  if (!/pcButton\.setAttribute\('aria-controls',\s*pcPanel\.id\)/.test(js)) {
    findings.push('missing-panel-id-reference');
  }
  return findings;
}
