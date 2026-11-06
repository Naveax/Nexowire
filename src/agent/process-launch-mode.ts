/** The explicit personal local-owner profile uses ordinary user processes.
 * This avoids making user-shell availability depend on the optional Windows
 * Job guardian. It provides best-effort tree cleanup, not Job containment.
 * It never changes the private-desktop launch path or Windows token privilege. */
export function useWindowsJobForProcess(env:NodeJS.ProcessEnv=process.env,
  platform:NodeJS.Platform=process.platform):boolean {
  return platform==='win32'&&env.NEXOWIRE_CORE_APPROVAL_MODE!=='local-owner';
}
