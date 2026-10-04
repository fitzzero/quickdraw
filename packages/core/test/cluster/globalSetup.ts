// The cluster projects' global setup: fails the run at once, saying how to
// start Valkey, when the Valkey they need does not answer. A cluster run
// without Valkey must fail rather than skip: CI's cluster job would
// otherwise pass having proved nothing.

import { closeClient, VALKEY_URL, valkeyClient } from "./valkey";

const CONNECT_TIMEOUT_MS = 5000;

export default async function checkValkey(): Promise<void> {
  const client = valkeyClient();
  try {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`no answer within ${CONNECT_TIMEOUT_MS} ms`));
      }, CONNECT_TIMEOUT_MS).unref();
    });
    await Promise.race([client.connect().then(async () => await client.ping()), timeout]);
  } catch (error) {
    throw new Error(
      `The cluster tests need Valkey at ${VALKEY_URL} (${error instanceof Error ? error.message : String(error)}). ` +
        "Start it with `docker compose -f test/cluster/docker-compose.yml up -d --wait` in packages/core, " +
        "or point QD_VALKEY_URL at another one.",
      { cause: error },
    );
  } finally {
    await closeClient(client);
  }
}
