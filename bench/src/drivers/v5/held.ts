import type { QuickdrawConnection } from "@fitzzero/quickdraw-core/client";
import type { DriverContext } from "../types";
import { openConnection, untilHello } from "./client";

/** A 5.0 connection held open the way a mounted provider holds it, ready once the hello is in. */
export class HeldConnection {
  protected readonly connection: QuickdrawConnection;
  private release: (() => void) | null = null;

  constructor(
    protected readonly ctx: DriverContext,
    token: string,
  ) {
    this.connection = openConnection(ctx, token);
  }

  public async connect(): Promise<void> {
    this.release ??= this.connection.retain();
    await untilHello(this.connection);
  }

  public close(): void {
    this.release?.();
    this.release = null;
    this.connection.close();
  }
}
