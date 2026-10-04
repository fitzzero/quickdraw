# quickdraw-sunfall: upgrade brief

On 3.9.1, two majors behind, and it looks dormant. Decide first whether it
migrates at all or stays on 3.x; either way it goes after the 4.x apps.

## Size

Not counted per app by the audit of 2026-10-02. Roughly 56 methods between
quickdraw-sunfall and makiel, by subtracting the six counted apps from the
audit's total of about 1,240 (an estimate, not a count). Count it only if
it is revived.

## Top hazards

1. **Is it used?** It looks dormant. Confirm whether it is deployed and who
   uses it before spending anything on it.
2. **Two majors to cross.** The codemod reads 4.x code only. Crossing 4.0
   first follows the 3.x to 4.0 guide, `UPGRADE-PROMPT.md` on `main`
   (4.1.0); on `dev` that file is now the 5.0 prompt. Then the 4.x to 5.0
   migration with the codemod, as for the other apps.
3. **Staying on 3.x while deployed.** 3.9.1 carries the socket rate limiter
   line that crashes the process on a non-string event name; the 4.1.1
   hotfix does not reach 3.x. A deployed, reachable sunfall needs its own
   backport of that guard, or to be taken down.

## Suggested order

1. Decide: retire it, leave it on 3.9.1 (backporting the rate limiter
   guard if it stays reachable), or migrate it.
2. If it migrates: 3.x to 4.0 with the 4.0 guide, then 4.x to 5.0 with the
   codemod and the steps every app follows
   ([`README.md`](README.md)), last of all the apps.
