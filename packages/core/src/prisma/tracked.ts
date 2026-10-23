// The tracked client's type (RFC 0003 section 5.2). `trackPrisma` returns
// `Tracked<C>`: the client's own type `C` with a mark only a tracked client
// carries, so a helper that writes can ask for one (`db: Tracked<Db>`) and
// the compiler refuses the untracked client there. The mark is a type, with
// no property at run time, and the root export names it too, so a shared
// package can type a helper without importing Prisma.
//
// `C` keeps every member as it is: the mark is an intersection, never a
// mapped type over the client, which would slow the compiler on Prisma's
// large client types and lose what `$extends` inferred. The one member
// declared again is the interactive `$transaction`, whose `tx` is tracked
// too (`TrackedTransaction<C>`). It comes before `C` in the intersection, so
// a call resolves to it before Prisma's own form; the array form is `C`'s.
// The mark comes first, so the compiler's error for the untracked client
// names what it lacks (`[TRACKED]`) rather than `$transaction`.
//
// The patterns below infer the callback's client. One whose callback takes
// `never` (`(tx: never) => unknown`) matches no Prisma client, under tsgo
// and tsc alike: a callback's parameter is compared contravariantly, so the
// pattern's must accept Prisma's transaction client, which `never` does not.

declare const TRACKED: unique symbol;

/** What marks a client as tracked: a type only, with no property at run time. */
export interface TrackedMark {
  readonly [TRACKED]: true;
}

/** The client an interactive `$transaction` of `C` passes its callback, or `C` itself when it has none. */
type TransactionClientOf<C> = C extends {
  $transaction(fn: (tx: infer Tx) => unknown, options?: unknown): unknown;
}
  ? Tx
  : C;

/** The interactive `$transaction` of a tracked `C`: its callback gets the tracked transaction client. */
interface TrackedInteractiveTransaction<C, Options> {
  $transaction<R>(fn: (tx: TrackedTransaction<C>) => Promise<R>, options?: Options): Promise<R>;
}

/** `$transaction` declared again, with Prisma's options, for a `C` that has an interactive one; nothing for one that has none. */
type TrackedTransactions<C> = C extends {
  $transaction(fn: (tx: infer _Tx) => unknown, options?: infer Options): unknown;
}
  ? TrackedInteractiveTransaction<C, Options>
  : unknown;

/**
 * A database client whose writes the framework sees: what `trackPrisma`
 * returns. It is still a `C` everywhere a `C` is asked for, but a plain `C`
 * is not a `Tracked<C>`, so a helper that writes takes `db: Tracked<Db>`
 * and the untracked client passed to it is a type error. Its interactive
 * `$transaction` passes a {@link TrackedTransaction}; the array form is
 * Prisma's own.
 *
 * @example
 * export const db = trackPrisma(new PrismaClient({ adapter })); // Tracked<PrismaClient>
 * export async function archive(client: Tracked<PrismaClient>, id: string): Promise<void> {
 *   await client.project.update({ where: { id }, data: { archived: true } });
 * }
 * await qd.run(() => archive(db, projectId)); // archive(prisma, projectId) is a type error
 */
export type Tracked<C> = TrackedMark & TrackedTransactions<C> & C;

/**
 * The client an interactive `db.$transaction(async (tx) => ...)` of a
 * tracked `db` passes as `tx`, tracked too: Prisma's transaction client of
 * `C`. `C` is the client, tracked or not; a transaction client stays itself.
 * A helper that writes inside or outside a transaction takes
 * `TrackedTransaction<Db>`, which both `db` and `tx` are.
 */
export type TrackedTransaction<C> = Tracked<TransactionClientOf<C>>;
