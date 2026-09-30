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
