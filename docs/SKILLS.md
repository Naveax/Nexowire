# Skills

Nexowire skills are reusable operating procedures that teach the AI how to combine low-level capabilities reliably.

A skill is not another name for a tool.

- Tool: `shell.exec`
- Skill: `build-and-test`
- Tool: `workspace.snapshot`
- Skill: `repo-resume`

Each skill lives at `skills/<name>/SKILL.md`. The MCP server exposes lightweight machine-readable metadata through `skills_list` and loads the full Markdown only through `skill_read`. This keeps normal tool context small while allowing the model to choose workflows based on the actual target machine.

## Manifest v1

The YAML-like frontmatter is intentionally small and dependency-free:

```text
---
name: repo-resume
description: Resume an existing software workspace safely.
version: 0.1
requires: workspace.snapshot, search.text, files.read_many, shell.exec
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: repo, resume, workspace
---
```

Fields:

- `name`: stable skill identifier. It must match the directory name.
- `description`: short discovery text.
- `version`: skill workflow version.
- `requires`: comma-separated Nexowire capabilities needed by the workflow.
- `platforms`: comma-separated Node platform names or `any`.
- `mutation`: `read-only`, `mixed`, or `mutation`.
- `privilege`: `user` or `elevated`.
- `trust`: `trusted`, `reviewed`, or `experimental`.
- `tags`: bounded discovery labels.

Older manifests remain compatible through conservative defaults, but shipped Nexowire skills should declare all fields explicitly.

## Runtime selection

`skills_list` can be called without a device for global metadata, or with `device_id`/alias to evaluate a skill against one exact online device. Device-aware results include:

- `runnable`
- `platformCompatible`
- `missingCapabilities`

This avoids loading a Windows/UIA workflow for a Linux machine or proposing a workflow whose required capabilities are not actually advertised by the selected agent. Because apparently discovering incompatibility before executing five commands is considered an optimization.

`skill_read` accepts the same optional device selector and returns both the manifest/evaluation and Markdown body.

`skills_validate` checks every installed skill directory and reports malformed manifests, directory/name mismatches, invalid policy fields, and other metadata errors without silently pretending the library is healthy.

## Current shipped skills

- `repo-resume`
- `fast-repo-inspect`
- `conflict-safe-edit`
- `parallel-task-graph`
- `event-driven-control`
- `network-troubleshoot`
- `build-and-test`
- `powershell-expert`
- `wsl-workflow`
- `windows-diagnostics`
- `windows-environment`
- `windows-window-control`
- `windows-screenshot`
- `windows-input-control`
- `windows-accessibility`
- `windows-pointer-control`
- `verify-before-finish`
- `remote-recovery`
- `browser-control`
- `durable-runbook`
- `git-safe-workflow`
- `project-bootstrap`
- `dependency-install`
- `process-debug`
- `service-debug`
- `application-repair`
- `disk-space-recovery`
- `deploy-verify`
- `machine-bootstrap`
- `incident-triage`
- `port-conflict`
- `tls-diagnostics`
- `log-triage`
- `safe-config-migration`
- `backup-restore`
- `backup-integrity-audit`
- `performance-triage`
- `browser-workflow-recovery`
- `large-file-investigation`
- `artifact-integrity-audit`
- `browser-session-inspection`
- `service-readiness-audit`
- `workspace-regression-triage`
- `release-readiness-audit`

## Operational recipe set

The v2 recipe expansion covers common work that previously required reconstructing the same plan from primitive tools every time: safe Git changes, project/bootstrap setup, dependency changes, process/service diagnosis, application repair, disk recovery, deployment verification, machine bootstrap, and read-only incident triage. The v3 specialized pack adds exact port-conflict diagnosis, TLS/certificate triage, bounded log analysis, rollback-aware config migration, verified file backup/restore, read-only performance triage, browser workflow recovery, and evidence-first large-file investigation. The current domain pack adds artifact-integrity auditing, mutation-free browser-session inspection, service-readiness auditing, evidence-first workspace regression triage, release-readiness auditing, and read-only backup-integrity auditing; each opts into manifest v2 with explicit replay/concurrency semantics rather than relying on vibes, a surprisingly durable human scheduling primitive.

These are still workflows, not magical permission bundles. A skill can propose `files.delete`; the runtime must still authorize and execute that capability normally. Tiny distinction, occasionally useful when the computer contains things people wanted to keep.

## Design rules

- Keep metadata cheap enough to expose in normal tool context.
- Load full workflow Markdown only when relevant.
- Do not make a skill executable merely because metadata says it is compatible; tool authorization and device policy still apply independently.
- Skill capability requirements describe workflow prerequisites, not permission escalation.
- Invalid skill directories are omitted from normal discovery and surfaced by `skills_validate`.
- Mutation, privilege, and trust labels inform planning; they do not bypass Nexowire's runtime security enforcement.


## Manifest v2

Manifest v1 remains the compatibility baseline and continues to parse unchanged.

A skill opts into v2 with `manifest_version: 2`. V2 is additive and currently adds:

- `requires_any`: semicolon-separated capability groups where at least one pipe-separated alternative in every group must be available.
- `prefers`: non-required capabilities that improve the workflow when present.
- `concurrency`: `serial` or `parallel-safe`.
- `replay`: `safe`, `verify`, or `manual`.

Read-only v2 skills may declare `replay: safe`. Mixed or mutation skills cannot. V1 skills cannot silently use v2-only fields; they must opt in explicitly so old manifests keep their exact semantics.
