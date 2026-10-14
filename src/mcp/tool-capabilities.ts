export const MCP_TOOL_CAPABILITY_REQUIREMENTS = {
  verify_assertions: 'verify.assertions',
  browser_session_start: 'browser.session.start',
  browser_session_list: 'browser.session.list',
  browser_session_stop: 'browser.session.stop',
  browser_tabs: 'browser.tabs',
  browser_navigate: 'browser.navigate',
  browser_snapshot: 'browser.snapshot',
  browser_click: 'browser.click',
  browser_set_value: 'browser.set_value',
  browser_visual_verify: 'browser.visual.verify',
  browser_screenshot: 'browser.screenshot',
  machine_snapshot: 'machine.snapshot',
  machine_health: 'machine.health',
  nexowire_update_status: 'nexowire.update.status',
  nexowire_update_check: 'nexowire.update.check',
  nexowire_update_apply: 'nexowire.update.apply',
  network_dns_resolve: 'network.dns.resolve',
  network_tcp_probe: 'network.tcp.probe',
  network_http_probe: 'network.http.probe',
  windows_window_list: 'windows.window.list',
  windows_window_focus: 'windows.window.focus',
  windows_screenshot: 'windows.screenshot',
  windows_clipboard_read: 'windows.clipboard.read',
  windows_clipboard_write: 'windows.clipboard.write',
  windows_clipboard_clear: 'windows.clipboard.clear',
  windows_keyboard_type: 'windows.keyboard.type',
  windows_keyboard_hotkey: 'windows.keyboard.hotkey',
  windows_accessibility_tree: 'windows.accessibility.tree',
  windows_accessibility_find: 'windows.accessibility.find',
  windows_accessibility_invoke: 'windows.accessibility.invoke',
  windows_accessibility_set_value: 'windows.accessibility.set_value',
  windows_pointer_position: 'windows.pointer.position',
  windows_pointer_move: 'windows.pointer.move',
  windows_pointer_click: 'windows.pointer.click',
  windows_pointer_scroll: 'windows.pointer.scroll',
  windows_virtual_pointer_status: 'windows.virtual_pointer.status',
  windows_virtual_pointer_start: 'windows.virtual_pointer.start',
  windows_virtual_pointer_stop: 'windows.virtual_pointer.stop',
  windows_virtual_pointer_move: 'windows.virtual_pointer.move',
  windows_virtual_pointer_style: 'windows.virtual_pointer.style',
  windows_virtual_pointer_visibility: 'windows.virtual_pointer.visibility',
  windows_private_screen_capture: 'windows.private_screen.capture',
  windows_private_screen_capture_set: 'windows.private_screen.capture_set',
  windows_private_display_plan: 'windows.private_display.plan',
  windows_private_display_topology: 'windows.private_display.topology',
  windows_private_display_backend_probe: 'windows.private_display.backend_probe',
  windows_private_display_readiness: 'windows.private_display.readiness',
  windows_private_display_profile_status: 'windows.private_display.profile.status',
  windows_private_display_profile_set: 'windows.private_display.profile.set',
  windows_private_display_profile_reset: 'windows.private_display.profile.reset',
  windows_private_viewer_status: 'windows.private_viewer.status',
  windows_private_viewer_start: 'windows.private_viewer.start',
  windows_private_viewer_stop: 'windows.private_viewer.stop',
  windows_private_desktop_status: 'windows.private_desktop.status',
  windows_private_desktop_start: 'windows.private_desktop.start',
  windows_private_desktop_stop: 'windows.private_desktop.stop',
  windows_private_desktop_launch: 'windows.private_desktop.launch',
  windows_private_desktop_windows: 'windows.private_desktop.windows',
  windows_private_desktop_controls: 'windows.private_desktop.controls',
  windows_private_desktop_accessibility: 'windows.private_desktop.accessibility',
  windows_private_desktop_accessibility_resolve: 'windows.private_desktop.accessibility.resolve',
  windows_private_desktop_accessibility_invoke_button: 'windows.private_desktop.accessibility.invoke_button',
  windows_private_desktop_accessibility_set_edit_value: 'windows.private_desktop.accessibility.set_edit_value',
  windows_private_desktop_accessibility_set_checkbox: 'windows.private_desktop.accessibility.set_checkbox',
  windows_private_desktop_accessibility_select_radio: 'windows.private_desktop.accessibility.select_radio',
  windows_private_desktop_window_audit: 'windows.private_desktop.window_audit',
  windows_private_desktop_process_audit: 'windows.private_desktop.process_audit',
  windows_private_desktop_owner_gui_audit: 'windows.private_desktop.owner_gui_audit',
  windows_private_desktop_close_window: 'windows.private_desktop.window.close',
  windows_private_desktop_show: 'windows.private_desktop.show',
  windows_private_pointer_move: 'windows.private_pointer.move',
  windows_private_pointer_click: 'windows.private_pointer.click',
  windows_private_pointer_scroll: 'windows.private_pointer.scroll',
  windows_private_keyboard_type: 'windows.private_keyboard.type',
  windows_private_keyboard_hotkey: 'windows.private_keyboard.hotkey',
  windows_private_clipboard_status: 'windows.private_clipboard.status',
  windows_private_clipboard_read: 'windows.private_clipboard.read',
  windows_private_clipboard_write: 'windows.private_clipboard.write',
  windows_private_clipboard_clear: 'windows.private_clipboard.clear',
  windows_private_clipboard_paste: 'windows.private_clipboard.paste',
  windows_console_control_status: 'windows.console_control.status',
  windows_console_control_request: 'windows.console_control.request',
  windows_console_control_revoke: 'windows.console_control.revoke',
  windows_uac_status: 'windows.uac.status',
  windows_processes: 'windows.processes',
  windows_services: 'windows.services',
  windows_network_snapshot: 'windows.network.snapshot',
  windows_service_control: 'windows.service.control',
  windows_registry_read: 'windows.registry.read',
  windows_tasks: 'windows.tasks',
  windows_eventlog_query: 'windows.eventlog.query',
  windows_firewall_rules: 'windows.firewall.rules',
  windows_registry_set: 'windows.registry.set',
  windows_registry_delete: 'windows.registry.delete',
  windows_task_control: 'windows.task.control',
  windows_firewall_control: 'windows.firewall.control',
  windows_environment_list: 'windows.environment.list',
  windows_environment_read: 'windows.environment.read',
  windows_environment_set: 'windows.environment.set',
  windows_environment_delete: 'windows.environment.delete',
  windows_installer_preflight: 'windows.installer.preflight',
  windows_installer_apply: 'windows.installer.apply',
  windows_installer_status: 'windows.installer.status',
  shell_exec: 'shell.exec',
  process_start: 'process.start',
  process_read: 'process.read',
  process_write: 'process.write',
  process_stop: 'process.stop',
  process_list: 'process.list',
  process_prune: 'process.prune',
  wsl_exec: 'wsl.exec',
  file_read: 'files.read',
  file_read_many: 'files.read_many',
  file_write: 'files.write',
  file_stat: 'files.stat',
  file_hash: 'files.hash',
  file_mkdir: 'files.mkdir',
  file_copy: 'files.copy',
  file_move: 'files.move',
  file_delete: 'files.delete',
  file_patch: 'files.patch',
  file_list: 'files.list',
  search_text: 'search.text',
  workspace_snapshot: 'workspace.snapshot',
  workspace_detect: 'workspace.detect',
  workspace_run_checks: 'workspace.checks',
  task_run_graph: 'task.graph.run',
  task_graph_list: 'task.graph.list',
  task_graph_get: 'task.graph.get',
  task_graph_prune: 'task.graph.prune',
  task_artifact_list: 'task.artifact.list',
  task_artifact_verify: 'task.artifact.verify',
  runbook_run: 'runbook.run',
  runbook_list: 'runbook.list',
  runbook_get: 'runbook.get',
  runbook_prune: 'runbook.prune',
} as const satisfies Readonly<Record<string, string>>;

export type CapabilityBackedMcpToolName =
  keyof typeof MCP_TOOL_CAPABILITY_REQUIREMENTS;

export function requiredCapabilityForMcpTool(
  toolName: string,
): string | undefined {
  return (
    MCP_TOOL_CAPABILITY_REQUIREMENTS as Readonly<
      Record<string, string | undefined>
    >
  )[toolName];
}

export function isMcpToolAvailableForCapabilities(
  toolName: string,
  capabilities: ReadonlySet<string> | readonly string[],
): boolean {
  const required = requiredCapabilityForMcpTool(toolName);
  if (!required) return true;
  const available =
    capabilities instanceof Set
      ? capabilities
      : new Set(capabilities);
  return available.has(required);
}

export function onlineCapabilityUnion(
  targets: readonly {
    online: boolean;
    capabilities: readonly string[];
  }[],
): string[] {
  return [
    ...new Set(
      targets
        .filter((target) => target.online)
        .flatMap((target) => target.capabilities),
    ),
  ].sort();
}
