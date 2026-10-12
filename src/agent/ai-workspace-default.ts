/**
 * A single source of truth for the default AI command destination.
 * Missing policy preserves legacy headless behavior in deployed agents.
 * The owner may opt into private-desktop-by-default in a reviewed staging
 * environment without editing every AI prompt or API call.
 */
export type AiWorkspaceTarget='headless'|'private_desktop';

export function resolveAiWorkspaceTarget(
  explicit:AiWorkspaceTarget|undefined,
  options:{
    platform?:NodeJS.Platform;
    env?:NodeJS.ProcessEnv;
  }={},
):AiWorkspaceTarget {
  const platform=options.platform??process.platform;
  const configured=(options.env??process.env).NEXOWIRE_AI_UI_TARGET_DEFAULT;

  const target=explicit??configured??'headless';
  if(target!=='headless'&&target!=='private_desktop'){
    throw new Error('AI_WORKSPACE_DEFAULT_POLICY_INVALID');
  }
  if(target==='private_desktop'&&platform!=='win32'&&explicit===undefined){
    throw new Error('AI_PRIVATE_DESKTOP_REQUIRES_WINDOWS');
  }
  return target;
}

/**
 * WSLg/Explorer-mediated GUI processes may appear on the physical Default
 * desktop despite hiding wsl.exe's own console. Until Windows proves a
 * private compositor/desktop for WSLg, refuse private AI requests rather
 * than silently launch on Default. Explicit legacy headless is still opt-in.
 */
export function requireWslHeadlessRouting(
  explicit:AiWorkspaceTarget|undefined,
  options:{
    platform?:NodeJS.Platform;
    env?:NodeJS.ProcessEnv;
  }={},
):'headless'{
  const target=resolveAiWorkspaceTarget(explicit,options);
  if(target==='private_desktop'){
    const error=Object.assign(
      new Error('WSL GUI routing is not confined to NexowirePrivate; explicit headless mode is required.'),
      {code:'WSL_PRIVATE_GUI_NOT_ISOLATED'},
    );
    throw error;
  }
  return 'headless';
}
