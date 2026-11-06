/**
 * AI-04 single-writer handoff for AI-05 AgentBroker integration.
 *
 * This helper only seals socket/incarnation identity at the dispatch boundary.
 * The injected coordinator still requires an INDEPENDENT durable authority to
 * linearize revocation against dispatch. It is not an OS/native effect permit.
 */
import WebSocket from 'ws';
import {
  AtomicMutationCoordinator,
  MutationAuthorityDenied,
  type MutationReservation,
  type WireMutation,
} from './atomic-mutation-authority.js';

export interface SocketBoundAgentConnection {
  readonly device: {readonly id: string};
  readonly instanceId: string;
  readonly socket: {
    readonly readyState: number;
    send(frame: string): void;
  };
}

export interface SocketBoundMutationInput {
  readonly deviceId: string;
  readonly request: WireMutation;
  readonly connection: SocketBoundAgentConnection;
  readonly currentConnection: () => SocketBoundAgentConnection | undefined;
  readonly coordinator: AtomicMutationCoordinator | undefined;
}

/**
 * This is a SOURCE-ONLY integration seam. AI-05 must invoke it ONLY for strict
 * remote mutations and must preserve legacy read-only behavior separately.
 * Never use the currentConnection getter as external owner/device authority.
 */
export async function dispatchSocketBoundMutation(
  options: Readonly<SocketBoundMutationInput>,
): Promise<MutationReservation> {
  if (!options.coordinator) throw new MutationAuthorityDenied('AGENT_AUTH_NOT_BOUND');

  const validSocket = (): boolean => {
    try {
      return options.connection.device.id === options.deviceId &&
        options.currentConnection() === options.connection &&
        options.connection.socket.readyState === WebSocket.OPEN;
    } catch {
      return false;
    }
  };
  if (!validSocket()) throw new MutationAuthorityDenied('AGENT_OFFLINE');

  return options.coordinator.dispatch(options.request, exactFrame => {
    // On the same event loop, do not await between the final local epoch check
    // and socket.send. Still NOT sufficient for distributed revocation ordering.
    if (!validSocket()) throw new MutationAuthorityDenied('AGENT_OFFLINE');
    options.connection.socket.send(exactFrame);
  });
}
