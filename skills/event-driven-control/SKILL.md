---
manifest_version: 2
name: event-driven-control
description: Start or observe managed work and consume bounded remote process/agent events with cursor-based long polling instead of repeatedly re-reading full state.
version: 0.1
requires: process.start, process.read
prefers: process.list
platforms: any
mutation: mixed
privilege: user
trust: reviewed
tags: events, polling, efficiency
concurrency: serial
replay: manual
---

# Event-Driven Control

Use the `events_read` MCP tool when you need to wait for remote activity such as process output, process exit, or agent connect/disconnect.

## Workflow

1. Start the process or operation normally when the task requires one. Starting work is a mutation and is never replay-safe by default.
2. Record the returned event cursor from `events_read`.
3. Read only the topics you care about, usually `process.output`, `process.exited`, `agent.connected`, or `agent.disconnected`.
4. Use `wait_ms` for a bounded long poll instead of hammering the remote machine with repeated status calls.
5. Reuse `nextSeq` as the next `after_seq`.
6. If `cursorExpired` is true, the in-memory event ring has already dropped older events. Reconcile with a structured state read such as `process_list` or `process_read`, then continue from the new cursor.

## Replay and concurrency

The observation phase is read-only, but the complete workflow may create a process. Therefore this skill is deliberately `mutation: mixed`, `concurrency: serial`, and `replay: manual`.

A disconnect after `process.start` can leave the launch state ambiguous. Verify managed process/session state before deciding whether another start is safe. Do not infer replay safety merely because later event reads are read-only.

## Rules

- Event delivery is transient and bounded. It is an efficiency layer, not durable history.
- Process stdout/stderr may contain sensitive data. Do not treat the event feed as an audit log.
- A `process.exited` event is useful evidence, but verify the final state if a later action depends on it.
- Do not tight-poll with `wait_ms: 0` unless you genuinely need an immediate snapshot.
- Agent disconnects can make a mutation state ambiguous. Never replay a mutation merely because the event stream reported a disconnect.
