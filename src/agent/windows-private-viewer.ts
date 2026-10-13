import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {
  captureWindowsPrivateScreen,
} from './windows-private-screen.js';
import {executeWindowsPrivateDesktopCapability} from './windows-private-desktop.js';

const ViewerStartSchema = z.object({
  refresh_ms: z
    .number()
    .int()
    .min(250)
    .max(5_000)
    .default(750),
  max_width: z
    .number()
    .int()
    .min(320)
    .max(2_560)
    .default(1_280),
  max_height: z
    .number()
    .int()
    .min(240)
    .max(1_440)
    .default(720),
  max_bytes: z
    .number()
    .int()
    .min(262_144)
    .max(8_388_608)
    .default(4_194_304),
  topmost: z.boolean().default(false),
});

interface PrivateViewerState {
  version: 1;
  pid: number;
  startedAt: string;
  refreshMs: number;
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
  topmost: boolean;
  selectedMonitorId: string | null;
  lastSelectionError: string | null;
  emptyCaptureArea: boolean | null;
  lastFrameAt: string | null;
  frameBytes: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  lastError: string | null;
}

class PrivateViewerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrivateViewerError';
  }
}

let refreshTimer: NodeJS.Timeout | undefined;
let refreshGeneration = 0;
let refreshBusy = false;

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new PrivateViewerError(
      'WINDOWS_REQUIRED',
      'Nexowire private viewer requires Windows.',
    );
  }
}

function runtimeRoot(): string {
  return (
    process.env.NEXOWIRE_PRIVATE_VIEWER_DIR?.trim() ||
    path.join(
      os.homedir(),
      '.nexowire',
      'private-viewer',
    )
  );
}

function runtimePaths() {
  const root = runtimeRoot();
  return {
    root,
    state: path.join(root, 'state.json'),
    frame: path.join(root, 'frame.png'),
    windows: path.join(root, 'windows.json'),
    displays: path.join(root, 'displays.json'),
    monitorSelection: path.join(root, 'monitor-selection.request.json'),
    emergency: path.join(root, 'emergency-stop.request'),
    emergencyResult: path.join(root, 'emergency-stop.result'),
    heartbeat: path.join(root, 'heartbeat.txt'),
    viewer: path.join(root, 'viewer.ps1'),
  };
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readState(): Promise<
  PrivateViewerState | undefined
> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(runtimePaths().state, 'utf8'),
    ) as unknown;
    return z
      .object({
        version: z.literal(1),
        pid: z.number().int().positive(),
        startedAt: z.string().min(1),
        refreshMs: z.number().int().min(250).max(5_000),
        maxWidth: z.number().int().positive(),
        maxHeight: z.number().int().positive(),
        maxBytes: z.number().int().positive(),
        topmost: z.boolean(),
        selectedMonitorId: z.string().min(1).max(128).nullable().default(null),
        lastSelectionError: z.string().max(256).nullable().default(null),
        emptyCaptureArea: z.boolean().nullable().default(null),
        lastFrameAt: z.string().nullable(),
        frameBytes: z.number().int().positive().nullable(),
        frameWidth: z.number().int().positive().nullable(),
        frameHeight: z.number().int().positive().nullable(),
        lastError: z.string().nullable(),
      })
      .parse(parsed) as PrivateViewerState;
  } catch {
    return undefined;
  }
}

async function writeState(
  state: PrivateViewerState,
): Promise<void> {
  const p = runtimePaths();
  await fs.mkdir(p.root, { recursive: true });
  const temp = p.state + '.tmp';
  await fs.writeFile(
    temp,
    JSON.stringify(state, null, 2) + '\n',
    'utf8',
  );
  await fs.rm(p.state, { force: true });
  await fs.rename(temp, p.state);
}

async function writeHeartbeat(): Promise<void> {
  const p = runtimePaths();
  await fs.writeFile(
    p.heartbeat,
    new Date().toISOString() + '\n',
    'utf8',
  );
}

async function heartbeatFresh(
  maxAgeMs = 20_000,
): Promise<boolean> {
  try {
    const stat = await fs.stat(
      runtimePaths().heartbeat,
    );
    return (
      Date.now() - stat.mtimeMs <= maxAgeMs
    );
  } catch {
    return false;
  }
}

async function writeFrame(
  base64: string,
): Promise<number> {
  const p = runtimePaths();
  const bytes = Buffer.from(base64, 'base64');
  const temp = p.frame + '.tmp';
  await fs.writeFile(temp, bytes);
  await fs.rm(p.frame, { force: true });
  await fs.rename(temp, p.frame);
  return bytes.length;
}

const viewerScript = String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$FramePath,
  [Parameter(Mandatory = $true)]
  [string]$StatePath,
  [Parameter(Mandatory = $true)]
  [string]$HeartbeatPath,
  [Parameter(Mandatory = $true)]
  [string]$WindowsPath,
  [Parameter(Mandatory = $true)]
  [string]$DisplaysPath,
  [Parameter(Mandatory = $true)]
  [string]$MonitorSelectionPath,
  [Parameter(Mandatory = $true)]
  [string]$EmergencyPath,
  [Parameter(Mandatory = $true)]
  [string]$EmergencyResultPath,
  [Parameter(Mandatory = $true)]
  [int]$RefreshMs,
  [Parameter(Mandatory = $true)]
  [int]$Topmost
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class NxPrivateViewerDesktop {
  public const uint SWITCH = 0x0100;

  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr OpenDesktop(
    string name,
    int flags,
    bool inherit,
    uint access
  );

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool SwitchDesktop(IntPtr desktop);

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool CloseDesktop(IntPtr desktop);

  public static bool Enter(string name) {
    var desktop = OpenDesktop(
      name,
      0,
      false,
      SWITCH
    );
    if (desktop == IntPtr.Zero) return false;
    try {
      return SwitchDesktop(desktop);
    } finally {
      CloseDesktop(desktop);
    }
  }
}
"@

$window = New-Object System.Windows.Window
$window.Title = 'Nexowire Private Viewer'
$window.Width = 1280
$window.Height = 820
$window.MinWidth = 640
$window.MinHeight = 420
$window.WindowStartupLocation = 'CenterScreen'
# A background AI viewer must not activate or steal the owner's foreground app.
$window.ShowActivated = $false
$window.Background = [System.Windows.Media.Brushes]::Black
$window.Topmost = ($Topmost -eq 1)
$window.ShowInTaskbar = $true

$root = New-Object System.Windows.Controls.Grid
$columnPreview=New-Object System.Windows.Controls.ColumnDefinition
$columnPreview.Width=[System.Windows.GridLength]::new(1,[System.Windows.GridUnitType]::Star)
$columnApps=New-Object System.Windows.Controls.ColumnDefinition
$columnApps.Width=[System.Windows.GridLength]::new(240)
[void]$root.ColumnDefinitions.Add($columnPreview)
[void]$root.ColumnDefinitions.Add($columnApps)
$rowTop = New-Object System.Windows.Controls.RowDefinition
$rowTop.Height = [System.Windows.GridLength]::Auto
$rowImage = New-Object System.Windows.Controls.RowDefinition
$rowImage.Height = New-Object System.Windows.GridLength(
  1,
  [System.Windows.GridUnitType]::Star
)
[void]$root.RowDefinitions.Add($rowTop)
[void]$root.RowDefinitions.Add($rowImage)

$bar = New-Object System.Windows.Controls.DockPanel
$bar.Background = (
  New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.Color]::FromRgb(22,24,31)
  )
)
$bar.LastChildFill = $true

$enter = New-Object System.Windows.Controls.Button
$enter.Content = 'ENTER PRIVATE DESKTOP'
$enter.Margin = '10'
$enter.Padding = '14,8,14,8'
$enter.HorizontalAlignment = 'Left'
$enter.ToolTip = 'Local user action: switch the physical display to NexowirePrivate.'
$enter.Add_Click({
  if (-not [NxPrivateViewerDesktop]::Enter('NexowirePrivate')) {
    [System.Windows.MessageBox]::Show(
      'NexowirePrivate is not available.',
      'Nexowire'
    ) | Out-Null
  }
})
[System.Windows.Controls.DockPanel]::SetDock(
  $enter,
  [System.Windows.Controls.Dock]::Left
)
[void]$bar.Children.Add($enter)

$compact=New-Object System.Windows.Controls.Button
$compact.Content='COMPACT PREVIEW'
$compact.Margin='0,10,10,10'
$compact.Padding='14,8,14,8'
$compact.ToolTip='Toggle small AI preview without switching desktops.'
$script:compactMode=$false
$compact.Add_Click({
  $script:compactMode=-not $script:compactMode
  if($script:compactMode){
    $window.MinWidth=320
    $window.MinHeight=240
    $window.Width=480
    $window.Height=350
    $columnApps.Width=[System.Windows.GridLength]::new(0)
    $enter.Visibility=[System.Windows.Visibility]::Collapsed
    $compact.Content='EXPAND PREVIEW'
  }else{
    $window.MinWidth=640
    $window.MinHeight=420
    $window.Width=1280
    $window.Height=820
    $columnApps.Width=[System.Windows.GridLength]::new(240)
    $enter.Visibility=[System.Windows.Visibility]::Visible
    $compact.Content='COMPACT PREVIEW'
  }
})
[System.Windows.Controls.DockPanel]::SetDock(
  $compact,[System.Windows.Controls.Dock]::Left
)
[void]$bar.Children.Add($compact)

# Read-only monitor inventory; local selection changes the private preview
# only. It never calls SetDisplayConfig or the Default desktop input APIs.
$monitorPicker=New-Object System.Windows.Controls.ComboBox
$monitorPicker.Width=228
$monitorPicker.Margin='0,10,10,10'
$monitorPicker.VerticalContentAlignment='Center'
$monitorPicker.ToolTip='Select all host monitors or one. AI windows stay on NexowirePrivate.'
$script:updatingMonitorPicker=$false
$script:lastMonitorInventoryWrite=[datetime]::MinValue
$monitorPicker.Add_SelectionChanged({
  if($script:updatingMonitorPicker -or $null -eq $monitorPicker.SelectedItem){return}
  $tag=[string]$monitorPicker.SelectedItem.Tag
  $request=if($tag -eq 'all'){
    @{source='desktop'}
  }else{
    @{source='monitor';monitor_id=$tag}
  }
  try{
    $utf8=New-Object System.Text.UTF8Encoding($false)
    $temporary=$MonitorSelectionPath+'.tmp'
    [System.IO.File]::WriteAllText($temporary,($request|ConvertTo-Json -Compress),$utf8)
    if([System.IO.File]::Exists($MonitorSelectionPath)){
      [System.IO.File]::Delete($MonitorSelectionPath)
    }
    [System.IO.File]::Move($temporary,$MonitorSelectionPath)
  }catch{
    $status.Text='Monitor selection could not be saved'
  }
})
[System.Windows.Controls.DockPanel]::SetDock(
  $monitorPicker,[System.Windows.Controls.Dock]::Left
)
[void]$bar.Children.Add($monitorPicker)

$fullscreen=New-Object System.Windows.Controls.Button
$fullscreen.Content='FULL SCREEN'
$fullscreen.Margin='0,10,10,10'
$fullscreen.Padding='14,8,14,8'
$fullscreen.ToolTip='Explicit local fullscreen AI preview; does not switch input desktops or move the physical mouse.'
$script:fullScreenMode=$false
$script:normalWidth=1280
$script:normalHeight=820
$fullscreen.Add_Click({
  if(-not $script:fullScreenMode){
    # Fullscreen and compact are mutually exclusive, but neither alters
    # the real user's input desktop or foreground on startup.
    if($script:compactMode){
      $script:compactMode=$false
      $window.MinWidth=640
      $window.MinHeight=420
      $window.Width=1280
      $window.Height=820
      $columnApps.Width=[System.Windows.GridLength]::new(240)
      $compact.Content='COMPACT PREVIEW'
    }
    $script:normalWidth=$window.Width
    $script:normalHeight=$window.Height
    $window.WindowState=[System.Windows.WindowState]::Normal
    $window.WindowStyle=[System.Windows.WindowStyle]::None
    $window.ResizeMode=[System.Windows.ResizeMode]::NoResize
    $window.WindowState=[System.Windows.WindowState]::Maximized
    $script:fullScreenMode=$true
    $fullscreen.Content='EXIT FULL SCREEN'
    $enter.Visibility=[System.Windows.Visibility]::Collapsed
    $compact.Visibility=[System.Windows.Visibility]::Collapsed
  }else{
    $window.WindowState=[System.Windows.WindowState]::Normal
    $window.WindowStyle=[System.Windows.WindowStyle]::SingleBorderWindow
    $window.ResizeMode=[System.Windows.ResizeMode]::CanResize
    $window.Width=$script:normalWidth
    $window.Height=$script:normalHeight
    $script:fullScreenMode=$false
    $fullscreen.Content='FULL SCREEN'
    $enter.Visibility=[System.Windows.Visibility]::Visible
    $compact.Visibility=[System.Windows.Visibility]::Visible
  }
})
[System.Windows.Controls.DockPanel]::SetDock(
  $fullscreen,[System.Windows.Controls.Dock]::Left
)
[void]$bar.Children.Add($fullscreen)

$emergency=New-Object System.Windows.Controls.Button
$emergency.Content='STOP AI WORKSPACE'
$emergency.Margin='0,10,10,10'
$emergency.Padding='14,8,14,8'
$emergency.Background=[System.Windows.Media.Brushes]::Firebrick
$emergency.Foreground=[System.Windows.Media.Brushes]::White
$emergency.ToolTip='Locally confirm stopping only tracked NexowirePrivate tasks. Does not switch your desktop.'
$emergency.Add_Click({
  $answer=[System.Windows.MessageBox]::Show(
    'Stop tracked AI private desktop programs and close the AI viewer? This will not move the physical mouse or switch the input desktop.',
    'Nexowire AI workspace emergency stop',
    [System.Windows.MessageBoxButton]::YesNo,
    [System.Windows.MessageBoxImage]::Warning
  )
  if($answer -ne [System.Windows.MessageBoxResult]::Yes){return}
  try{
    [System.IO.File]::Delete($EmergencyResultPath)
    [System.IO.File]::WriteAllText($EmergencyPath,'STOP_NEXOWIREPRIVATE')
    $emergency.IsEnabled=$false
    $status.Text='Private AI stop requested...'
  }catch{
    [System.Windows.MessageBox]::Show(
      'Could not request AI workspace stop: '+$_.Exception.Message,
      'Nexowire'
    ) | Out-Null
  }
})
[System.Windows.Controls.DockPanel]::SetDock(
  $emergency,[System.Windows.Controls.Dock]::Left
)
[void]$bar.Children.Add($emergency)

$close = New-Object System.Windows.Controls.Button
$close.Content = 'CLOSE VIEWER'
$close.Margin = '0,10,10,10'
$close.Padding = '14,8,14,8'
$close.HorizontalAlignment = 'Right'
$close.Add_Click({ $window.Close() })
[System.Windows.Controls.DockPanel]::SetDock(
  $close,
  [System.Windows.Controls.Dock]::Right
)
[void]$bar.Children.Add($close)

$status = New-Object System.Windows.Controls.TextBlock
$status.Text = 'NexowirePrivate | awaiting capture status'
$status.Foreground = [System.Windows.Media.Brushes]::White
$status.VerticalAlignment = 'Center'
$status.Margin = '12,0,12,0'
[void]$bar.Children.Add($status)

[System.Windows.Controls.Grid]::SetRow($bar, 0)
[System.Windows.Controls.Grid]::SetColumnSpan($bar,2)
[void]$root.Children.Add($bar)

$image = New-Object System.Windows.Controls.Image
$image.Stretch = [System.Windows.Media.Stretch]::Uniform
$image.HorizontalAlignment = 'Stretch'
$image.VerticalAlignment = 'Stretch'
$image.SnapsToDevicePixels = $true
[System.Windows.Controls.Grid]::SetRow($image, 1)
[System.Windows.Controls.Grid]::SetColumn($image, 0)
[void]$root.Children.Add($image)

$appList=New-Object System.Windows.Controls.ListBox
$appList.Background=[System.Windows.Media.Brushes]::Black
$appList.Foreground=[System.Windows.Media.Brushes]::White
$appList.BorderThickness='0'
$appList.Margin='5'
$appList.ToolTip='Read-only window list from NexowirePrivate, never the owner Default desktop.'
[System.Windows.Controls.Grid]::SetRow($appList,1)
[System.Windows.Controls.Grid]::SetColumn($appList,1)
[void]$root.Children.Add($appList)

$window.Content = $root
$lastFrameWrite = [datetime]::MinValue

function Load-Frame {
  if (-not (Test-Path -LiteralPath $FramePath)) {
    return
  }

  try {
    $item = Get-Item -LiteralPath $FramePath
    if ($item.LastWriteTimeUtc -le $lastFrameWrite) {
      return
    }

    $stream = [System.IO.File]::Open(
      $FramePath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    try {
      $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
      $bitmap.BeginInit()
      $bitmap.CacheOption = (
        [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
      )
      $bitmap.StreamSource = $stream
      $bitmap.EndInit()
      $bitmap.Freeze()
      $image.Source = $bitmap
      $lastFrameWrite = $item.LastWriteTimeUtc
      $status.Text = (
        'NexowirePrivate live preview  •  ' +
        $bitmap.PixelWidth + '×' + $bitmap.PixelHeight +
        '  •  ' + [DateTime]::Now.ToString('HH:mm:ss')
      )
    } finally {
      $stream.Dispose()
    }
  } catch {
    # A frame may be between atomic replacement steps.
    # Keep the previous frame and retry on the next tick.
  }
}

function Update-MonitorPicker {
  if(-not(Test-Path -LiteralPath $DisplaysPath)){return}
  try{
    $item=Get-Item -LiteralPath $DisplaysPath
    if($item.LastWriteTimeUtc -le $script:lastMonitorInventoryWrite){return}
    $snapshot=Get-Content -LiteralPath $DisplaysPath -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    $timestamp=[datetime]::MinValue
    if(-not [datetime]::TryParse([string]$snapshot.updatedAt,[ref]$timestamp)){return}
    $age=([datetime]::UtcNow-$timestamp.ToUniversalTime()).TotalMilliseconds
    if($age -lt -2000 -or $age -gt [Math]::Max(5000,$RefreshMs*5)){return}
    $currentTag='all'
    if($null -ne $monitorPicker.SelectedItem){
      $currentTag=[string]$monitorPicker.SelectedItem.Tag
    } elseif($snapshot.selectedMonitorId){
      $currentTag=[string]$snapshot.selectedMonitorId
    }
    $script:updatingMonitorPicker=$true
    try{
      $monitorPicker.Items.Clear()
      $all=New-Object System.Windows.Controls.ComboBoxItem
      $all.Content='ALL MONITORS'
      $all.Tag='all'
      [void]$monitorPicker.Items.Add($all)
      $selection=$all
      foreach($m in @($snapshot.monitors)){
        $entry=New-Object System.Windows.Controls.ComboBoxItem
        $entry.Tag=[string]$m.id
        $dpiLabel=if($m.effectiveDpiX){' | '+$m.effectiveDpiX+' DPI'}else{''}
        $entry.Content=('SCREEN '+([int]$m.index+1)+': '+$m.width+'x'+$m.height+$dpiLabel)
        [void]$monitorPicker.Items.Add($entry)
        if($entry.Tag -eq $currentTag){$selection=$entry}
      }
      $monitorPicker.SelectedItem=$selection
      $script:lastMonitorInventoryWrite=$item.LastWriteTimeUtc
    }finally{$script:updatingMonitorPicker=$false}
  }catch{
    # Leave last known list visible. Capture health displays stale/error.
  }
}

function Update-WindowList {
  $appList.Items.Clear()
  if(-not(Test-Path -LiteralPath $WindowsPath)){
    [void]$appList.Items.Add('Window inventory unavailable')
    return
  }
  try{
    $snapshot=Get-Content -LiteralPath $WindowsPath -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    $updated=[datetime]::MinValue
    if(-not [datetime]::TryParse([string]$snapshot.updatedAt,[ref]$updated)){
      [void]$appList.Items.Add('Window inventory timestamp invalid')
      return
    }
    $inventoryAge=([datetime]::UtcNow-$updated.ToUniversalTime()).TotalMilliseconds
    if($inventoryAge -gt [Math]::Max(5000,$RefreshMs*5) -or $inventoryAge -lt -2000){
      [void]$appList.Items.Add('Window inventory stale')
      return
    }
    $windows=@($snapshot.windows)
    if($windows.Count -eq 0){
      [void]$appList.Items.Add('No private app windows')
      return
    }
    foreach($privateWindow in $windows){
      $name=[string]$privateWindow.title
      $pidText=[string]$privateWindow.pid
      [void]$appList.Items.Add(($name+'  (PID '+$pidText+')'))
    }
  }catch{
    $appList.Items.Clear()
    [void]$appList.Items.Add('Window inventory unreadable')
  }
}

function Heartbeat-Healthy {
  if (-not (Test-Path -LiteralPath $HeartbeatPath)) {
    return $false
  }
  try {
    $heartbeat = Get-Item -LiteralPath $HeartbeatPath
    return (([DateTime]::UtcNow - $heartbeat.LastWriteTimeUtc).TotalSeconds -le 20)
  } catch {
    return $false
  }
}

function Update-CaptureHealth {
  # A previously decoded frame is not proof that the stream is still live.
  # While an emergency stop is pending, keep its status visible.
  if(-not $emergency.IsEnabled){return}
  try{
    $snapshot=Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop |
      ConvertFrom-Json -ErrorAction Stop
    if($snapshot.lastError){
      $message=([string]$snapshot.lastError).Replace([char]10,' ').Replace([char]13,' ')
      $status.Text='CAPTURE ERROR: '+$message.Substring(0,[Math]::Min(150,$message.Length))
      return
    }
    if($snapshot.lastSelectionError){
      $status.Text='MONITOR SELECTION ERROR: '+[string]$snapshot.lastSelectionError
      return
    }
    $frameTime=[datetime]::MinValue
    if(-not [datetime]::TryParse([string]$snapshot.lastFrameAt,[ref]$frameTime)){
      $status.Text='NO LIVE FRAME: capture timestamp missing'
      return
    }
    $age=([datetime]::UtcNow-$frameTime.ToUniversalTime()).TotalMilliseconds
    if($age -lt -2000 -or $age -gt [Math]::Max(2000,$RefreshMs*4)){
      $status.Text='STALE FRAME: last capture '+[Math]::Max(0,[int]($age/1000))+'s ago'
      return
    }
    if($snapshot.emptyCaptureArea){
      $status.Text='LIVE EMPTY AI SCREEN: no private windows in selected capture area'
      return
    }
    $status.Text='LIVE NexowirePrivate | '+[DateTime]::Now.ToString('HH:mm:ss')
  }catch{
    $status.Text='CAPTURE STATUS UNAVAILABLE: showing last known frame'
  }
}

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(
  [Math]::Max(100, $RefreshMs)
)
$timer.Add_Tick({
  if (-not (Heartbeat-Healthy)) {
    $window.Close()
    return
  }
  Load-Frame
  Update-MonitorPicker
  Update-WindowList
  Update-CaptureHealth
  if(Test-Path -LiteralPath $EmergencyResultPath){
    try{
      $outcome=Get-Content -LiteralPath $EmergencyResultPath -Raw -ErrorAction Stop
      $status.Text=$outcome.Substring(0,[Math]::Min(300,$outcome.Length))
      $emergency.IsEnabled=$true
    }catch{}
  }
})
$timer.Start()

$window.Add_Closed({ $timer.Stop() })
Load-Frame
Update-MonitorPicker
Update-WindowList
Update-CaptureHealth
[void]$window.ShowDialog()
`;

async function ensureViewerScript(): Promise<void> {
  const p = runtimePaths();
  await fs.mkdir(p.root, { recursive: true });
  await fs.writeFile(
    p.viewer,
    viewerScript,
    'utf8',
  );
}

async function refreshPrivateWindowInventory():Promise<void>{
  const snapshot=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.windows',{},
  ) as {data:{windows:Array<{
    hwnd:string;title:string;processId:number;visible:boolean;
  }>}};
  const list=(snapshot.data.windows??[])
    .filter(window=>window.visible && window.title.trim().length>0)
    .slice(0,24)
    .map(window=>({
      hwnd:String(window.hwnd).slice(0,64),
      title:window.title.replace(/[\r\n\t]/g,' ').slice(0,120),
      pid:window.processId,
    }));
  const destination=runtimePaths().windows;
  const temp=destination+'.tmp';
  await fs.writeFile(temp,JSON.stringify({
    updatedAt:new Date().toISOString(),windows:list,
  }),{encoding:'utf8',mode:0o600});
  await fs.rm(destination,{force:true});
  await fs.rename(temp,destination);
}

const LocalMonitorSelectionSchema = z.object({
  source:z.enum(['desktop','monitor']),
  monitor_id:z.string().min(1).max(128).optional(),
}).strict().superRefine((v,ctx)=>{
  if(v.source==='monitor'&&!v.monitor_id)
    ctx.addIssue({code:'custom',path:['monitor_id'],message:'monitor_id required'});
  if(v.source==='desktop'&&v.monitor_id)
    ctx.addIssue({code:'custom',path:['monitor_id'],message:'monitor_id only allowed for monitor'});
});

/** Only the locally clicked Viewer writes this request. It cannot switch
 * Windows desktops or alter display configuration. */
export function parseLocalMonitorSelection(input:unknown):{selectedMonitorId:string|null}{
  const parsed=LocalMonitorSelectionSchema.parse(input);
  return {selectedMonitorId:parsed.source==='monitor'?parsed.monitor_id!:null};
}

export async function readLocalMonitorSelection(
  state:PrivateViewerState,
):Promise<PrivateViewerState>{
  const file=runtimePaths().monitorSelection;
  let raw:string;
  try {raw=await fs.readFile(file,'utf8');}
  catch(e) {
    if((e as NodeJS.ErrnoException).code==='ENOENT')return state;
    // Never starve frame/heartbeat refresh because a local selector file
    // was temporarily inaccessible.
    return {...state,lastSelectionError:'Cannot read local monitor selection request.'};
  }
  // Remove a consumed request before validation; malformed input is reported,
  // never retried forever, never changes the last valid capture target.
  await fs.rm(file,{force:true}).catch(()=>undefined);
  try {
    const selection=parseLocalMonitorSelection(JSON.parse(raw));
    return {...state,...selection,lastSelectionError:null};
  } catch {
    return {
      ...state,
      lastSelectionError:'Invalid monitor selection; previous capture target preserved.',
    };
  }
}

async function writeMonitorInventory(
  selectedMonitorId:string|null,
  monitors:Array<{id:string;index:number;width:number;height:number;effectiveDpiX:number|null}>,
):Promise<void>{
  const file=runtimePaths().displays, temp=file+'.tmp';
  await fs.writeFile(temp,JSON.stringify({
    updatedAt:new Date().toISOString(),
    selectedMonitorId,
    topologyKind:'host_shared_native',
    monitors,
  }),{encoding:'utf8',mode:0o600});
  await fs.rm(file,{force:true});
  await fs.rename(temp,file);
}

async function captureAndPersist(
  state: PrivateViewerState,
): Promise<PrivateViewerState> {
  await writeHeartbeat();

  try {
    const capture = await captureWindowsPrivateScreen({
      source: state.selectedMonitorId ? 'monitor' : 'desktop',
      ...(state.selectedMonitorId ? {monitor_id:state.selectedMonitorId} : {}),
      max_width: state.maxWidth,
      max_height: state.maxHeight,
      max_bytes: state.maxBytes,
    });
    const frameBytes = await writeFrame(
      capture.data.base64,
    );
    await writeMonitorInventory(state.selectedMonitorId,capture.data.monitors);
    // Window inventory is best-effort, never an excuse to stop refreshing
    // the image. This is a read-only query of NexowirePrivate, not Default.
    await refreshPrivateWindowInventory().catch(()=>undefined);
    return {
      ...state,
      lastFrameAt: new Date().toISOString(),
      frameBytes,
      frameWidth: capture.data.width,
      frameHeight: capture.data.height,
      emptyCaptureArea: capture.data.emptyCaptureArea,
      lastError: null,
    };
  } catch (error) {
    return {
      ...state,
      lastError:
        error instanceof Error
          ? error.message.slice(0, 1024)
          : 'Private viewer capture failed.',
    };
  }
}

function stopRefreshLoop(): void {
  refreshGeneration++;
  refreshBusy = false;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

/**
 * This request comes exclusively from a locally confirmed viewer click.
 * It stops the dedicated private desktop and its tracked AI processes,
 * never touches the owner's Default processes or moves their input desktop.
 */
async function handleLocalEmergencyStop():Promise<boolean>{
  const p=runtimePaths();
  let command:string;
  try{
    command=await fs.readFile(p.emergency,'utf8');
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
    throw error;
  }
  await fs.rm(p.emergency,{force:true});
  if(command!=='STOP_NEXOWIREPRIVATE'){
    await fs.writeFile(p.emergencyResult,'Invalid private AI stop request.');
    return false;
  }
  try{
    const snapshot=await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.status',{},
    ) as {data:{inputDesktop:string}};
    if(snapshot.data.inputDesktop!=='Default'){
      throw new PrivateViewerError(
        'PRIVATE_STOP_INPUT_DESKTOP_NOT_DEFAULT',
        'Return to the Default user desktop before stopping the private AI desktop.',
      );
    }
    await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.stop',{},
    );
    await viewerStop();
    return true;
  }catch(error){
    await fs.writeFile(
      p.emergencyResult,
      'AI stop not completed: '+(
        error instanceof Error?error.message.slice(0,200):'Unknown error'
      ),
    );
    return false;
  }
}

function startRefreshLoop(
  initial: PrivateViewerState,
): void {
  stopRefreshLoop();
  const generation = refreshGeneration;
  let state = initial;

  refreshTimer = setInterval(() => {
    if (
      generation !== refreshGeneration ||
      refreshBusy
    ) {
      return;
    }

    if (!processAlive(state.pid)) {
      stopRefreshLoop();
      void cleanupRuntime(false);
      return;
    }

    refreshBusy = true;
    void (async()=>{
      // Process local emergency stop before screenshot or metadata updates.
      // On success viewerStop closes the WPF window and removes its files.
      if(await handleLocalEmergencyStop())return;
      if(generation!==refreshGeneration)return;
      state=await readLocalMonitorSelection(state);
      if(generation!==refreshGeneration)return;
      const next=await captureAndPersist(state);
      if(generation!==refreshGeneration)return;
      state=next;
      await writeState(state);
    })()
      .catch(() => {
        // Keep the viewer alive on a transient persistence error.
      })
      .finally(() => {
        refreshBusy = false;
      });
  }, initial.refreshMs);
  refreshTimer.unref?.();
}

async function cleanupRuntime(
  removeScript = false,
): Promise<void> {
  const p = runtimePaths();
  await Promise.all([
    fs.rm(p.state, { force: true }),
    fs.rm(p.frame, { force: true }),
    fs.rm(p.windows, { force: true }),
    fs.rm(p.displays, { force: true }),
    fs.rm(p.monitorSelection, { force: true }),
    fs.rm(p.emergency, { force: true }),
    fs.rm(p.emergencyResult, { force: true }),
    fs.rm(p.heartbeat, { force: true }),
    ...(removeScript
      ? [fs.rm(p.viewer, { force: true })]
      : []),
  ]);
}

async function viewerStatus(): Promise<{
  data: unknown;
}> {
  assertWindows();
  const state = await readState();
  const alive =
    state && processAlive(state.pid);
  const fresh =
    alive && (await heartbeatFresh());

  if (!state || !alive || !fresh) {
    if (state) {
      stopRefreshLoop();
      if (alive && !fresh) {
        try {
          process.kill(state.pid);
        } catch {
          // Best effort stale-viewer cleanup.
        }
      }
      await cleanupRuntime(false);
    }
    return {
      data: {
        running: false,
        localViewer: true,
      },
    };
  }

  const frameTimestamp = state.lastFrameAt
    ? Date.parse(state.lastFrameAt)
    : NaN;
  const frameAgeMs = Number.isFinite(frameTimestamp)
    ? Math.max(0, Date.now() - frameTimestamp)
    : null;
  const maxLiveFrameAgeMs = Math.max(2_000, state.refreshMs * 4);
  const frameHealth = state.lastError
    ? 'error'
    : frameAgeMs === null
      ? 'unavailable'
      : frameAgeMs > maxLiveFrameAgeMs
        ? 'stale'
        : 'live';

  return {
    data: {
      running: true,
      localViewer: true,
      pid: state.pid,
      startedAt: state.startedAt,
      refreshMs: state.refreshMs,
      topmost: state.topmost,
      captureScope: state.selectedMonitorId ? 'monitor' : 'all_monitors',
      selectedMonitorId: state.selectedMonitorId,
      lastSelectionError: state.lastSelectionError,
      lastFrameAt: state.lastFrameAt,
      frameAgeMs,
      frameHealth,
      maxLiveFrameAgeMs,
      frameBytes: state.frameBytes,
      frameWidth: state.frameWidth,
      frameHeight: state.frameHeight,
      emptyCaptureArea: state.emptyCaptureArea,
      lastError: state.lastError,
      entryAction:
        'Local ENTER PRIVATE DESKTOP button',
      remoteInputInjected: false,
    },
  };
}

async function viewerStart(
  input: unknown,
): Promise<{ data: unknown }> {
  assertWindows();
  const parsed = ViewerStartSchema.parse(input);
  const existing = await readState();

  if (
    existing &&
    processAlive(existing.pid) &&
    (await heartbeatFresh())
  ) {
    // Agent process restarts lose the in-memory refresh interval while the
    // independent WPF viewer may still be alive. Resume capture for the
    // existing viewer instead of returning a misleading reused=true state
    // that silently expires its heartbeat after 20 seconds.
    if (!refreshTimer) {
      startRefreshLoop(existing);
    }
    return {
      data: {
        ...(await viewerStatus()).data as Record<
          string,
          unknown
        >,
        reused: true,
      },
    };
  }

  if (existing && processAlive(existing.pid)) {
    try {
      process.kill(existing.pid);
    } catch {
      // Best effort stale-viewer cleanup.
    }
  }

  stopRefreshLoop();
  await cleanupRuntime(false);
  await ensureViewerScript();

  let state: PrivateViewerState = {
    version: 1,
    pid: 0,
    startedAt: new Date().toISOString(),
    refreshMs: parsed.refresh_ms,
    maxWidth: parsed.max_width,
    maxHeight: parsed.max_height,
    maxBytes: parsed.max_bytes,
    topmost: parsed.topmost,
    selectedMonitorId: null,
    lastSelectionError: null,
    emptyCaptureArea: null,
    lastFrameAt: null,
    frameBytes: null,
    frameWidth: null,
    frameHeight: null,
    lastError: null,
  };

  state = await captureAndPersist(state);
  if (!state.lastFrameAt) {
    throw new PrivateViewerError(
      'PRIVATE_VIEWER_INITIAL_CAPTURE_FAILED',
      state.lastError ||
        'Could not capture the first private-desktop frame.',
    );
  }

  const p = runtimePaths();
  const child = spawn(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      p.viewer,
      '-FramePath',
      p.frame,
      '-StatePath',
      p.state,
      '-HeartbeatPath',
      p.heartbeat,
      '-WindowsPath',
      p.windows,
      '-DisplaysPath',
      p.displays,
      '-MonitorSelectionPath',
      p.monitorSelection,
      '-EmergencyPath',
      p.emergency,
      '-EmergencyResultPath',
      p.emergencyResult,
      '-RefreshMs',
      String(parsed.refresh_ms),
      '-Topmost',
      parsed.topmost ? '1' : '0',
    ],
    {
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: 'ignore',
    },
  );

  if (!child.pid) {
    throw new PrivateViewerError(
      'PRIVATE_VIEWER_START_FAILED',
      'Windows did not return a viewer process id.',
    );
  }

  state = {
    ...state,
    pid: child.pid,
  };
  await writeState(state);

  await new Promise((resolve) =>
    setTimeout(resolve, 400),
  );
  if (!processAlive(child.pid)) {
    await cleanupRuntime(false);
    throw new PrivateViewerError(
      'PRIVATE_VIEWER_EXITED_EARLY',
      'Nexowire Private Viewer exited during startup.',
    );
  }

  child.once('exit', () => {
    stopRefreshLoop();
    void cleanupRuntime(false);
  });

  startRefreshLoop(state);

  return {
    data: {
      ...(await viewerStatus()).data as Record<
        string,
        unknown
      >,
      reused: false,
    },
  };
}

async function viewerStop(): Promise<{
  data: unknown;
}> {
  assertWindows();
  stopRefreshLoop();
  const state = await readState();
  let stopped = false;

  if (state && processAlive(state.pid)) {
    try {
      process.kill(state.pid);
      stopped = true;
    } catch {
      // Status verification below remains authoritative.
    }
  }

  if (state) {
    const deadline = Date.now() + 3_000;
    while (
      processAlive(state.pid) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, 50),
      );
    }
    if (processAlive(state.pid)) {
      throw new PrivateViewerError(
        'PRIVATE_VIEWER_STOP_NOT_VERIFIED',
        'Private viewer process did not exit.',
        { pid: state.pid },
      );
    }
  }

  await cleanupRuntime(false);
  return {
    data: {
      running: false,
      stopped,
      localViewer: true,
    },
  };
}

export async function executeWindowsPrivateViewerCapability(
  capability: string,
  input: unknown,
): Promise<unknown> {
  switch (capability) {
    case 'windows.private_viewer.status':
      return await viewerStatus();
    case 'windows.private_viewer.start':
      return await viewerStart(input);
    case 'windows.private_viewer.stop':
      return await viewerStop();
    default:
      throw new PrivateViewerError(
        'UNSUPPORTED',
        'Unsupported private viewer capability: ' +
          capability,
      );
  }
}
