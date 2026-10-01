---
name: deploy-verify
description: Run a resumable deployment workflow and prove the resulting service state with explicit network/application postconditions.
version: 0.1
requires: runbook.run, task.graph.run, verify.assertions, network.dns.resolve, network.tcp.probe, network.http.probe
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: deploy, verification, runbook, network
---

# Deploy Verify

Use this skill for deployments where success must survive disconnects and be proven rather than inferred from a command exit code.

## Workflow

1. Model build/package/deploy work as task-graph stages inside a durable runbook.
2. Keep independent preparation stages parallel when safe.
3. Add read-only assertions after mutations.
4. Verify DNS only if hostname resolution is part of the path.
5. Verify the expected TCP listener.
6. Verify HTTP status/endpoint semantics when the service is HTTP-based.
7. On interruption, resume the exact runbook specification.
8. Never auto-retry an unknown mutation stage without explicit retry semantics or external verification.
9. Record artifact hashes/metadata when files are the handoff between stages.

## Completion

A deployment is complete only when its declared postconditions pass. "Command returned 0" is evidence about the command, not necessarily the service.
