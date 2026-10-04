// The stream feeds of one dispatcher (RFC 0003 sections 4.4 and 12.5): the
// index of its sockets' subscriptions (`streamIndex.ts`), the socket
// listeners that subscribe and unsubscribe (`streamSubscriptions.ts`), and
// the revocation hook that authorizes them again when access changes
// (`streamRevocation.ts`), all over one index.

import type { Hub } from "../emit/hub";
import type { RevocationHook } from "../emit/revocation";
import type { StreamSeeds } from "./seeds";
import { StreamIndex } from "./streamIndex";
import { createStreamRevocation } from "./streamRevocation";
import { streamSubscriptions } from "./streamSubscriptions";

/** One dispatcher's stream feeds. */
export interface StreamFeeds {
  /** Serves `qd:stream:sub` and `qd:stream:unsub` on a v5 socket. */
  readonly extension: ReturnType<typeof streamSubscriptions>;
  /** Authorizes the feeds an access change or a changed grant concerns again. */
  readonly revocation: RevocationHook;
}

/** Creates the feeds of the dispatcher whose hub this is, over its streams' seeds. */
export function createStreamFeeds(hub: Hub, seeds: StreamSeeds): StreamFeeds {
  const index = new StreamIndex();
  return Object.freeze({
    extension: streamSubscriptions(hub, seeds, index),
    revocation: createStreamRevocation(hub, index),
  });
}
