# AI-07 | FINAL — scoped source-only handoff

- **Review verdict:** DENY-ONLY SOURCE/DIAGNOSTIC. **Production CORE NO_GO**.
- **Existing Draft PR #990:** https://github.com/Naveax/Nexowire/pull/990; `ai/07-isolation-worker-20261031`, base `68ee74ce7e1e5a36c8ae2f9b065f49a5cb13cee9`. Latest exact branch HEAD must be read live from the PR.
- **Prior source exact HEAD:** `a6900ab9695d3524ca8999d3bd62975c3d4bab59` and [CI #41249427088](https://github.com/Naveax/Nexowire/actions/runs/41249427088), 6/7 success with Windows still running at checkpoint; no full CI claim before terminal.
- **This round's new code:** `src/agent/task-os-sandbox-policy.ts` extends partial lifecycle/OS readback UNKNOWN reconciliation when `mutationState` omitted. No task execution or native permit introduced.
- **New disposable test:** `test/ai07-sandbox-readback-unknown.test.ts`; 13 uncertain keys and hostile getters/Proxy, plus ordinary report controls. No test assertion weakened, no existing skip changed. **New exact HEAD CI pending** until published and verified.
- **Docs updated:** `docs/ai-handoff/AI-07/{STATUS,TEST_EVIDENCE,INTEGRATION_REQUEST,FINAL}.md`. No changes to coordinator #1004, #980, CI, shared Broker, CORE, runtime executors or real OS devices.
- **Coordinator merge handoff:** refresh #1004 from stale `d4f034...` ancestor against newest frozen #990; preserve original #980 AppContainer fixture blob and AI-07 diagnostic C blob `7d569...` at renamed `native/task-os-sandbox-windows-token-job-readback-p07.c` (as child implementation). This does not establish kernel isolation.
- **Remaining blockers:** exact new CI, protected native worker/independent verifier, AI-04/05 Broker/CAS pre-effect integration, cgroup/Job descendant-drain and revoke, file/network/handle isolation and real owner/device/session/physical acceptance.
- **Restrictions:** no merge, deploy, live process/Agent, UAC/ACL, credentials, installer, cloud tunnel or CORE activation.
