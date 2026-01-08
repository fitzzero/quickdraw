"use client";

import * as React from "react";
import { useSocketInput, type CommitMode } from "./useSocketInput";

export interface SocketTextFieldProps<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
> extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onError" | "property"> {
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
 * A text input that syncs its value with the server via socket.
 *
 * @example
 * ```tsx
 * <SocketTextField
 *   state={chat}
 *   update={(patch) => updateChat.mutateAsync({ id: chat.id, ...patch })}
 *   property="title"
 *   commitMode="debounce"
 *   debounceMs={500}
 *   placeholder="Chat title..."
 * />
 * ```
 */
export function SocketTextField<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
>(props: SocketTextFieldProps<TEntry, TAllowedUpdate, TKey>): React.ReactElement {
  const {
    state,
    update,
    property,
    commitMode = "blur",
    debounceMs = 300,
    format,
    parse,
    onSuccess,
    onError,
    disabled,
    ...inputProps
  } = props;

  const defaultFormat = React.useCallback((v: unknown) => String(v ?? ""), []);
  const defaultParse = React.useCallback((v: unknown) => String(v), []);

  const { value, onLocalChange, onBlur, inFlight } = useSocketInput<
    TEntry,
    TAllowedUpdate,
    TKey
  >({
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
      onLocalChange(event.target.value);
    },
    [onLocalChange]
  );

  return (
    <input
      {...inputProps}
      type="text"
      value={String(value)}
      onChange={handleChange}
      onBlur={onBlur}
      disabled={Boolean(disabled) || inFlight}
    />
  );
}
