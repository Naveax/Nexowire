export const PINNED_BACKEND_COMMIT: string;
export const UI_ONLY_FILES: readonly string[];
export interface UiReleaseCheck {
  backendSha: string;
  modifiedPaths: readonly string[];
  baseline: Record<string, Buffer>;
  candidate: Record<string, Buffer>;
  live: Record<string, Buffer> | null;
}
export interface UiReleaseManifest {
  backendCommit: string;
  files: Array<{
    path: string;
    oldSha256: string;
    newSha256: string;
    oldBytes: number;
    newBytes: number;
  }>;
  newApiRoutes: string[];
  liveBaselineMatched: boolean;
  productionDeploymentPerformed: false;
  backendRuntimeAttested: false;
}
export function verifyUiOnlyRelease(input: UiReleaseCheck): UiReleaseManifest;
export function main(args?: readonly string[]): Promise<void>;
