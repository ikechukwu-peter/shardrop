/** The one live peer connection, shared between the signaling and transfer UI. */
import type { PeerSession } from "../core/peer";

let current: PeerSession | undefined;
const listeners: ((peer: PeerSession) => void)[] = [];

export function setSession(peer: PeerSession): void {
  current = peer;
  for (const listener of listeners) listener(peer);
}

export function getSession(): PeerSession | undefined {
  return current;
}

export function onSession(listener: (peer: PeerSession) => void): void {
  listeners.push(listener);
  if (current) listener(current);
}
