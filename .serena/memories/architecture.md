# @fitzzero/quickdraw-core Architecture

## Overview

quickdraw-core is an npm package providing fast fullstack patterns for real-time applications with Socket.io and TanStack Query.

## Package Structure

```
src/
├── shared/           # Shared types (exported from root)
│   ├── index.ts      # Re-exports types
│   └── types.ts      # AccessLevel, ACL, ServiceResponse, etc.
├── server/           # Server-side code (@fitzzero/quickdraw-core/server)
│   ├── index.ts      # Main exports
│   ├── BaseService.ts
│   ├── ServiceRegistry.ts
│   ├── createServer.ts
│   ├── types.ts
│   ├── testing.ts    # Test utilities
│   └── auth/         # OAuth and JWT utilities
│       ├── index.ts
│       ├── jwt.ts
│       ├── oauth.ts
│       ├── discord.ts
│       └── google.ts
└── client/           # Client-side code (@fitzzero/quickdraw-core/client)
    ├── index.ts      # Main exports
    ├── QuickdrawProvider.tsx
    ├── useService.ts
    ├── useSubscription.ts
    ├── types.ts
    ├── testing.tsx   # Test utilities
    └── inputs/       # Socket-synced form components
        ├── index.ts
        ├── useSocketInput.ts
        ├── SocketTextField.tsx
        ├── SocketCheckbox.tsx
        ├── SocketSelect.tsx
        ├── SocketSlider.tsx
        └── SocketSwitch.tsx
```

## Export Paths

| Import Path | Contents |
|-------------|----------|
| `@fitzzero/quickdraw-core` | Shared types (AccessLevel, ServiceResponse, etc.) |
| `@fitzzero/quickdraw-core/server` | BaseService, ServiceRegistry, createQuickdrawServer, auth utilities |
| `@fitzzero/quickdraw-core/client` | QuickdrawProvider, useService, useSubscription, Socket inputs |
| `@fitzzero/quickdraw-core/server/testing` | createTestServer, connectAsUser, emitWithAck |
| `@fitzzero/quickdraw-core/client/testing` | createMockSocket, createTestWrapper |

## Peer Dependencies

The package uses peer dependencies to avoid bundling framework code:
- `react` >= 18.0.0 (optional, for client)
- `socket.io` >= 4.0.0 (optional, for server)
- `socket.io-client` >= 4.0.0 (optional, for client)
- `@tanstack/react-query` >= 5.0.0 (optional, for client)
- `@prisma/client` >= 5.0.0 (optional, for server with Prisma)

## Build Output

Built with tsup to `dist/` with:
- ESM modules (.js)
- TypeScript declarations (.d.ts)
- Source maps (.js.map)
