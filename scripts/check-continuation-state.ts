import { validateProjectState } from '../src/continuation/project-state.js';

const result = await validateProjectState(process.cwd());
console.log(
  JSON.stringify(
    {
      ok: true,
      schemaVersion: result.state.schemaVersion,
      canonicalRepository: result.state.canonicalRepository,
      canonicalBranch: result.state.canonicalBranch,
      lastStateSync: result.state.lastStateSync,
      lastVerifiedMain: result.state.lastVerifiedMain,
      activeWork: result.state.activeWork,
      checkedFiles: result.checkedFiles,
    },
    null,
    2,
  ),
);
