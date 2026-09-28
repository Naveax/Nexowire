# Skills

Nexowire skills are reusable operating procedures that teach the AI how to combine low-level capabilities reliably.

A skill is not another name for a tool.

- Tool: `shell.exec`
- Skill: `build-and-test`
- Tool: `workspace.snapshot`
- Skill: `repo-resume`

Each skill lives at `skills/<name>/SKILL.md`. The MCP server exposes lightweight metadata through `skills_list` and loads the full Markdown only through `skill_read`. This keeps normal tool context small.

## Initial skills

- `repo-resume`
- `fast-repo-inspect`
- `build-and-test`
- `powershell-expert`
- `wsl-workflow`
- `windows-diagnostics`
- `verify-before-finish`
- `remote-recovery`

Later manifests will declare capabilities, mutation level, privilege requirements, platforms, scripts, and references in machine-readable form.
