# makiel: stays on 3.x

On 3.7, two majors behind: mostly streams and RPC, with no real entities.
It stays on 3.x (an owner decision, 2026-10-04); no migration is planned.

## Size

Not counted per app by the audit of 2026-10-02. Roughly 56 methods between
makiel and quickdraw-sunfall, by subtracting the six counted apps from the
audit's total of about 1,240 (an estimate, not a count).

## Staying on 3.x

1. **The socket rate limiter crash.** 3.7 carries the line that crashes
   the process when a client sends an event whose name is not a string.
   4.1.1's fix (on the `release/4.x` branch, `src/server/rateLimit.ts`: such
   an event passes the limiter uncounted) does not reach 3.x, so a
   reachable makiel needs its own backport of that guard.
2. **No more fixes.** quickdraw publishes no more 3.x releases; makiel
   keeps the 3.x it has, with its own copy of anything it patches.

## If that changes

Decide with a count first. The codemod reads 4.x code only, so the choice
is crossing 4.0 first (the 3.x to 4.0 guide is `UPGRADE-PROMPT.md` on
`release/4.x`) or a hand port straight onto 5.0 contracts, likely cheaper
for an app with no real entities. 5.0 suits its shape: an RPC service is a
contract without an entity (`"public"`, `"authenticated"`, `{ service }` or
`custom` access), and a stream is declared in the contract (`item`, `scope`,
`seed`, `volatile`, `access`) with a seed the service can compute for each
subscriber from the current state, so a late subscriber behind several
instances no longer depends on what its own node pushed.
