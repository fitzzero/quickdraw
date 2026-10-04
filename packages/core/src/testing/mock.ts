// The mock client: @fitzzero/quickdraw-core/testing/mock (RFC 0003 section
// 13). `createMockClient(contracts)` is the typed client of the contracts
// with stubs for members and no transport, plus a provider (`$Provider`)
// whose session the real `useQuickdraw()` and `usePresence` read. This
// entry is the mock alone: it imports neither Testing Library nor any server
// code, so a browser bundle (Storybook, a design catalog) can import it as
// it is. `./testing/client` re-exports it beside `renderWithQuickdraw`,
// which loads Testing Library. No "use client" directive: it is for tests
// and stories, never for a bundle that React Server Components split.

export { createMockClient } from "./mockClient";
export type {
  EntityMock,
  MethodStub,
  MockChannelMember,
  MockClient,
  MockClientOptions,
  MockCollectionMember,
  MockEntityMembers,
  MockEventMember,
  MockMethodMember,
  MockRealtimeMembers,
  MockScope,
  MockServiceClient,
  MockSession,
  MockStreamMember,
  StreamMock,
} from "./mockTypes";
