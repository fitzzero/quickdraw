// Peer links (RFC 0003 section 12.5), without React: `createPeerLink` opens
// a link to another socket of an app room, `onPeerRequest` hears one that
// asks for a link. Exported from `@fitzzero/quickdraw-core/client`.
//
// React-free.

export type { PeerClock } from "./clock";
export {
  createPeerLink,
  DEFAULT_ICE_SERVERS,
  DIRECT_TIMEOUT_MS,
  OPEN_TIMEOUT_MS,
  onPeerRequest,
  type PeerLinkOptions,
  type PeerRequest,
  type RelayMode,
} from "./link";
export type { PeerConnectionConfig, PeerIceServer } from "./rtc";
export type {
  PeerCloseReason,
  PeerLabel,
  PeerLink,
  PeerLinkEvents,
  PeerLinkLag,
  PeerLinkLagOptions,
  PeerLinkState,
  PeerLinkStats,
  PeerPath,
} from "./types";
