"use client";

import * as React from "react";
import { useSocketInput, type CommitMode } from "./useSocketInput";

export interface SocketSwitchProps<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
> extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "checked" | "onChange" | "type" | "onError" | "property"> {
  state: TEntry | null;
  update: (patch: Partial<TAllowedUpdate>) => Promise<TEntry | undefined | null>;
  property: TKey;
  commitMode?: CommitMode;
  debounceMs?: number;
  format?: (v: unknown) => unknown;
  parse?: (v: unknown) => unknown;
  onSuccess?: (entry: TEntry | undefined | null) => void;
  onError?: (error: string) => void;
}

/**
 * A switch/toggle input that syncs its state with the server via socket.
 * Styled as a switch by default using CSS.
 *
 * @example
 * ```tsx
 * <SocketSwitch
 *   state={settings}
 *   update={(patch) => updateSettings.mutateAsync({ id: settings.id, ...patch })}
 *   property="darkMode"
 *   commitMode="change"
 * />
 * ```
 */
export function SocketSwitch<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
>(props: SocketSwitchProps<TEntry, TAllowedUpdate, TKey>): React.ReactElement {
  const {
    state,
    update,
    property,
    commitMode = "change",
    debounceMs,
    format,
    parse,
    onSuccess,
    onError,
    disabled,
    className,
    ...inputProps
  } = props;

  const defaultFormat = React.useCallback((v: unknown) => Boolean(v), []);
  const defaultParse = React.useCallback((v: unknown) => Boolean(v), []);

  const { value, onLocalChange, inFlight } = useSocketInput<TEntry, TAllowedUpdate, TKey>({
    state,
    property,
    update,
    commitMode,
    debounceMs,
    format: format ?? defaultFormat,
    parse: parse ?? defaultParse,
    onSuccess,
    onError,
  });

  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onLocalChange(event.target.checked);
    },
    [onLocalChange]
  );

  // Role="switch" for accessibility
  return (
    <input
      {...inputProps}
      type="checkbox"
      role="switch"
      aria-checked={Boolean(value)}
      checked={Boolean(value)}
      onChange={handleChange}
      disabled={Boolean(disabled) || inFlight}
      className={className}
    />
  );
}
