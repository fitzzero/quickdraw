"use client";

import * as React from "react";
import { useSocketInput, type CommitMode } from "./useSocketInput";

export interface SocketSelectProps<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
> extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "onError" | "property"> {
  state: TEntry | null;
  update: (patch: Partial<TAllowedUpdate>) => Promise<TEntry | undefined | null>;
  property: TKey;
  children: React.ReactNode;
  commitMode?: CommitMode;
  debounceMs?: number;
  format?: (v: unknown) => unknown;
  parse?: (v: unknown) => unknown;
  onSuccess?: (entry: TEntry | undefined | null) => void;
  onError?: (error: string) => void;
}

/**
 * A select input that syncs its value with the server via socket.
 *
 * @example
 * ```tsx
 * <SocketSelect
 *   state={chat}
 *   update={(patch) => updateChat.mutateAsync({ id: chat.id, ...patch })}
 *   property="status"
 *   commitMode="change"
 * >
 *   <option value="active">Active</option>
 *   <option value="archived">Archived</option>
 * </SocketSelect>
 * ```
 */
export function SocketSelect<
  TEntry,
  TAllowedUpdate,
  TKey extends keyof TAllowedUpdate,
>(props: SocketSelectProps<TEntry, TAllowedUpdate, TKey>): React.ReactElement {
  const {
    state,
    update,
    property,
    children,
    commitMode = "change",
    debounceMs,
    format,
    parse,
    onSuccess,
    onError,
    disabled,
    ...selectProps
  } = props;

  const defaultFormat = React.useCallback((v: unknown) => String(v ?? ""), []);
  const defaultParse = React.useCallback((v: unknown) => String(v), []);

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
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onLocalChange(event.target.value);
    },
    [onLocalChange]
  );

  return (
    <select
      {...selectProps}
      value={String(value)}
      onChange={handleChange}
      disabled={Boolean(disabled) || inFlight}
    >
      {children}
    </select>
  );
}
