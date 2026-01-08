"use client";

import * as React from "react";
import { useSocketInput, type CommitMode } from "./useSocketInput";

export interface SocketSliderProps<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
> extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "onError" | "property"> {
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
 * A range slider input that syncs its value with the server via socket.
 *
 * @example
 * ```tsx
 * <SocketSlider
 *   state={settings}
 *   update={(patch) => updateSettings.mutateAsync({ id: settings.id, ...patch })}
 *   property="volume"
 *   min={0}
 *   max={100}
 *   commitMode="debounce"
 *   debounceMs={200}
 * />
 * ```
 */
export function SocketSlider<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
>(props: SocketSliderProps<TEntry, TAllowedUpdate, TKey>): React.ReactElement {
  const {
    state,
    update,
    property,
    commitMode = "debounce",
    debounceMs = 200,
    format,
    parse,
    onSuccess,
    onError,
    disabled,
    ...inputProps
  } = props;

  const defaultFormat = React.useCallback((v: unknown) => Number(v ?? 0), []);
  const defaultParse = React.useCallback((v: unknown) => Number(v), []);

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
      onLocalChange(Number(event.target.value));
    },
    [onLocalChange]
  );

  return (
    <input
      {...inputProps}
      type="range"
      value={Number(value)}
      onChange={handleChange}
      disabled={Boolean(disabled) || inFlight}
    />
  );
}
