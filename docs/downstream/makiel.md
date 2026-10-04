# makiel: upgrade brief

On 3.7, two majors behind. Mostly streams and RPC, with no real entities.
Decide first whether it migrates at all or stays on 3.x; either way it
goes after the 4.x apps.

## Size

Not counted per app by the audit of 2026-10-02. Roughly 56 methods between
makiel and quickdraw-sunfall, by subtracting the six counted apps from the
audit's total of about 1,240 (an estimate, not a count). The card that
decides counts services, methods and streams first.

## Top hazards

1. **Two majors to cross.** The codemod reads 4.x code only. Crossing 4.0
   first follows the 3.x to 4.0 guide, which is `UPGRADE-PROMPT.md` on
   `main` (4.1.0); on `dev` that file is now the 5.0 prompt. For an app
   with no real entities, porting it by hand straight onto 5.0 contracts
   may cost less than two migrations: compare before choosing.
2. **Streams.** 5.0 declares each stream in the contract's `streams`
   (`item`, and optionally `scope`, `seed`, `volatile`, `access`); a
   stream without `access` is closed. The server pushes with `stream.push`
   or `pushMany`, and the client reads it with `useStream`. Seeds are kept
   per process, so behind several instances a late subscriber's seed holds
   only what its own node pushed.
3. **RPC services.** A service without rows is a contract without
   `entity`, implemented without `model`; it may use only `"public"`,
   `"authenticated"`, `{ service }` or `custom` access.
4. **Staying on 3.x.** 3.7 carries the socket rate limiter line that
   crashes the process on a non-string event name; the 4.1.1 hotfix does
   not reach 3.x, so staying means its own backport of that guard.

## Suggested order

1. Decide: migrate, or stay on 3.x with the rate limiter guard backported.
2. If it migrates: count it, compare a hand port onto 5.0 with crossing
   4.0 first, and plan from the cheaper path, after Conveyor or alongside
   it.
3. Streams and their access first, then the RPC services, then the
   client.
