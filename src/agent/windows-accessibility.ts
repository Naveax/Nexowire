import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as z from 'zod';

const WindowHandleSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/);

const AccessibilityTreeInputSchema = z.object({
  hwnd: WindowHandleSchema,
  max_depth: z.number().int().min(0).max(16).default(6),
  max_nodes: z.number().int().min(1).max(2000).default(500),
  include_offscreen: z.boolean().default(false),
  include_values: z.boolean().default(false),
  max_value_chars: z.number().int().min(1).max(8192).default(2048),
});

const AccessibilityFindInputSchema = z
  .object({
    hwnd: WindowHandleSchema,
    name_contains: z.string().min(1).max(1024).optional(),
    automation_id: z.string().min(1).max(1024).optional(),
    class_name: z.string().min(1).max(1024).optional(),
    control_type: z.string().min(1).max(128).optional(),
    max_results: z.number().int().min(1).max(100).default(20),
    include_offscreen: z.boolean().default(false),
  })
  .refine(
    (value) =>
      value.name_contains !== undefined ||
      value.automation_id !== undefined ||
      value.class_name !== undefined ||
      value.control_type !== undefined,
    {
      message:
        'At least one accessibility selector is required.',
    },
  );

const SelectorSchema = z
  .object({
    automation_id: z.string().min(1).max(1024).optional(),
    name: z.string().min(1).max(1024).optional(),
    class_name: z.string().min(1).max(1024).optional(),
    control_type: z.string().min(1).max(128).optional(),
  })
  .refine(
    (value) =>
      value.automation_id !== undefined ||
      value.name !== undefined ||
      value.class_name !== undefined ||
      value.control_type !== undefined,
    {
      message: 'At least one exact accessibility selector is required.',
    },
  );

const AccessibilityInvokeInputSchema = z.object({
  hwnd: WindowHandleSchema,
  selector: SelectorSchema,
});

const AccessibilitySetValueInputSchema = z.object({
  hwnd: WindowHandleSchema,
  selector: SelectorSchema,
  value: z.string().max(20_000),
});

class AccessibilityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AccessibilityError';
  }
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new AccessibilityError(
      'WINDOWS_REQUIRED',
      'Windows accessibility control requires a Windows native agent.',
    );
  }
}

const uiaPrelude = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ('NexowireAccessibilityNative' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NexowireAccessibilityNative {
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindow(IntPtr hWnd);
}
"@
}

$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$raw = [string]$inputData.hwnd
$value = if (
  $raw.StartsWith('0x', [System.StringComparison]::OrdinalIgnoreCase)
) {
  [Convert]::ToInt64($raw.Substring(2), 16)
} else {
  [Convert]::ToInt64($raw, 10)
}
$hWnd = [IntPtr]::new($value)

if (-not [NexowireAccessibilityNative]::IsWindow($hWnd)) {
  [pscustomobject]@{
    ok = $false
    code = 'WINDOW_NOT_FOUND'
    message = 'The requested HWND does not identify a current window.'
    hwnd = $raw
  } | ConvertTo-Json -Compress
  exit 3
}

try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_ROOT_UNAVAILABLE'
    message = 'Windows UI Automation could not open the requested HWND.'
    hwnd = $raw
    nativeMessage = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 11
}

if ($null -eq $root) {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_ROOT_UNAVAILABLE'
    message = 'Windows UI Automation returned no root element for the requested HWND.'
    hwnd = $raw
  } | ConvertTo-Json -Compress
  exit 11
}

function Get-ControlTypeName {
  param($ControlType)
  if ($null -eq $ControlType) { return $null }
  $name = [string]$ControlType.ProgrammaticName
  if ($name.StartsWith('ControlType.')) {
    return $name.Substring('ControlType.'.Length)
  }
  return $name
}

function Get-SafeCurrent {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Property
  )
  try {
    return $Element.Current.$Property
  } catch {
    return $null
  }
}

function Get-PatternNames {
  param([System.Windows.Automation.AutomationElement]$Element)
  $patterns = New-Object System.Collections.Generic.List[string]
  foreach ($pair in @(
    @('Invoke', [System.Windows.Automation.InvokePattern]::Pattern),
    @('Value', [System.Windows.Automation.ValuePattern]::Pattern),
    @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern),
    @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
    @('ScrollItem', [System.Windows.Automation.ScrollItemPattern]::Pattern)
  )) {
    $pattern = $null
    try {
      if ($Element.TryGetCurrentPattern($pair[1], [ref]$pattern)) {
        $patterns.Add([string]$pair[0])
      }
    } catch {
      # Elements can disappear while traversing. Treat that pattern as absent.
    }
  }
  return ,$patterns.ToArray()
}

function Convert-Element {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Id,
    [string]$ParentId,
    [int]$Depth,
    [bool]$IncludeValue,
    [int]$MaxValueChars
  )

  try {
    $current = $Element.Current
    $rect = $current.BoundingRectangle
    $isPassword = [bool]$current.IsPassword
    $patterns = Get-PatternNames $Element
    $valueInfo = $null

    if (
      $IncludeValue -and
      -not $isPassword -and
      $patterns -contains 'Value'
    ) {
      try {
        $valuePattern = $Element.GetCurrentPattern(
          [System.Windows.Automation.ValuePattern]::Pattern
        )
        $text = [string]$valuePattern.Current.Value
        $truncated = $text.Length -gt $MaxValueChars
        $valueInfo = [pscustomobject]@{
          chars = $text.Length
          truncated = $truncated
          text = if ($truncated) {
            $text.Substring(0, $MaxValueChars)
          } else {
            $text
          }
        }
      } catch {
        $valueInfo = $null
      }
    }

    return [pscustomobject]@{
      id = $Id
      parentId = $ParentId
      depth = $Depth
      name = [string]$current.Name
      automationId = [string]$current.AutomationId
      className = [string]$current.ClassName
      controlType = Get-ControlTypeName $current.ControlType
      localizedControlType = [string]$current.LocalizedControlType
      enabled = [bool]$current.IsEnabled
      keyboardFocusable = [bool]$current.IsKeyboardFocusable
      hasKeyboardFocus = [bool]$current.HasKeyboardFocus
      offscreen = [bool]$current.IsOffscreen
      isPassword = $isPassword
      accessKey = [string]$current.AccessKey
      acceleratorKey = [string]$current.AcceleratorKey
      helpText = [string]$current.HelpText
      rect = if (
        [double]::IsNaN($rect.X) -or
        [double]::IsInfinity($rect.X) -or
        $rect.Width -lt 0 -or
        $rect.Height -lt 0
      ) {
        $null
      } else {
        [pscustomobject]@{
          x = [double]$rect.X
          y = [double]$rect.Y
          width = [double]$rect.Width
          height = [double]$rect.Height
        }
      }
      patterns = $patterns
      value = $valueInfo
    }
  } catch {
    return $null
  }
}
`;

const treeScript =
  uiaPrelude +
  String.raw`
$maxDepth = [int]$inputData.max_depth
$maxNodes = [int]$inputData.max_nodes
$includeOffscreen = [bool]$inputData.include_offscreen
$includeValues = [bool]$inputData.include_values
$maxValueChars = [int]$inputData.max_value_chars
$nodes = New-Object System.Collections.Generic.List[object]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$counter = 0
$truncated = $false

function Walk-Element {
  param(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$ParentId,
    [int]$Depth
  )

  if ($nodes.Count -ge $maxNodes) {
    $script:truncated = $true
    return
  }

  $id = 'n' + $script:counter
  $script:counter++
  $node = Convert-Element -Element $Element -Id $id -ParentId $ParentId -Depth $Depth -IncludeValue $includeValues -MaxValueChars $maxValueChars

  if ($null -eq $node) {
    return
  }

  if ($Depth -eq 0 -or $includeOffscreen -or -not $node.offscreen) {
    $nodes.Add($node)
  } elseif ($node.offscreen) {
    return
  }

  if ($Depth -ge $maxDepth) {
    return
  }

  try {
    $child = $walker.GetFirstChild($Element)
    while ($null -ne $child) {
      Walk-Element $child $id ($Depth + 1)
      if ($nodes.Count -ge $maxNodes) {
        $script:truncated = $true
        return
      }
      $child = $walker.GetNextSibling($child)
    }
  } catch {
    return
  }
}

Walk-Element $root $null 0

[pscustomobject]@{
  ok = $true
  hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
  nodes = $nodes.ToArray()
  count = $nodes.Count
  truncated = $truncated
  maxDepth = $maxDepth
  maxNodes = $maxNodes
} | ConvertTo-Json -Depth 12 -Compress
`;

const exactActionPrelude =
  uiaPrelude +
  String.raw`
$selector = $inputData.selector
$conditions = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]

if ($null -ne $selector.automation_id) {
  $conditions.Add(
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      [string]$selector.automation_id
    )
  )
}
if ($null -ne $selector.name) {
  $conditions.Add(
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      [string]$selector.name
    )
  )
}
if ($null -ne $selector.class_name) {
  $conditions.Add(
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty,
      [string]$selector.class_name
    )
  )
}
if ($null -ne $selector.control_type) {
  $field = [System.Windows.Automation.ControlType].GetField(
    [string]$selector.control_type,
    [System.Reflection.BindingFlags]'Public,Static,IgnoreCase'
  )
  if ($null -eq $field) {
    [pscustomobject]@{
      ok = $false
      code = 'UNSUPPORTED_CONTROL_TYPE'
      message = 'Unknown UI Automation control type.'
      controlType = [string]$selector.control_type
    } | ConvertTo-Json -Compress
    exit 12
  }
  $controlType = $field.GetValue($null)
  $conditions.Add(
    [System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      $controlType
    )
  )
}

$condition = if ($conditions.Count -eq 1) {
  $conditions[0]
} else {
  [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.Condition[]]$conditions.ToArray()
  )
}

try {
  $matches = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Subtree,
    $condition
  )
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_QUERY_FAILED'
    message = 'UI Automation selector query failed.'
    nativeMessage = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 13
}

if ($matches.Count -eq 0) {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_ELEMENT_NOT_FOUND'
    message = 'No UI Automation element matched the exact selector.'
  } | ConvertTo-Json -Compress
  exit 14
}
if ($matches.Count -gt 1) {
  $preview = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt [Math]::Min(10, $matches.Count); $i++) {
    $entry = Convert-Element $matches[$i] ('m' + $i) $null 0 $false 1
    if ($null -ne $entry) { $preview.Add($entry) }
  }
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_ELEMENT_AMBIGUOUS'
    message = 'More than one UI Automation element matched the selector.'
    count = $matches.Count
    matches = $preview.ToArray()
  } | ConvertTo-Json -Depth 10 -Compress
  exit 15
}

$element = $matches[0]
$elementInfo = Convert-Element $element 'target' $null 0 $false 1
`;

const invokeScript =
  exactActionPrelude +
  String.raw`
$pattern = $null
if (-not $element.TryGetCurrentPattern(
  [System.Windows.Automation.InvokePattern]::Pattern,
  [ref]$pattern
)) {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_PATTERN_UNAVAILABLE'
    message = 'The selected element does not support InvokePattern.'
    requiredPattern = 'Invoke'
    element = $elementInfo
  } | ConvertTo-Json -Depth 10 -Compress
  exit 16
}

try {
  $pattern.Invoke()
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_INVOKE_FAILED'
    message = 'InvokePattern failed for the selected element.'
    nativeMessage = $_.Exception.Message
    element = $elementInfo
  } | ConvertTo-Json -Depth 10 -Compress
  exit 17
}

[pscustomobject]@{
  ok = $true
  invoked = $true
  hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
  element = $elementInfo
} | ConvertTo-Json -Depth 10 -Compress
`;

const setValueScript =
  exactActionPrelude +
  String.raw`
$pattern = $null
if (-not $element.TryGetCurrentPattern(
  [System.Windows.Automation.ValuePattern]::Pattern,
  [ref]$pattern
)) {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_PATTERN_UNAVAILABLE'
    message = 'The selected element does not support ValuePattern.'
    requiredPattern = 'Value'
    element = $elementInfo
  } | ConvertTo-Json -Depth 10 -Compress
  exit 16
}

if ($pattern.Current.IsReadOnly) {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_VALUE_READ_ONLY'
    message = 'The selected element exposes a read-only ValuePattern.'
    element = $elementInfo
  } | ConvertTo-Json -Depth 10 -Compress
  exit 18
}

try {
  $pattern.SetValue([string]$inputData.value)
} catch {
  [pscustomobject]@{
    ok = $false
    code = 'ACCESSIBILITY_SET_VALUE_FAILED'
    message = 'ValuePattern.SetValue failed for the selected element.'
    nativeMessage = $_.Exception.Message
    element = $elementInfo
  } | ConvertTo-Json -Depth 10 -Compress
  exit 19
}

$actual = [string]$pattern.Current.Value
$verified = ($actual -ceq [string]$inputData.value)

[pscustomobject]@{
  ok = $verified
  set = $true
  verified = $verified
  hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
  chars = $actual.Length
  isPassword = if ($null -ne $elementInfo) {
    [bool]$elementInfo.isPassword
  } else {
    $false
  }
  element = $elementInfo
} | ConvertTo-Json -Depth 10 -Compress
`;

async function runPowerShellJson<T>(
  script: string,
  input: unknown,
  timeoutMs = 45_000,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.once('close', (exitCode) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();

      if (timedOut) {
        reject(
          new AccessibilityError(
            'ACCESSIBILITY_TIMEOUT',
            'Windows UI Automation operation timed out after ' +
              timeoutMs +
              'ms.',
          ),
        );
        return;
      }

      if (exitCode !== 0) {
        try {
          const parsed = JSON.parse(out) as {
            code?: string;
            message?: string;
            [key: string]: unknown;
          };
          if (parsed.code && parsed.message) {
            const { code, message, ...details } = parsed;
            reject(new AccessibilityError(code, message, details));
            return;
          }
        } catch {
          // Fall through to generic PowerShell failure.
        }

        reject(
          new AccessibilityError(
            'ACCESSIBILITY_FAILED',
            err ||
              out ||
              'PowerShell exited with code ' +
                (exitCode ?? 'unknown') +
                '.',
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(out) as T);
      } catch {
        reject(
          new AccessibilityError(
            'ACCESSIBILITY_INVALID_RESPONSE',
            'Windows UI Automation returned invalid JSON.',
            { stdout: out.slice(0, 1500) },
          ),
        );
      }
    });

    child.stdin.end(JSON.stringify(input), 'utf8');
  });
}

interface AccessibilityNode {
  id: string;
  parentId: string | null;
  depth: number;
  name: string;
  automationId: string;
  className: string;
  controlType: string | null;
  localizedControlType: string;
  enabled: boolean;
  keyboardFocusable: boolean;
  hasKeyboardFocus: boolean;
  offscreen: boolean;
  isPassword: boolean;
  accessKey: string;
  acceleratorKey: string;
  helpText: string;
  rect:
    | { x: number; y: number; width: number; height: number }
    | null;
  patterns: string[];
  value:
    | { chars: number; truncated: boolean; text: string }
    | null;
}

async function accessibilityTree(input: unknown) {
  assertWindows();
  const parsed = AccessibilityTreeInputSchema.parse(input);
  return {
    data: await runPowerShellJson<{
      hwnd: string;
      nodes: AccessibilityNode[];
      count: number;
      truncated: boolean;
      maxDepth: number;
      maxNodes: number;
    }>(treeScript, parsed),
  };
}

async function accessibilityFind(input: unknown) {
  assertWindows();
  const parsed = AccessibilityFindInputSchema.parse(input);
  const tree = (await accessibilityTree({
    hwnd: parsed.hwnd,
    max_depth: 16,
    max_nodes: 2000,
    include_offscreen: parsed.include_offscreen,
    include_values: false,
  })) as {
    data: {
      hwnd: string;
      nodes: AccessibilityNode[];
      truncated: boolean;
    };
  };

  const normalize = (value: string | undefined) =>
    value?.trim().toLowerCase();
  const nameContains = normalize(parsed.name_contains);
  const automationId = normalize(parsed.automation_id);
  const className = normalize(parsed.class_name);
  const controlType = normalize(parsed.control_type);

  const matches = tree.data.nodes
    .filter((node) => {
      if (
        nameContains &&
        !node.name.toLowerCase().includes(nameContains)
      ) {
        return false;
      }
      if (
        automationId &&
        node.automationId.toLowerCase() !== automationId
      ) {
        return false;
      }
      if (
        className &&
        node.className.toLowerCase() !== className
      ) {
        return false;
      }
      if (
        controlType &&
        (node.controlType ?? '').toLowerCase() !== controlType
      ) {
        return false;
      }
      return true;
    })
    .slice(0, parsed.max_results);

  return {
    data: {
      hwnd: tree.data.hwnd,
      matches,
      count: matches.length,
      sourceTruncated: tree.data.truncated,
      maxResults: parsed.max_results,
    },
  };
}

async function accessibilityInvoke(input: unknown) {
  assertWindows();
  const parsed = AccessibilityInvokeInputSchema.parse(input);
  return {
    data: await runPowerShellJson<Record<string, unknown>>(
      invokeScript,
      parsed,
    ),
  };
}

async function accessibilitySetValue(input: unknown) {
  assertWindows();
  const parsed = AccessibilitySetValueInputSchema.parse(input);
  const data = await runPowerShellJson<Record<string, unknown>>(
    setValueScript,
    parsed,
  );
  return {
    data: {
      ...data,
      valueSha256: createHash('sha256')
        .update(parsed.value, 'utf8')
        .digest('hex'),
    },
  };
}

export async function executeWindowsAccessibilityCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.accessibility.tree':
      return await accessibilityTree(input);
    case 'windows.accessibility.find':
      return await accessibilityFind(input);
    case 'windows.accessibility.invoke':
      return await accessibilityInvoke(input);
    case 'windows.accessibility.set_value':
      return await accessibilitySetValue(input);
    default:
      throw new AccessibilityError(
        'ACCESSIBILITY_UNSUPPORTED',
        'Unsupported Windows accessibility capability: ' + capability,
      );
  }
}
