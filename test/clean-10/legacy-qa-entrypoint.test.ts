/**
 * The repository's npm test glob selects test/<subdir>/*.test.ts but does
 * not automatically discover flat test/*.test.ts. Import the exact historical
 * QA-02/QA-18 source files without editing any original assertion.
 *
 * On non-Windows runners the original physical Windows Job fixture remains
 * explicitly skipped; it still needs a separately evidenced Windows run.
 */
import '../qa-02-error-contract-no-replay.test.js';
import '../qa-02-windows-output-ordering.test.js';
import '../qa-18-durable-runbook-cloned-unknown-negative.test.js';
