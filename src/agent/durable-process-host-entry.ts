import { runDurableProcessHost } from './durable-process-host.js';

runDurableProcessHost().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.stack ?? error.message : String(error)) +
      '\n',
  );
  process.exit(1);
});
