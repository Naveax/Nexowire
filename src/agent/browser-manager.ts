import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

export type BrowserKind = 'edge' | 'chrome';

export interface BrowserSessionSummary {
  id: string;
  browser: BrowserKind;
  pid: number | null;
  port: number;
  createdAt: string;
  headless: boolean;
  status: 'running' | 'exited';
  exitCode: number | null;
}

export interface BrowserTextSnapshot {
  text: string;
  chars: number;
  truncated: boolean;
}

export interface BrowserElementSnapshot {
  selector: string;
  tag: string;
  type: string | null;
  role: string | null;
  name: string | null;
  text: BrowserTextSnapshot;
  value: BrowserTextSnapshot | null;
  password: boolean;
  disabled: boolean;
  checked: boolean | null;
  href: string | null;
  visible: boolean;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface BrowserPageSnapshot {
  url: string;
  title: string;
  readyState: string;
  bodyText: BrowserTextSnapshot;
  elements: BrowserElementSnapshot[];
  elementsScanned: number;
  elementsReturned: number;
  elementsTruncated: boolean;
}

interface BrowserSession extends BrowserSessionSummary {
  executable: string;
  userDataDir: string;
  process: ChildProcess;
  stderr: string;
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class BrowserControlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserControlError';
  }
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(raw.toString()) as CdpMessage;
      } catch {
        return;
      }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          new BrowserControlError(
            'CDP_ERROR',
            message.error.message,
            {
              cdpCode: message.error.code,
              data: message.error.data,
            },
          ),
        );
        return;
      }
      pending.resolve(message.result);
    });

    socket.on('close', () => {
      for (const [requestId, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          new BrowserControlError(
            'CDP_DISCONNECTED',
            'Browser DevTools connection closed.',
            { requestId },
          ),
        );
      }
      this.pending.clear();
    });
  }

  static async connect(
    url: string,
    timeoutMs = 10_000,
  ): Promise<CdpClient> {
    return await new Promise<CdpClient>((resolve, reject) => {
      const socket = new WebSocket(url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(
          new BrowserControlError(
            'CDP_CONNECT_TIMEOUT',
            'Timed out connecting to Browser DevTools.',
          ),
        );
      }, timeoutMs);

      socket.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
      socket.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new BrowserControlError(
        'CDP_DISCONNECTED',
        'Browser DevTools connection is not open.',
      );
    }

    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BrowserControlError(
            'CDP_REQUEST_TIMEOUT',
            'Browser DevTools request timed out.',
            { method, timeoutMs },
          ),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(
        JSON.stringify({ id, method, params }),
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        },
      );
    });
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(1000, 'Nexowire operation complete');
    }
  }
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export function validateBrowserUrl(value: string): string {
  if (value === 'about:blank') return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserControlError(
      'BROWSER_URL_INVALID',
      'Browser URL is invalid.',
      { url: value },
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BrowserControlError(
      'BROWSER_URL_SCHEME_DENIED',
      'Browser automation permits only HTTP(S) and about:blank URLs.',
      { protocol: parsed.protocol },
    );
  }
  return parsed.toString();
}

function pngDimensions(bytes: Buffer): {
  width: number;
  height: number;
} {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(signature)
  ) {
    throw new BrowserControlError(
      'BROWSER_SCREENSHOT_INVALID',
      'Browser returned an invalid PNG screenshot.',
    );
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function publicSession(
  session: BrowserSession,
): BrowserSessionSummary {
  return {
    id: session.id,
    browser: session.browser,
    pid: session.pid,
    port: session.port,
    createdAt: session.createdAt,
    headless: session.headless,
    status: session.status,
    exitCode: session.exitCode,
  };
}

export interface BrowserManagerOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}

export class BrowserManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly rootDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: BrowserManagerOptions = {}) {
    this.rootDir =
      options.rootDir ??
      path.join(os.homedir(), '.nexowire', 'browser-sessions');
    this.env = options.env ?? process.env;
  }

  async start(input: {
    browser?: 'auto' | BrowserKind;
    headless?: boolean;
    initialUrl?: string;
    width?: number;
    height?: number;
  }) {
    const browser = input.browser ?? 'auto';
    const headless = input.headless ?? true;
    const width = Math.min(3840, Math.max(320, input.width ?? 1440));
    const height = Math.min(2160, Math.max(240, input.height ?? 900));
    const initialUrl = validateBrowserUrl(
      input.initialUrl ?? 'about:blank',
    );
    const resolved = await this.resolveBrowser(browser);
    const id = randomUUID();
    const userDataDir = path.join(this.rootDir, id);
    await fs.mkdir(userDataDir, { recursive: true });

    const args = [
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + userDataDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-extensions',
      '--window-size=' + width + ',' + height,
      ...(headless ? ['--headless=new'] : []),
      initialUrl,
    ];

    const child = spawn(resolved.executable, args, {
      windowsHide: headless,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= 32_768) return;
      stderr += chunk.toString('utf8').slice(
        0,
        32_768 - stderr.length,
      );
    });

    try {
      const port = await this.waitForPort(
        userDataDir,
        child,
        () => stderr,
      );
      const session: BrowserSession = {
        id,
        browser: resolved.browser,
        executable: resolved.executable,
        pid: child.pid ?? null,
        port,
        createdAt: new Date().toISOString(),
        headless,
        status: 'running',
        exitCode: null,
        userDataDir,
        process: child,
        stderr,
      };
      child.once('exit', (code) => {
        session.status = 'exited';
        session.exitCode = code;
      });
      this.sessions.set(id, session);
      return {
        ...publicSession(session),
        initialUrl,
      };
    } catch (error) {
      await this.terminate(child);
      await fs.rm(userDataDir, {
        recursive: true,
        force: true,
      });
      throw error;
    }
  }

  list(): BrowserSessionSummary[] {
    return [...this.sessions.values()]
      .map((session) => {
        if (
          session.status === 'running' &&
          !isAlive(session.process)
        ) {
          session.status = 'exited';
          session.exitCode = session.process.exitCode;
        }
        return publicSession(session);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async stop(sessionId: string) {
    const session = this.requireSession(sessionId);
    const wasRunning =
      session.status === 'running' && isAlive(session.process);
    if (wasRunning) await this.terminate(session.process);
    session.status = 'exited';
    session.exitCode = session.process.exitCode;
    this.sessions.delete(sessionId);

    let removedProfile = false;
    try {
      await fs.rm(session.userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 100,
      });
      removedProfile = true;
    } catch {
      // Browser shutdown can briefly leave Windows profile files locked.
    }
    return { sessionId, stopped: wasRunning, removedProfile };
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.stop(id)),
    );
  }

  async tabs(sessionId: string) {
    const session = this.requireRunning(sessionId);
    const targets = await this.targets(session);
    return {
      sessionId,
      tabs: targets
        .filter((target) => target.type === 'page')
        .map((target) => ({
          id: target.id,
          title: target.title,
          url: target.url,
        })),
    };
  }

  async navigate(input: {
    sessionId: string;
    targetId?: string;
    url: string;
    timeoutMs?: number;
  }) {
    const requestedUrl = validateBrowserUrl(input.url);
    const timeoutMs = Math.min(
      60_000,
      Math.max(1_000, input.timeoutMs ?? 30_000),
    );
    return await this.withPage(
      input.sessionId,
      input.targetId,
      async (client, target) => {
        await client.send('Page.enable');
        const navigation = await client.send<{
          errorText?: string;
        }>('Page.navigate', { url: requestedUrl }, timeoutMs);

        if (navigation.errorText) {
          throw new BrowserControlError(
            'BROWSER_NAVIGATION_FAILED',
            navigation.errorText,
            { requestedUrl },
          );
        }

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const state = await this.evaluate<{
            readyState: string;
            url: string;
            title: string;
          }>(
            client,
            '({readyState:document.readyState,url:location.href,title:document.title})',
            5_000,
          );
          if (
            state.readyState === 'interactive' ||
            state.readyState === 'complete'
          ) {
            return {
              sessionId: input.sessionId,
              targetId: target.id,
              requestedUrl,
              ...state,
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        throw new BrowserControlError(
          'BROWSER_NAVIGATION_TIMEOUT',
          'Timed out waiting for browser document readiness.',
          { requestedUrl },
        );
      },
    );
  }

  async snapshot(input: {
    sessionId: string;
    targetId?: string;
    maxElements?: number;
    maxTextChars?: number;
    maxElementTextChars?: number;
    includeHidden?: boolean;
  }) {
    const maxElements = Math.min(
      1000,
      Math.max(1, input.maxElements ?? 250),
    );
    const maxTextChars = Math.min(
      100_000,
      Math.max(1, input.maxTextChars ?? 20_000),
    );
    const maxElementTextChars = Math.min(
      4096,
      Math.max(1, input.maxElementTextChars ?? 500),
    );
    const includeHidden = input.includeHidden ?? false;

    const expression = `(() => {
      const maxElements = ${maxElements};
      const maxTextChars = ${maxTextChars};
      const maxElementTextChars = ${maxElementTextChars};
      const includeHidden = ${includeHidden ? 'true' : 'false'};
      const clip = (value, limit) => {
        const text = String(value ?? '');
        return { text: text.slice(0, limit), chars: text.length, truncated: text.length > limit };
      };
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      const selectorFor = (element) => {
        if (element.id) {
          const candidate = '#' + CSS.escape(element.id);
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        }
        const parts = [];
        let current = element;
        while (current && current !== document.documentElement) {
          const tag = current.tagName.toLowerCase();
          let index = 1;
          let sibling = current.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === current.tagName) index++;
            sibling = sibling.previousElementSibling;
          }
          parts.unshift(tag + ':nth-of-type(' + index + ')');
          const candidate = parts.join(' > ');
          if (document.querySelectorAll(candidate).length === 1) return candidate;
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      const candidates = Array.from(document.querySelectorAll(
        'a[href],button,input,textarea,select,summary,[role],[contenteditable="true"]'
      ));
      const elements = [];
      for (const element of candidates) {
        if (elements.length >= maxElements) break;
        const isVisible = visible(element);
        if (!includeHidden && !isVisible) continue;
        const rect = element.getBoundingClientRect();
        const tag = element.tagName.toLowerCase();
        const type = tag === 'input'
          ? String(element.getAttribute('type') || 'text').toLowerCase()
          : null;
        const password = tag === 'input' && type === 'password';
        const text = clip(
          element.getAttribute('aria-label') ||
          element.getAttribute('placeholder') ||
          element.innerText ||
          element.textContent ||
          '',
          maxElementTextChars
        );
        let value = null;
        if (!password && 'value' in element) {
          value = clip(element.value, maxElementTextChars);
        }
        elements.push({
          selector: selectorFor(element),
          tag,
          type,
          role: element.getAttribute('role'),
          name: element.getAttribute('aria-label') ||
            element.getAttribute('name') ||
            element.getAttribute('placeholder') || null,
          text,
          value,
          password,
          disabled: Boolean(element.disabled) ||
            element.getAttribute('aria-disabled') === 'true',
          checked: 'checked' in element ? Boolean(element.checked) : null,
          href: tag === 'a' && element.href ? String(element.href) : null,
          visible: isVisible,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        });
      }
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: clip(document.body?.innerText || '', maxTextChars),
        elements,
        elementsScanned: candidates.length,
        elementsReturned: elements.length,
        elementsTruncated: elements.length >= maxElements
      };
    })()`;

    return await this.withPage(
      input.sessionId,
      input.targetId,
      async (client, target) => ({
        sessionId: input.sessionId,
        targetId: target.id,
        ...(await this.evaluate<BrowserPageSnapshot>(
          client,
          expression,
          15_000,
        )),
      }),
    );
  }

  async click(input: {
    sessionId: string;
    targetId?: string;
    selector: string;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
  }) {
    const button = input.button ?? 'left';
    const clickCount = Math.min(
      3,
      Math.max(1, input.clickCount ?? 1),
    );
    const selectorJson = JSON.stringify(input.selector);

    return await this.withPage(
      input.sessionId,
      input.targetId,
      async (client, target) => {
        const point = await this.evaluate<{
          ok: boolean;
          code?: string;
          count?: number;
          x?: number;
          y?: number;
        }>(
          client,
          `(() => {
            let matches;
            try { matches = Array.from(document.querySelectorAll(${selectorJson})); }
            catch { return { ok:false, code:'BROWSER_SELECTOR_INVALID' }; }
            if (matches.length === 0) return { ok:false, code:'BROWSER_ELEMENT_NOT_FOUND', count:0 };
            if (matches.length !== 1) return { ok:false, code:'BROWSER_ELEMENT_AMBIGUOUS', count:matches.length };
            const element = matches[0];
            element.scrollIntoView({ block:'center', inline:'center', behavior:'instant' });
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const disabled = Boolean(element.disabled) ||
              element.getAttribute('aria-disabled') === 'true';
            if (disabled || style.display === 'none' || style.visibility === 'hidden' ||
                rect.width <= 0 || rect.height <= 0) {
              return { ok:false, code:'BROWSER_ELEMENT_NOT_INTERACTABLE' };
            }
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            const hit = document.elementFromPoint(x, y);
            if (!hit || (hit !== element && !element.contains(hit))) {
              return { ok:false, code:'BROWSER_ELEMENT_OCCLUDED' };
            }
            return { ok:true, x, y };
          })()`,
          10_000,
        );

        if (
          !point.ok ||
          point.x === undefined ||
          point.y === undefined
        ) {
          throw new BrowserControlError(
            point.code ?? 'BROWSER_ELEMENT_NOT_INTERACTABLE',
            'Browser element could not be clicked safely.',
            { selector: input.selector, count: point.count },
          );
        }

        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'none',
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button,
          clickCount,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button,
          clickCount,
        });

        return {
          sessionId: input.sessionId,
          targetId: target.id,
          selector: input.selector,
          button,
          clickCount,
          point: { x: point.x, y: point.y },
          verified: true,
        };
      },
    );
  }

  async setValue(input: {
    sessionId: string;
    targetId?: string;
    selector: string;
    value: string;
  }) {
    if (input.value.length > 20_000) {
      throw new BrowserControlError(
        'BROWSER_VALUE_TOO_LARGE',
        'Browser value is limited to 20,000 characters.',
      );
    }

    const selectorJson = JSON.stringify(input.selector);
    const valueJson = JSON.stringify(input.value);
    return await this.withPage(
      input.sessionId,
      input.targetId,
      async (client, target) => {
        const result = await this.evaluate<{
          ok: boolean;
          code?: string;
          count?: number;
          chars?: number;
          password?: boolean;
        }>(
          client,
          `(() => {
            let matches;
            try { matches = Array.from(document.querySelectorAll(${selectorJson})); }
            catch { return { ok:false, code:'BROWSER_SELECTOR_INVALID' }; }
            if (matches.length === 0) return { ok:false, code:'BROWSER_ELEMENT_NOT_FOUND', count:0 };
            if (matches.length !== 1) return { ok:false, code:'BROWSER_ELEMENT_AMBIGUOUS', count:matches.length };
            const element = matches[0];
            const requested = ${valueJson};
            const tag = element.tagName.toLowerCase();
            const type = tag === 'input' ? String(element.type || 'text').toLowerCase() : null;
            if (tag === 'input' && type === 'file') return { ok:false, code:'BROWSER_VALUE_UNSUPPORTED' };
            if (tag === 'input') {
              const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value'
              )?.set;
              if (!setter) return { ok:false, code:'BROWSER_VALUE_UNSUPPORTED' };
              element.focus();
              setter.call(element, requested);
            } else if (tag === 'textarea') {
              const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                'value'
              )?.set;
              if (!setter) return { ok:false, code:'BROWSER_VALUE_UNSUPPORTED' };
              element.focus();
              setter.call(element, requested);
            } else if (tag === 'select') {
              const setter = Object.getOwnPropertyDescriptor(
                HTMLSelectElement.prototype,
                'value'
              )?.set;
              if (!setter) return { ok:false, code:'BROWSER_VALUE_UNSUPPORTED' };
              setter.call(element, requested);
            } else if (element.isContentEditable) {
              element.focus();
              element.textContent = requested;
            } else {
              return { ok:false, code:'BROWSER_VALUE_UNSUPPORTED' };
            }
            element.dispatchEvent(new Event('input', { bubbles:true }));
            element.dispatchEvent(new Event('change', { bubbles:true }));
            const actual = 'value' in element ? String(element.value) : String(element.textContent || '');
            return {
              ok: actual === requested,
              code: actual === requested ? undefined : 'BROWSER_VALUE_NOT_VERIFIED',
              chars: actual.length,
              password: tag === 'input' && type === 'password'
            };
          })()`,
          10_000,
        );

        if (!result.ok) {
          throw new BrowserControlError(
            result.code ?? 'BROWSER_VALUE_NOT_VERIFIED',
            'Browser value update failed verification.',
            { selector: input.selector, count: result.count },
          );
        }

        return {
          sessionId: input.sessionId,
          targetId: target.id,
          selector: input.selector,
          chars: result.chars,
          password: result.password,
          valueSha256: createHash('sha256')
            .update(input.value, 'utf8')
            .digest('hex'),
          verified: true,
        };
      },
    );
  }

  async screenshot(input: {
    sessionId: string;
    targetId?: string;
    maxBytes?: number;
  }) {
    const maxBytes = Math.min(
      8_388_608,
      Math.max(65_536, input.maxBytes ?? 4_194_304),
    );

    return await this.withPage(
      input.sessionId,
      input.targetId,
      async (client, target) => {
        await client.send('Page.enable');
        const result = await client.send<{ data: string }>(
          'Page.captureScreenshot',
          {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: false,
          },
          15_000,
        );

        const bytes = Buffer.from(result.data, 'base64');
        if (bytes.length > maxBytes) {
          throw new BrowserControlError(
            'BROWSER_SCREENSHOT_TOO_LARGE',
            'Browser screenshot exceeds max_bytes.',
            { bytes: bytes.length, maxBytes },
          );
        }

        return {
          sessionId: input.sessionId,
          targetId: target.id,
          mimeType: 'image/png' as const,
          bytes: bytes.length,
          ...pngDimensions(bytes),
          sha256: createHash('sha256')
            .update(bytes)
            .digest('hex'),
          base64: result.data,
          capturedAt: new Date().toISOString(),
        };
      },
    );
  }

  private requireSession(sessionId: string): BrowserSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new BrowserControlError(
        'BROWSER_SESSION_NOT_FOUND',
        'Unknown browser session.',
        { sessionId },
      );
    }
    return session;
  }

  private requireRunning(sessionId: string): BrowserSession {
    const session = this.requireSession(sessionId);
    if (
      session.status !== 'running' ||
      !isAlive(session.process)
    ) {
      session.status = 'exited';
      session.exitCode = session.process.exitCode;
      throw new BrowserControlError(
        'BROWSER_SESSION_EXITED',
        'Browser session is no longer running.',
        {
          sessionId,
          exitCode: session.exitCode,
          stderr: session.stderr.slice(-2000),
        },
      );
    }
    return session;
  }

  private async targets(
    session: BrowserSession,
  ): Promise<CdpTarget[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(
        'http://127.0.0.1:' + session.port + '/json/list',
        { signal: controller.signal },
      );
      if (!response.ok) {
        throw new BrowserControlError(
          'BROWSER_DEVTOOLS_HTTP_ERROR',
          'Browser DevTools target listing failed.',
          { status: response.status },
        );
      }
      const decoded = (await response.json()) as unknown;
      if (!Array.isArray(decoded)) {
        throw new BrowserControlError(
          'BROWSER_DEVTOOLS_INVALID_RESPONSE',
          'Browser DevTools returned an invalid target list.',
        );
      }
      return decoded.filter(
        (entry): entry is CdpTarget =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as CdpTarget).id === 'string' &&
          typeof (entry as CdpTarget).type === 'string' &&
          typeof (entry as CdpTarget).title === 'string' &&
          typeof (entry as CdpTarget).url === 'string',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async withPage<T>(
    sessionId: string,
    targetId: string | undefined,
    run: (client: CdpClient, target: CdpTarget) => Promise<T>,
  ): Promise<T> {
    const session = this.requireRunning(sessionId);
    const pages = (await this.targets(session)).filter(
      (target) =>
        target.type === 'page' &&
        typeof target.webSocketDebuggerUrl === 'string',
    );
    const target = targetId
      ? pages.find((entry) => entry.id === targetId)
      : pages[0];

    if (!target?.webSocketDebuggerUrl) {
      throw new BrowserControlError(
        'BROWSER_TARGET_NOT_FOUND',
        targetId
          ? 'Requested browser page target was not found.'
          : 'Browser session has no page target.',
        { sessionId, targetId },
      );
    }

    const client = await CdpClient.connect(
      target.webSocketDebuggerUrl,
    );
    try {
      return await run(client, target);
    } finally {
      client.close();
    }
  }

  private async evaluate<T>(
    client: CdpClient,
    expression: string,
    timeoutMs: number,
  ): Promise<T> {
    const response = await client.send<{
      result: { value?: unknown };
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
    }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      },
      timeoutMs,
    );

    if (response.exceptionDetails) {
      throw new BrowserControlError(
        'BROWSER_EVALUATION_FAILED',
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'Browser page evaluation failed.',
      );
    }
    return response.result.value as T;
  }

  private async waitForPort(
    userDataDir: string,
    child: ChildProcess,
    stderr: () => string,
  ): Promise<number> {
    const file = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + 15_000;

    while (Date.now() < deadline) {
      if (!isAlive(child)) {
        throw new BrowserControlError(
          'BROWSER_START_FAILED',
          'Browser exited before DevTools became ready.',
          {
            exitCode: child.exitCode,
            stderr: stderr().slice(-4000),
          },
        );
      }

      try {
        const content = await fs.readFile(file, 'utf8');
        const port = Number(content.split(/\r?\n/)[0]?.trim());
        if (
          Number.isInteger(port) &&
          port > 0 &&
          port <= 65_535
        ) {
          return port;
        }
      } catch {
        // DevToolsActivePort has not appeared yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new BrowserControlError(
      'BROWSER_START_TIMEOUT',
      'Timed out waiting for Browser DevTools startup.',
      { stderr: stderr().slice(-4000) },
    );
  }

  private async resolveBrowser(
    requested: 'auto' | BrowserKind,
  ): Promise<{ browser: BrowserKind; executable: string }> {
    const pf = this.env.ProgramFiles;
    const pfx86 = this.env['ProgramFiles(x86)'];
    const local = this.env.LOCALAPPDATA;
    const candidates: Array<{
      browser: BrowserKind;
      executable?: string;
    }> = [
      {
        browser: 'edge',
        executable: this.env.NEXOWIRE_EDGE_PATH?.trim(),
      },
      {
        browser: 'edge',
        executable: pfx86
          ? path.join(
              pfx86,
              'Microsoft',
              'Edge',
              'Application',
              'msedge.exe',
            )
          : undefined,
      },
      {
        browser: 'edge',
        executable: pf
          ? path.join(
              pf,
              'Microsoft',
              'Edge',
              'Application',
              'msedge.exe',
            )
          : undefined,
      },
      {
        browser: 'chrome',
        executable: this.env.NEXOWIRE_CHROME_PATH?.trim(),
      },
      {
        browser: 'chrome',
        executable: pf
          ? path.join(
              pf,
              'Google',
              'Chrome',
              'Application',
              'chrome.exe',
            )
          : undefined,
      },
      {
        browser: 'chrome',
        executable: pfx86
          ? path.join(
              pfx86,
              'Google',
              'Chrome',
              'Application',
              'chrome.exe',
            )
          : undefined,
      },
      {
        browser: 'chrome',
        executable: local
          ? path.join(
              local,
              'Google',
              'Chrome',
              'Application',
              'chrome.exe',
            )
          : undefined,
      },
    ];

    const ordered =
      requested === 'auto'
        ? candidates
        : candidates.filter(
            (candidate) => candidate.browser === requested,
          );

    for (const candidate of ordered) {
      if (!candidate.executable) continue;
      try {
        await fs.access(candidate.executable);
        return {
          browser: candidate.browser,
          executable: candidate.executable,
        };
      } catch {
        // Try next candidate.
      }
    }

    throw new BrowserControlError(
      'BROWSER_NOT_FOUND',
      requested === 'auto'
        ? 'No supported Edge or Chrome executable was found.'
        : 'Requested browser executable was not found.',
      { requested },
    );
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (!child.pid || !isAlive(child)) return;

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          {
            windowsHide: true,
            stdio: 'ignore',
          },
        );
        const timer = setTimeout(() => {
          killer.kill();
          resolve();
        }, 5_000);
        killer.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        killer.once('error', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } else {
      child.kill('SIGKILL');
    }
  }
}
