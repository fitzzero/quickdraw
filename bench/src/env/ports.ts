import { createServer } from "node:net";

/** Fail early, and clearly, when another process already holds a port the run needs. */
export async function assertPortFree(port: number, host: string, purpose: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `port ${port} (${purpose}) is already in use; pick another with the matching --*-port option`
            : `cannot check port ${port} (${purpose}): ${error.message}`,
        ),
      );
    });
    probe.listen(port, host, () => {
      probe.close(() => resolve());
    });
  });
}
