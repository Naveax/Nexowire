import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

const PriorityStatusSchema = z.enum([
  'done',
  'partial',
  'planned',
  'blocked',
]);

const ActiveWorkStatusSchema = z.enum([
  'implementation',
  'testing',
  'planned',
  'blocked',
]);

const ProjectStateSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.literal('Nexowire'),
  canonicalRepository: z.literal('Naveax/Nexowire'),
  canonicalBranch: z.literal('main'),
  runtimeOwnership: z.literal('first-party-only'),
  continuationFiles: z.array(z.string().min(1)).min(4).max(32),
  invariants: z.array(z.string().min(1)).min(1).max(128),
  priorities: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z0-9][a-z0-9-]*$/),
        status: PriorityStatusSchema,
        priority: z.number().int().positive(),
        summary: z.string().min(1).max(10_000),
      }),
    )
    .min(1)
    .max(256),
  standardVerification: z.array(z.string().min(1)).min(1).max(64),
  hotFiles: z.array(z.string().min(1)).min(1).max(128),
  notes: z.array(z.string().min(1)).max(256),
  lastStateSync: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/),
  lastVerifiedMain: z.string().regex(/^[a-f0-9]{40}$/),
  activeWork: z
    .array(
      z.object({
        branch: z.string().min(1).max(256),
        status: ActiveWorkStatusSchema,
        goal: z.string().min(1).max(10_000),
      }),
    )
    .max(64),
});

export type ProjectState = z.infer<typeof ProjectStateSchema>;

export interface ProjectStateValidation {
  state: ProjectState;
  checkedFiles: string[];
}

function assertUnique(
  values: readonly string[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${label} contains duplicate value: ${value}`);
    }
    seen.add(value);
  }
}

const LITERAL_MARKDOWN_LINE_BREAK_ARTIFACT =
  /\\(?:r\\n|n)(?=(?:#{1,6}\s|[-*+]\s|\d+\.\s))/;

function assertNoLiteralMarkdownLineBreakArtifact(
  relative: string,
  content: string,
): void {
  if (
    LITERAL_MARKDOWN_LINE_BREAK_ARTIFACT.test(content)
  ) {
    throw new Error(
      `${relative} contains a literal escaped newline before Markdown structure; use a real line break instead.`,
    );
  }
}

async function assertRegularFile(
  root: string,
  relative: string,
): Promise<void> {
  const absolute = path.resolve(root, relative);
  const rootPrefix = path.resolve(root) + path.sep;
  if (
    absolute !== path.resolve(root) &&
    !absolute.startsWith(rootPrefix)
  ) {
    throw new Error(
      `Project-state path escapes repository root: ${relative}`,
    );
  }
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) {
    throw new Error(
      `Project-state path is not a regular file: ${relative}`,
    );
  }
}

export function parseProjectState(value: unknown): ProjectState {
  const state = ProjectStateSchema.parse(value);

  assertUnique(state.continuationFiles, 'continuationFiles');
  assertUnique(
    state.priorities.map((entry) => entry.id),
    'priority ids',
  );
  assertUnique(
    state.priorities.map((entry) => String(entry.priority)),
    'priority numbers',
  );
  assertUnique(state.hotFiles, 'hotFiles');
  assertUnique(
    state.activeWork.map((entry) => entry.branch),
    'activeWork branches',
  );

  const ordered = [...state.priorities].sort(
    (a, b) => a.priority - b.priority,
  );
  if (
    ordered.some(
      (entry, index) =>
        entry.id !== state.priorities[index]?.id,
    )
  ) {
    throw new Error(
      'PROJECT_STATE priorities must stay sorted by ascending priority.',
    );
  }

  return state;
}

export async function validateProjectState(
  root = process.cwd(),
): Promise<ProjectStateValidation> {
  const file = path.join(root, 'PROJECT_STATE.json');
  const state = parseProjectState(
    JSON.parse(await fs.readFile(file, 'utf8')),
  );

  const requiredContinuation = new Set([
    'docs/CONTINUATION.md',
    'HANDOFF.md',
    'ROADMAP.md',
    'PROJECT_STATE.json',
  ]);
  for (const required of requiredContinuation) {
    if (!state.continuationFiles.includes(required)) {
      throw new Error(
        `continuationFiles is missing required source of truth: ${required}`,
      );
    }
  }

  const checked = [
    ...state.continuationFiles,
    ...state.hotFiles,
  ];
  for (const relative of [...new Set(checked)]) {
    await assertRegularFile(root, relative);
  }

  for (const relative of state.continuationFiles) {
    if (!relative.toLowerCase().endsWith('.md')) {
      continue;
    }
    assertNoLiteralMarkdownLineBreakArtifact(
      relative,
      await fs.readFile(
        path.join(root, relative),
        'utf8',
      ),
    );
  }

  const continuation = await fs.readFile(
    path.join(root, 'docs', 'CONTINUATION.md'),
    'utf8',
  );
  for (const relative of state.continuationFiles) {
    if (!continuation.includes(relative)) {
      throw new Error(
        `docs/CONTINUATION.md does not mention ${relative}`,
      );
    }
  }

  const handoff = await fs.readFile(
    path.join(root, 'HANDOFF.md'),
    'utf8',
  );
  if (!handoff.includes('Canonical branch: `main`')) {
    throw new Error(
      'HANDOFF.md must declare main as the canonical branch.',
    );
  }
  if (!handoff.includes('## Resume protocol')) {
    throw new Error(
      'HANDOFF.md must preserve the cross-chat Resume protocol.',
    );
  }

  return {
    state,
    checkedFiles: [...new Set(checked)].sort(),
  };
}
