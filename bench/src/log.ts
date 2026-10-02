/** Progress lines on stderr, so stdout stays clean. */
export function log(message: string): void {
  process.stderr.write(`[bench ${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}
