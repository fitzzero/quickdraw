// When the development sign-ins run: `socketAuth`'s `devCredentials` (a
// socket handshake that names a user id) and the mock OAuth provider (any
// user it lists). Both sign anyone who reaches them in as anyone, so they
// run only when NODE_ENV says development or test: an allowlist, not the
// `!== "production"` denylist of 5.0, under which an unset NODE_ENV,
// `"prod"` or `"staging"` let them through (the 5.1 audit's AUTH-3).

/** The NODE_ENV values under which development sign-ins run. */
const DEVELOPMENT_ENVS: ReadonlySet<string> = new Set(["development", "test"]);

/** True only when NODE_ENV is `development` or `test`. */
export function developmentSignInsAllowed(): boolean {
  const env = process.env.NODE_ENV;
  return env !== undefined && DEVELOPMENT_ENVS.has(env);
}

/** NODE_ENV for a message: `unset`, or its value quoted. */
export function nodeEnvLabel(): string {
  const env = process.env.NODE_ENV;
  return env === undefined ? "unset" : JSON.stringify(env);
}
