// Preloaded into the app server only when the runner profiles it (--cpu-prof).
// Node writes a --cpu-prof profile when the process exits normally, which the
// default action of SIGTERM (how the runner stops a server) skips; exiting from
// the handler writes it. The app itself is not changed.
process.once("SIGTERM", () => {
  process.exit(0);
});
