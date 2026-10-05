# quickdraw-sunfall: stays on 3.x

On 3.9.1, two majors behind, and it looks dormant. It stays on 3.x (an
owner decision, 2026-10-04); no migration is planned.

## Size

Not counted per app by the audit of 2026-10-02. Roughly 56 methods between
quickdraw-sunfall and makiel, by subtracting the six counted apps from the
audit's total of about 1,240 (an estimate, not a count). Count it only if
it is revived.

## Staying on 3.x

1. **Is it used?** It looks dormant. Confirm whether it is deployed and who
   uses it: a dormant app nobody can reach needs nothing.
2. **If it stays reachable.** 3.9.1 carries the socket rate limiter line
   that crashes the process when a client sends an event whose name is not
   a string, and 4.1.1's fix (on the `release/4.x` branch) does not reach
   3.x. Backport that guard, or take it down.

## If it is revived

Count it, then cross 4.0 with the 3.x to 4.0 guide (`UPGRADE-PROMPT.md` on
`release/4.x`), then 4.x to 5.0 with the codemod and the steps every app
follows ([`README.md`](README.md)), last of all the apps.
