// What host mode loads only to link to a room's host on another socket
// (`links.ts`, RFC 0003 section 12.5): the peer link and its control side.
// `links.ts` imports it dynamically and nothing else imports it, so with a
// bundler that splits dynamic imports by module (rollup, rolldown,
// webpack) an app that never makes such a link never downloads the peer
// links (WebRTC, the relay, the lag simulator). esbuild's code splitting
// keeps them at startup: `./client` re-exports `createPeerLink`.
//
// React-free.

export { controlOf } from "../peer/core";
export { createPeerLink } from "../peer/link";
