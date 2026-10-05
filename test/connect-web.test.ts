import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

test('hosted connect page keeps the normal user flow to one BAĞLA action', async () => {
  const [html, js] = await Promise.all([
    fs.readFile('web/connect.html', 'utf8'),
    fs.readFile('web/connect.js', 'utf8'),
  ]);

  assert.match(html, />BAĞLA<\/button>/);
  assert.match(
    html,
    /Kurulum ve güvenli bağlantının geri kalanını Nexowire tamamlar/,
  );
  assert.doesNotMatch(html, /id="plan"/);
  assert.doesNotMatch(html, /id="usage"/);
  assert.doesNotMatch(html, /control-plane|token|Tailscale/i);

  assert.match(
    js,
    /Ekstra erişim ayarı gerekmez/,
  );
  assert.match(
    js,
    /\/auth\/github\/start\?next=/,
  );
  assert.doesNotMatch(js, /dashboard\.planId/);
  assert.doesNotMatch(js, /usage\.monthlyCredits/);
});

test('connect page keeps technical pairing details out of user-facing copy', async () => {
  const html = await fs.readFile('web/connect.html', 'utf8');
  const js = await fs.readFile('web/connect.js', 'utf8');

  assert.doesNotMatch(
    html,
    /bearer|credential|capability|localhost|token|control-plane/i,
  );

  const visibleAssignments = [
    ...js.matchAll(
      /(?:textContent\s*=|new Error\()\s*['"`]([^'"`]+)['"`]/g,
    ),
  ].map((match) => match[1]).join('\n');

  assert.doesNotMatch(
    visibleAssignments,
    /bearer|credential|capability|localhost|token|pairing|control-plane/i,
  );
});
