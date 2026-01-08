"use client";

import * as React from "react";

export type CommitMode = "change" | "blur" | "debounce";

export interface UseSocketInputOptions<TEntry, TAllowedUpdate, TKey extends keyof TAllowedUpdate> {
  /**
   * Current state of the entity
   */
  state: TEntry | null;
  /**
   * Property key to update
   */
  property: TKey;
  /**
   * Update function that sends the patch to the server
   */
  update: (patch: Partial<TAllowedUpdate>) => Promise<TEntry | undefined | null>;
  /**
   * When to commit changes to the server
   * - "change": immediately on every change
   * - "blur": when input loses focus
   * - "debounce": after debounceMs of inactivity
   */
  commitMode: CommitMode;
  /**
   * Debounce delay in milliseconds (only used when commitMode is "debounce")
   */
  debounceMs?: number;
  /**
   * Format the value from state for display
   */
  format?: (value: unknown) => unknown;
  /**
   * Parse the display value back to the state format
   */
  parse?: (value: unknown) => unknown;
  /**
   * Callback on successful update
   */
  onSuccess?: (entry: TEntry | undefined | null) => void;
  /**
   * Callback on error
   */
  onError?: (error: string) => void;
}

export interface UseSocketInputResult<T> {
  /**
   * Current local value (may differ from server while editing)
   */
  value: T;
  /**
   * Update the local value
   */
  onLocalChange: (newValue: T) => void;
  /**
   * Manually commit the current value to the server
   */
  commit: () => void;
  /**
   * Handle blur event (commits if commitMode is "blur")
   */
  onBlur: () => void;
  /**
   * Whether an update is currently in flight
   */
  inFlight: boolean;
  /**
   * Whether the local value differs from the server value
   */
  isDirty: boolean;
}

/**
 * Hook for managing input state that syncs with the server.
 * Handles optimistic updates, debouncing, and conflict resolution.
 */
export function useSocketInput<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
>(
  options: UseSocketInputOptions<TEntry, TAllowedUpdate, TKey>
): UseSocketInputResult<unknown> {
  const {
    state,
    property,
    update,
    commitMode,
    debounceMs = 300,
    format = (v) => v,
    parse = (v) => v,
    onSuccess,
    onError,
  } = options;

  // Get server value
  const serverValue = state ? (state as Record<string, unknown>)[property as string] : undefined;
  const formattedServerValue = format(serverValue);

  // Local state
  const [localValue, setLocalValue] = React.useState<unknown>(formattedServerValue);
  const [inFlight, setInFlight] = React.useState(false);
  const [isDirty, setIsDirty] = React.useState(false);

  // Refs for debouncing
  const debounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingValueRef = React.useRef<unknown>(null);

  // Sync local value with server when server value changes (and we're not dirty)
  React.useEffect(() => {
    if (!isDirty && !inFlight) {
      setLocalValue(formattedServerValue);
    }
  }, [formattedServerValue, isDirty, inFlight]);

  // Commit function
  const commit = React.useCallback(async () => {
    if (!isDirty) return;

    const valueToCommit = pendingValueRef.current ?? localValue;
    const parsedValue = parse(valueToCommit);

    setInFlight(true);

    try {
      const result = await update({ [property]: parsedValue } as Partial<TAllowedUpdate>);
      setIsDirty(false);
      pendingValueRef.current = null;
      onSuccess?.(result);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Update failed");
      // Revert to server value on error
      setLocalValue(formattedServerValue);
      setIsDirty(false);
    } finally {
      setInFlight(false);
    }
  }, [isDirty, localValue, parse, property, update, onSuccess, onError, formattedServerValue]);

  // Handle local change
  const onLocalChange = React.useCallback(
    (newValue: unknown) => {
      setLocalValue(newValue);
      setIsDirty(true);
      pendingValueRef.current = newValue;

      if (commitMode === "change") {
        // Commit immediately
        void (async () => {
          const parsedValue = parse(newValue);
          setInFlight(true);
          try {
            const result = await update({ [property]: parsedValue } as Partial<TAllowedUpdate>);
            setIsDirty(false);
            pendingValueRef.current = null;
            onSuccess?.(result);
          } catch (err) {
            onError?.(err instanceof Error ? err.message : "Update failed");
          } finally {
            setInFlight(false);
          }
        })();
      } else if (commitMode === "debounce") {
        // Clear existing timer
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        // Set new timer
        debounceTimerRef.current = setTimeout(() => {
          void commit();
        }, debounceMs);
      }
      // For "blur" mode, we just update local state and wait for blur
    },
    [commitMode, parse, property, update, onSuccess, onError, debounceMs, commit]
  );

  // Handle blur
  const onBlur = React.useCallback(() => {
    if (commitMode === "blur" && isDirty) {
      void commit();
    }
  }, [commitMode, isDirty, commit]);

  // Cleanup debounce timer
  React.useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return {
    value: localValue,
    onLocalChange,
    commit,
    onBlur,
    inFlight,
    isDirty,
  };
}
