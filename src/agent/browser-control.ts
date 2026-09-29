import * as z from 'zod';
import { BrowserManager } from './browser-manager.js';

const SessionIdSchema = z.string().uuid();
const TargetIdSchema = z.string().min(1).max(256);

const SessionStartSchema = z.object({
  browser: z.enum(['auto', 'edge', 'chrome']).default('auto'),
  headless: z.boolean().default(true),
  initial_url: z.string().min(1).max(4096).default('about:blank'),
  width: z.number().int().min(320).max(3840).default(1440),
  height: z.number().int().min(240).max(2160).default(900),
});

const SessionStopSchema = z.object({
  session_id: SessionIdSchema,
});

const TabsSchema = z.object({
  session_id: SessionIdSchema,
});

const NavigateSchema = z.object({
  session_id: SessionIdSchema,
  target_id: TargetIdSchema.optional(),
  url: z.string().min(1).max(4096),
  timeout_ms: z.number().int().min(1_000).max(60_000).default(30_000),
});

const SnapshotSchema = z.object({
  session_id: SessionIdSchema,
  target_id: TargetIdSchema.optional(),
  max_elements: z.number().int().min(1).max(1000).default(250),
  max_text_chars: z.number().int().min(1).max(100_000).default(20_000),
  max_element_text_chars: z.number().int().min(1).max(4096).default(500),
  include_hidden: z.boolean().default(false),
});

const ClickSchema = z.object({
  session_id: SessionIdSchema,
  target_id: TargetIdSchema.optional(),
  selector: z.string().min(1).max(4096),
  button: z.enum(['left', 'right', 'middle']).default('left'),
  click_count: z.number().int().min(1).max(3).default(1),
});

const SetValueSchema = z.object({
  session_id: SessionIdSchema,
  target_id: TargetIdSchema.optional(),
  selector: z.string().min(1).max(4096),
  value: z.string().max(20_000),
});

const ScreenshotSchema = z.object({
  session_id: SessionIdSchema,
  target_id: TargetIdSchema.optional(),
  max_bytes: z.number().int().min(65_536).max(8_388_608).default(4_194_304),
});

const VisualVerifySchema = z.object({
  session_id: SessionIdSchema,
  target_id: TargetIdSchema.optional(),
  selector: z.string().min(1).max(4096),
  expected_text: z.string().max(4096).optional(),
  text_mode: z.enum(['contains', 'exact']).default('contains'),
  expected_visible: z.boolean().optional(),
  expected_enabled: z.boolean().optional(),
  expected_checked: z.boolean().optional(),
  padding: z.number().int().min(0).max(200).default(16),
  max_bytes: z.number().int().min(65_536).max(8_388_608).default(2_097_152),
});


export interface BrowserRuntime {
  start(input: {
    browser?: 'auto' | 'edge' | 'chrome';
    headless?: boolean;
    initialUrl?: string;
    width?: number;
    height?: number;
  }): Promise<unknown>;
  list(): unknown;
  stop(sessionId: string): Promise<unknown>;
  tabs(sessionId: string): Promise<unknown>;
  navigate(input: {
    sessionId: string;
    targetId?: string;
    url: string;
    timeoutMs?: number;
  }): Promise<unknown>;
  snapshot(input: {
    sessionId: string;
    targetId?: string;
    maxElements?: number;
    maxTextChars?: number;
    maxElementTextChars?: number;
    includeHidden?: boolean;
  }): Promise<unknown>;
  click(input: {
    sessionId: string;
    targetId?: string;
    selector: string;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
  }): Promise<unknown>;
  setValue(input: {
    sessionId: string;
    targetId?: string;
    selector: string;
    value: string;
  }): Promise<unknown>;
  visualVerify(input: {
    sessionId: string;
    targetId?: string;
    selector: string;
    expectedText?: string;
    textMode?: 'contains' | 'exact';
    expectedVisible?: boolean;
    expectedEnabled?: boolean;
    expectedChecked?: boolean;
    padding?: number;
    maxBytes?: number;
  }): Promise<unknown>;
  screenshot(input: {
    sessionId: string;
    targetId?: string;
    maxBytes?: number;
  }): Promise<unknown>;
}

const defaultBrowserRuntime: BrowserRuntime = new BrowserManager();

export async function executeBrowserCapability(
  capability: string,
  input: unknown,
  runtime: BrowserRuntime = defaultBrowserRuntime,
): Promise<unknown> {
  switch (capability) {
    case 'browser.session.start': {
      const parsed = SessionStartSchema.parse(input);
      return {
        data: await runtime.start({
          browser: parsed.browser,
          headless: parsed.headless,
          initialUrl: parsed.initial_url,
          width: parsed.width,
          height: parsed.height,
        }),
      };
    }
    case 'browser.session.list':
      return { data: runtime.list() };
    case 'browser.session.stop': {
      const parsed = SessionStopSchema.parse(input);
      return { data: await runtime.stop(parsed.session_id) };
    }
    case 'browser.tabs': {
      const parsed = TabsSchema.parse(input);
      return { data: await runtime.tabs(parsed.session_id) };
    }
    case 'browser.navigate': {
      const parsed = NavigateSchema.parse(input);
      return {
        data: await runtime.navigate({
          sessionId: parsed.session_id,
          ...(parsed.target_id ? { targetId: parsed.target_id } : {}),
          url: parsed.url,
          timeoutMs: parsed.timeout_ms,
        }),
      };
    }
    case 'browser.snapshot': {
      const parsed = SnapshotSchema.parse(input);
      return {
        data: await runtime.snapshot({
          sessionId: parsed.session_id,
          ...(parsed.target_id ? { targetId: parsed.target_id } : {}),
          maxElements: parsed.max_elements,
          maxTextChars: parsed.max_text_chars,
          maxElementTextChars: parsed.max_element_text_chars,
          includeHidden: parsed.include_hidden,
        }),
      };
    }
    case 'browser.click': {
      const parsed = ClickSchema.parse(input);
      return {
        data: await runtime.click({
          sessionId: parsed.session_id,
          ...(parsed.target_id ? { targetId: parsed.target_id } : {}),
          selector: parsed.selector,
          button: parsed.button,
          clickCount: parsed.click_count,
        }),
      };
    }
    case 'browser.set_value': {
      const parsed = SetValueSchema.parse(input);
      return {
        data: await runtime.setValue({
          sessionId: parsed.session_id,
          ...(parsed.target_id ? { targetId: parsed.target_id } : {}),
          selector: parsed.selector,
          value: parsed.value,
        }),
      };
    }
    case 'browser.visual.verify': {
      const parsed = VisualVerifySchema.parse(input);
      return {
        data: await runtime.visualVerify({
          sessionId: parsed.session_id,
          ...(parsed.target_id ? { targetId: parsed.target_id } : {}),
          selector: parsed.selector,
          ...(parsed.expected_text !== undefined
            ? { expectedText: parsed.expected_text }
            : {}),
          textMode: parsed.text_mode,
          ...(parsed.expected_visible !== undefined
            ? { expectedVisible: parsed.expected_visible }
            : {}),
          ...(parsed.expected_enabled !== undefined
            ? { expectedEnabled: parsed.expected_enabled }
            : {}),
          ...(parsed.expected_checked !== undefined
            ? { expectedChecked: parsed.expected_checked }
            : {}),
          padding: parsed.padding,
          maxBytes: parsed.max_bytes,
        }),
      };
    }
    case 'browser.screenshot': {
      const parsed = ScreenshotSchema.parse(input);
      return {
        data: await runtime.screenshot({
          sessionId: parsed.session_id,
          ...(parsed.target_id ? { targetId: parsed.target_id } : {}),
          maxBytes: parsed.max_bytes,
        }),
      };
    }
    default:
      throw new Error(`Unsupported browser capability: ${capability}`);
  }
}
