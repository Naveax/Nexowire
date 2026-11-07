import test from 'node:test';
import assert from 'node:assert/strict';
import {requireBoundRemoteMutationAuthorization} from '../../src/runtime.js';
import {AgentBroker} from '../../src/core/agent-broker.js';

test('Round4 public remote-only configuration requires strict owner/device verifier',()=>{
  assert.equal(requireBoundRemoteMutationAuthorization({remoteAgentAuthOnly:true}),true);
  assert.equal(requireBoundRemoteMutationAuthorization({remoteAgentAuthOnly:false}),false);
  assert.equal(requireBoundRemoteMutationAuthorization({}),false);
  const broker=new AgentBroker({
    requireMutationReauthorization:requireBoundRemoteMutationAuthorization({remoteAgentAuthOnly:true}),
  });
  assert.equal(broker.isMandatoryMutationReauthorizationEnabled(),true,
    'production runtime must construct strict broker for public remote Agent admission');
});
