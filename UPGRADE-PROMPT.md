# Upgrade to quickdraw-core 1.2.0

Upgrade to the latest quickdraw-core version and refactor to use the new patterns:

```bash
pnpm update @fitzzero/quickdraw-core@^1.2.0
```

## Key Changes in 1.2.0

1. **NEW: `useServiceQuery` hook** - Use for READ operations (get, list, search). Provides automatic caching, request deduplication, and stale time management.

2. **FIXED: `useService` memoization** - The return object is now stable. You can remove `useRef` workarounds for the mutate function.

## Migration Steps

### 1. Replace read operations

Change `useService` to `useServiceQuery` for any read-only methods:

**BEFORE (mutation-style for reads):**

```typescript
const listExpenses = useService("expenseService", "listExpenses", { onSuccess: setExpenses });
const listExpensesMutateRef = useRef(listExpenses.mutate);
listExpensesMutateRef.current = listExpenses.mutate;
const loadExpenses = useCallback(() => { listExpensesMutateRef.current({ pageSize: 100 }); }, []);
useEffect(() => { if (userId) loadExpenses(); }, [userId, loadExpenses]);
```

**AFTER (query-style for reads):**

```typescript
const { data: expenses, isLoading, refetch } = useServiceQuery(
  "expenseService", "listExpenses",
  { pageSize: 100, ...filters },
  { enabled: !!userId }
);
```

### 2. Keep `useService` for mutations

Create, update, delete operations stay as-is:

```typescript
const createExpense = useService("expenseService", "createExpense", { onSuccess: ... });
const updateExpense = useService("expenseService", "updateExpense", { onSuccess: ... });
createExpense.mutate({ ... });
```

### 3. Remove `useRef` workarounds

The memoization fix means you no longer need ref-based workarounds:

```typescript
// BEFORE (workaround) - DELETE THESE LINES
const listExpensesMutateRef = useRef(listExpenses.mutate);
listExpensesMutateRef.current = listExpenses.mutate;

// AFTER - not needed anymore
```

### 4. Update type imports if using them

```typescript
import { 
  useServiceQuery,
  type UseServiceQueryOptions,
  type UseServiceQueryResult 
} from "@fitzzero/quickdraw-core/client";
```

## `useServiceQuery` API Reference

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Auto-fetch on mount |
| `staleTime` | 5 min | How long data stays fresh |
| `gcTime` | 10 min | Cache retention for unused data |
| `skipCache` | `false` | Force fresh fetch, bypass cache |
| `onSuccess` | - | Success callback |
| `onError` | - | Error callback |

### Returns

| Property | Description |
|----------|-------------|
| `data` | The cached/fetched data |
| `isLoading` | Initial load in progress |
| `isFetching` | Any fetch in progress (including background) |
| `isStale` | Data is past staleTime |
| `isSuccess` | Query has succeeded |
| `isError` | Query has errored |
| `error` | Error message if failed |
| `refetch()` | Manual refetch function |

## When to use which hook

| Operation | Hook | Examples |
|-----------|------|----------|
| Read | `useServiceQuery` | `listExpenses`, `getUser`, `search`, `findById` |
| Write | `useService` | `createExpense`, `updateUser`, `delete`, `bulkUpdate` |

## Update Serena Memories

Update any `client-patterns` or `quickdraw-core` memory files to reflect:

1. Remove the "useService Stability Warning" section about infinite loops
2. Add documentation for `useServiceQuery` as the preferred hook for read operations
3. Document that `useService` is now stable (memoized) and workarounds are no longer needed
