// Host mode (RFC 0003 section 12.5), without React: `defineHost` serves a
// contract's host-served channels and streams as the host of an app room,
// and `hostOf` / `onHostChange` say who hosts a room this connection's
// socket is in. A peer needs neither: `useChannel` and `useStream` route a
// host-served member to the room's host. Exported from
// `@fitzzero/quickdraw-core/client`.
//
// React-free.

export {
  defineHost,
  type Host,
  type HostChannelContext,
  type HostChannelHandler,
  type HostDefinition,
  type HostImplementation,
  type HostPeer,
  type HostStream,
  type HostStreamOptions,
} from "./host";
export { hostOf, onHostChange, type HostListener } from "./hosts";
