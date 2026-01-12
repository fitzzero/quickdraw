/**
 * Environment variable validation utilities.
 * Helps ensure required environment variables are set before the application starts.
 */

export interface ValidateEnvOptions {
  /**
   * List of required environment variable names.
   * Validation will fail if any of these are missing or empty.
   */
  required: string[];
  
  /**
   * Only enforce validation in production environment.
   * @default true
   */
  productionOnly?: boolean;
  
  /**
   * Custom error message prefix.
   * @default "Missing required environment variables"
   */
  errorPrefix?: string;
}

export interface EnvValidationResult {
  success: boolean;
  missing: string[];
  message?: string;
}

/**
 * Validate that required environment variables are set.
 * Throws an error if any required variables are missing.
 * 
 * @param options - Validation configuration
 * @throws {Error} If required environment variables are missing
 * 
 * @example
 * ```typescript
 * // Validate required vars on startup
 * validateEnv({
 *   required: ['JWT_SECRET', 'DATABASE_URL', 'CLIENT_URL'],
 * });
 * ```
 * 
 * @example
 * ```typescript
 * // Only validate in production
 * validateEnv({
 *   required: ['JWT_SECRET', 'DATABASE_URL'],
 *   productionOnly: true,
 * });
 * ```
 */
export function validateEnv(options: ValidateEnvOptions): void {
  const result = checkEnv(options);
  
  if (!result.success) {
    throw new Error(result.message);
  }
}

/**
 * Check environment variables without throwing.
 * Returns a result object with validation status and missing variables.
 * 
 * @param options - Validation configuration
 * @returns Validation result with missing variables list
 * 
 * @example
 * ```typescript
 * const result = checkEnv({ required: ['JWT_SECRET'] });
 * if (!result.success) {
 *   console.warn('Missing env vars:', result.missing);
 * }
 * ```
 */
export function checkEnv(options: ValidateEnvOptions): EnvValidationResult {
  const { required, productionOnly = true, errorPrefix = "Missing required environment variables" } = options;
  
  // Skip validation in development if productionOnly is true
  if (productionOnly && process.env.NODE_ENV !== 'production') {
    return { success: true, missing: [] };
  }
  
  const missing: string[] = [];
  
  for (const varName of required) {
    const value = process.env[varName];
    if (!value || value.trim() === '') {
      missing.push(varName);
    }
  }
  
  if (missing.length > 0) {
    return {
      success: false,
      missing,
      message: `${errorPrefix}: ${missing.join(', ')}`,
    };
  }
  
  return { success: true, missing: [] };
}

/**
 * Get an environment variable or throw if it's missing.
 * Useful for individual variable access with validation.
 * 
 * @param name - Environment variable name
 * @param defaultValue - Optional default value (if provided, won't throw)
 * @returns The environment variable value
 * @throws {Error} If variable is missing and no default provided
 * 
 * @example
 * ```typescript
 * const jwtSecret = requireEnv('JWT_SECRET');
 * const port = requireEnv('PORT', '4000');
 * ```
 */
export function requireEnv(name: string, defaultValue?: string): string {
  const value = process.env[name];
  
  if (!value || value.trim() === '') {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable ${name} is required but not set`);
  }
  
  return value;
}
