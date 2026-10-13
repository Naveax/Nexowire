# AI Screen: graceful private-window close

`windows_private_desktop_close_window` is a deliberately narrow management tool.
Input is **one exact top-level HWND** obtained from
`windows_private_desktop_windows`. The native agent accepts it only when:

1. `NexowirePrivate` is running.
2. The handle is currently enumerated on that desktop.
3. Its owning process is one of `launchedPids` tracked by
   `windows_private_desktop_launch`.
4. The private input helper independently verifies the HWND still belongs
   to `NexowirePrivate` immediately before posting `WM_CLOSE`.

It never calls `SetForegroundWindow`, `SwitchDesktop`, `SendInput` or
`TerminateProcess`; never sends to the owner's `Default` desktop; and
cannot close the private shell or arbitrary/untracked processes.

The response separates `closeRequested` from `closed`: a private app
may show an unsaved-changes prompt, refuse closure or need more time.
A successful WM_CLOSE post does not claim the program process was forcibly
terminated. The response includes `hwnd`, `processId`, `desktopName`,
input desktop before/after, `touchesSystemCursor:false`, and
`forcedProcessTermination:false`.

This API is intended for locally approved application management in the
Viewer. The UI still needs an explicit confirmation control and a meaningful
result/error display before local close actions are wired to the API.

## Acceptance

Windows DEV tests run a real managed WPF window on `NexowirePrivate`,
reject a request to close the untracked private shell, reject an unknown HWND,
then post WM_CLOSE to the managed app and verify its HWND disappears while
the user's visible `Default` desktop and pointer remain unchanged.

This does not claim broad GUI isolation, long physical focus acceptance,
or that every shell-brokered/COM/UAC app can be safely controlled.
