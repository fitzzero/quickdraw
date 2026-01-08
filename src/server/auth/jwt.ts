import * as jose from "jose";

export interface JWTPayload {
  userId: string;
  email?: string;
  exp?: number;
  iat?: number;
}

const DEFAULT_EXPIRATION = "7d";

/**
 * Create a JWT token for authentication.
 *
 * @param payload - The payload to encode in the JWT
 * @param secret - The secret key for signing
 * @param expiresIn - Expiration time (default: 7 days)
 */
export async function createJWT(
  payload: Omit<JWTPayload, "exp" | "iat">,
  secret: string,
  expiresIn: string = DEFAULT_EXPIRATION
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);

  const jwt = await new jose.SignJWT(payload as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey);

  return jwt;
}

/**
 * Verify and decode a JWT token.
 *
 * @param token - The JWT token to verify
 * @param secret - The secret key for verification
 * @returns The decoded payload, or null if invalid
 */
export async function verifyJWT(
  token: string,
  secret: string
): Promise<JWTPayload | null> {
  try {
    const secretKey = new TextEncoder().encode(secret);
    const { payload } = await jose.jwtVerify(token, secretKey);

    return {
      userId: payload.userId as string,
      email: payload.email as string | undefined,
      exp: payload.exp,
      iat: payload.iat,
    };
  } catch {
    return null;
  }
}
