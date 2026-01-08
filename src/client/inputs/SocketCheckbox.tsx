"use client";

import * as React from "react";
import { useSocketInput, type CommitMode } from "./useSocketInput";

export interface SocketCheckboxProps<
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
 * A checkbox input that syncs its checked state with the server via socket.
 *
 * @example
 * ```tsx
 * <SocketCheckbox
 *   state={chat}
 *   update={(patch) => updateChat.mutateAsync({ id: chat.id, ...patch })}
 *   property="isArchived"
 *   commitMode="change"
 * />
 * ```
 */
export function SocketCheckbox<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
>(props: SocketCheckboxProps<TEntry, TAllowedUpdate, TKey>): React.ReactElement {
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

  return (
    <input
      {...inputProps}
      type="checkbox"
      checked={Boolean(value)}
      onChange={handleChange}
      disabled={Boolean(disabled) || inFlight}
    />
  );
}
