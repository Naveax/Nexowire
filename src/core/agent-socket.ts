export const AGENT_SOCKET_OPEN = 1;
export const AGENT_SOCKET_CLOSED = 3;

export interface AgentSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'message', listener: (data: unknown) => void): this;
  once(event: 'close', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}
