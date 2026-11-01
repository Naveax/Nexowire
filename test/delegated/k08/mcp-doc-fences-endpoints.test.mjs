import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const architecture = read('docs/ARCHITECTURE.md');
const surface = read('docs/MCP_SURFACE.md');
const packageJson = JSON.parse(read('package.json'));

function extractFences(markdown) {
  let active = null;
  const fences = [];
  for (const [index, line] of markdown.split('\n').entries()) {
    const marker = /^```([^`]*)$/.exec(line.trim());
    if (marker) {
      if (active) {
        assert.equal(marker[1], '', `Closing fence must not have a language at line ${index + 1}`);
        fences.push(active);
        active = null;
      } else {
        const lang = marker[1].trim();
        assert.ok(['bash', 'json', 'text'].includes(lang), `Missing/unsupported fence language at line ${index + 1}`);
        active = { lang, content: [] };
      }
      continue;
    }
    if (active) active.content.push(line);
  }
  assert.equal(active, null, 'Every code fence must close');
  return fences;
}

function checkCommands(markdown) {
  for (const fence of extractFences(markdown)) {
    if (fence.lang === 'json') {
      assert.doesNotThrow(() => JSON.parse(fence.content.join('\n')), 'JSON example must parse');
    }
    if (fence.lang !== 'bash') continue;
    for (const line of fence.content) {
      const script = /^npm run ([a-zA-Z0-9:._-]+)$/.exec(line.trim());
      if (script) assert.ok(Object.hasOwn(packageJson.scripts, script[1]), `Undeclared npm script: ${script[1]}`);
      if (/^node --test /.test(line.trim())) {
        const testFiles = line.trim().split(' ').filter((part) => part.startsWith('test/'));
        assert.ok(testFiles.length > 0, 'Node test command must name test files');
        for (const file of testFiles) assert.ok(existsSync(resolve(root, file)), `Missing test file: ${file}`);
      }
      assert.doesNotMatch(line, /(?:sudo\s|rm\s+-rf|git\s+push\s+--force)/, 'K08 examples must remain non-destructive');
    }
  }
}

test('K08 docs use closed labeled code fences and only existing scripts/test paths', () => {
  assert.ok(extractFences(architecture).length >= 1);
  assert.ok(extractFences(surface).length >= 3);
  checkCommands(architecture);
  checkCommands(surface);
});

test('negative code-fence and command fixtures fail instead of silently passing', () => {
  assert.throws(() => extractFences(surface.replace('```bash', '```')), /fence language/);
  assert.throws(() => checkCommands(surface.replace('npm run typecheck', 'npm run nonexisting_task_123')),
    /Undeclared npm script/);
  assert.throws(() => extractFences(surface + '\n```bash\n'), /Every code fence must close/);
});

function verifyEndpoints(document, http, ws, stdio) {
  for (const [docTerm, sourceTerm] of [
    ['`POST /mcp`', "app.post('/mcp'"],
    ['`GET /mcp`', "app.get('/mcp'"],
    ['`DELETE /mcp`', "app.delete('/mcp'"],
    ['`GET /health`', "app.get('/health'"],
  ]) {
    assert.ok(document.includes(docTerm), `Missing documented endpoint ${docTerm}`);
    assert.ok(http.includes(sourceTerm), `Endpoint not backed by HTTP source: ${sourceTerm}`);
  }
  assert.match(http, /app\.get\('\/mcp'[^]*?res\.status\(405\)/);
  assert.match(http, /app\.delete\('\/mcp'[^]*?res\.status\(405\)/);
  assert.ok(document.includes('`/agent`'));
  assert.ok(ws.includes("url.pathname !== '/agent'"));
  assert.ok(document.includes('stdio'));
  assert.ok(stdio.includes('StdioServerTransport'));
  assert.match(document, /not a public deployment address/i);
  assert.match(document, /not.*ChatGPT MCP URL/i);
}

test('architecture route labels match HTTP, WebSocket and stdio code boundaries', () => {
  verifyEndpoints(architecture, read('src/mcp/http.ts'),
    read('src/hub/agent-websocket.ts'), read('src/mcp/stdio.ts'));
  assert.throws(() => verifyEndpoints(architecture.replaceAll('`POST /mcp`', '`POST /mcpx`'),
    read('src/mcp/http.ts'), read('src/hub/agent-websocket.ts'), read('src/mcp/stdio.ts')),
  /Missing documented endpoint/);
});
