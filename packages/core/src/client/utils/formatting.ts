/**
 * Format a currency value for display.
 */
export function formatCurrency(
  value: string | number | null | undefined,
  currency = "USD",
  locale = "en-US",
): string {
  if (value == null) return "-";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "-";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(num);
}

/**
 * Format a number for display with optional decimal places.
 */
export function formatNumber(
  value: string | number | null | undefined,
  options?: Intl.NumberFormatOptions,
  locale = "en-US",
): string {
  if (value == null) return "-";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "-";
  return new Intl.NumberFormat(locale, options).format(num);
}

/**
 * Format a date for display.
 */
export function formatDate(
  value: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale = "en-US",
): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(
    locale,
    options ?? {
      year: "numeric",
      month: "short",
      day: "numeric",
    },
  );
}

/**
 * Format a date with time for display.
 */
export function formatDateTime(
  value: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale = "en-US",
): string {
  if (!value) return "-";
  const date = typeof value === "string" ? new Date(value) : value;
  if (isNaN(date.getTime())) return "-";
  return date.toLocaleString(
    locale,
    options ?? {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    },
  );
}

/**
 * Truncate a string to a maximum length.
 */
export function truncate(value: string | null | undefined, maxLength = 50): string {
  if (!value) return "-";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

/**
 * Format a percentage for display.
 */
export function formatPercent(
  value: string | number | null | undefined,
  decimals = 1,
  locale = "en-US",
): string {
  if (value == null) return "-";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "-";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num / 100);
}
