# Deployment Onboarding

The onboarding command creates a safe deployment starting point without writing plaintext bearer tokens into repository files, launcher arguments, or Nexowire state.

## Plan

```text
nexowire onboard plan
nexowire onboard plan --remote
```

Plan mode is non-mutating. It runs the existing deployment-readiness model and explains the remaining steps.

## Bootstrap

```text
nexowire onboard bootstrap
nexowire onboard bootstrap --remote
```

Bootstrap issues missing MCP and native-agent credentials through the hash-only credential store. Each plaintext token is returned once in command output and is not persisted by the credential store.

Useful scope options:

```text
--mcp-role user|operator|admin
--mcp-ttl-days N
--agent-ttl-days N
--allow-tool PATTERN
--allow-device STABLE_ID
--allow-route POLICY
```

Repeated bootstrap does not create duplicates while usable credentials already exist. `--force` explicitly creates an overlapping new pair for rotation.

## After bootstrap

Store the one-time native-agent credential through a protected source on the target machine, then configure only its reference in the agent environment.

For the MCP credential, place the one-time token in the ChatGPT/client connector's secret configuration rather than a repository file.

For remote deployments, `nexowire doctor --remote` remains authoritative. Onboarding does not pretend a loopback/plaintext/missing-TLS deployment is production-ready merely because credentials now exist. Humanity has enough green checkmarks with no relationship to reality.
