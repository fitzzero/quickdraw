import { describe, it, expect, afterAll, beforeAll } from "vitest";
import type { AccessLevel } from "../shared/types";
import { BaseService } from "./BaseService";
import type { QuickdrawSocket, PrismaDelegate, BaseServiceInstance } from "./types";
import { createTestServer, type TestServer, type TestClient, waitForEvent } from "./testing";

interface Profile {
  id: string;
  name: string;
  email: string;
}

type ProfileCreate = Record<string, unknown>;
type ProfileUpdate = Record<string, unknown>;

const store = new Map<string, Profile>();
let findUniqueCalls = 0;

const delegate: PrismaDelegate<Profile, ProfileCreate, ProfileUpdate> = {
  findUnique: async (args) => {
    findUniqueCalls++;
    return store.get((args.where as { id: string }).id) ?? null;
  },
  findMany: async () => Array.from(store.values()),
  create: async (args) => {
    const entity = args.data as unknown as Profile;
    store.set(entity.id, entity);
    return entity;
  },
  update: async (args) => {
    const id = (args.where as { id: string }).id;
    const existing = store.get(id);
    if (!existing) throw new Error("Record not found");
    const updated = { ...existing, ...(args.data as Partial<Profile>) };
    store.set(id, updated);
    return updated;
  },
  delete: async (args) => {
    const id = (args.where as { id: string }).id;
    const existing = store.get(id);
    if (!existing) throw new Error("Record not found");
    store.delete(id);
    return existing;
  },
  count: async () => store.size,
};

type NoMethods = Record<string, never>;

/** Plain service: no hooks, no collections — writes must skip the before-fetch. */
class PlainProfileService extends BaseService<Profile, ProfileCreate, ProfileUpdate, NoMethods> {
  constructor() {
    super({ serviceName: "profileService", hasEntryACL: false });
    this.setDelegate(delegate);
  }

  protected override checkAccess(
    _userId: string,
    _entryId: string,
    _requiredLevel: AccessLevel,
    _socket: QuickdrawSocket,
  ): boolean {
    return true;
  }

  public createProfile(data: ProfileCreate): Promise<Profile> {
    return this.create(data);
  }

  public updateProfile(id: string, data: ProfileUpdate): Promise<Profile | null> {
    return this.update(id, data);
  }

  public deleteProfile(id: string): Promise<boolean> {
    return this.delete(id);
  }
}

/** Hooked service: records every lifecycle call. */
class HookedService extends BaseService<Profile, ProfileCreate, ProfileUpdate, NoMethods> {
  public calls: Array<{ hook: string; args: unknown[] }> = [];
  public vetoDelete = false;

  constructor() {
    super({ serviceName: "hookedService", hasEntryACL: false });
    this.setDelegate(delegate);
  }

  protected override async beforeCreate(data: ProfileCreate): Promise<ProfileCreate> {
    this.calls.push({ hook: "beforeCreate", args: [data] });
    return { ...data, name: `${data.name as string} (hooked)` };
  }

  protected override async afterCreate(entity: Profile): Promise<void> {
    this.calls.push({ hook: "afterCreate", args: [entity] });
  }

  protected override async beforeUpdate(
    id: string,
    data: ProfileUpdate,
    before: Profile | null,
  ): Promise<ProfileUpdate> {
    this.calls.push({ hook: "beforeUpdate", args: [id, data, before] });
    return data;
  }

  protected override async afterUpdate(before: Profile | null, after: Profile): Promise<void> {
    this.calls.push({ hook: "afterUpdate", args: [before, after] });
  }

  protected override async beforeDelete(before: Profile): Promise<void> {
    this.calls.push({ hook: "beforeDelete", args: [before] });
    if (this.vetoDelete) throw new Error("vetoed");
  }

  protected override async afterDelete(before: Profile): Promise<void> {
    this.calls.push({ hook: "afterDelete", args: [before] });
  }

  public createProfile(data: ProfileCreate): Promise<Profile> {
    return this.create(data);
  }

  public updateProfile(id: string, data: ProfileUpdate): Promise<Profile | null> {
    return this.update(id, data);
  }

  public deleteProfile(id: string): Promise<boolean> {
    return this.delete(id);
  }

  public hookNames(): string[] {
    return this.calls.map((c) => c.hook);
  }
}

describe("write lifecycle hooks", () => {
  const service = new HookedService();
  const plain = new PlainProfileService();

  it("beforeCreate can transform input; afterCreate sees the committed row", async () => {
    service.calls = [];
    const created = await service.createProfile({
      id: "p-1",
      name: "Ada",
      email: "ada@example.com",
    });

    expect(created.name).toBe("Ada (hooked)");
    expect(service.hookNames()).toEqual(["beforeCreate", "afterCreate"]);
    expect((service.calls[1]!.args[0] as Profile).name).toBe("Ada (hooked)");
  });

  it("beforeUpdate/afterUpdate receive the pre-write row", async () => {
    service.calls = [];
    const updated = await service.updateProfile("p-1", { name: "Ada L." });

    expect(updated?.name).toBe("Ada L.");
    expect(service.hookNames()).toEqual(["beforeUpdate", "afterUpdate"]);
    const [, , before] = service.calls[0]!.args as [string, ProfileUpdate, Profile];
    expect(before.name).toBe("Ada (hooked)");
    const [afterBefore, after] = service.calls[1]!.args as [Profile, Profile];
    expect(afterBefore.name).toBe("Ada (hooked)");
    expect(after.name).toBe("Ada L.");
  });

  it("does not run after hooks when the write fails", async () => {
    service.calls = [];
    const result = await service.updateProfile("missing", { name: "x" });

    expect(result).toBeNull();
    expect(service.hookNames()).toEqual(["beforeUpdate"]);
  });

  it("beforeDelete can veto the delete by throwing", async () => {
    service.calls = [];
    service.vetoDelete = true;
    const deleted = await service.deleteProfile("p-1");
    service.vetoDelete = false;

    expect(deleted).toBe(false);
    expect(store.has("p-1")).toBe(true);
    expect(service.hookNames()).toEqual(["beforeDelete"]);
  });

  it("delete fetches the row and hands it to beforeDelete/afterDelete", async () => {
    service.calls = [];
    const deleted = await service.deleteProfile("p-1");

    expect(deleted).toBe(true);
    expect(service.hookNames()).toEqual(["beforeDelete", "afterDelete"]);
    expect((service.calls[1]!.args[0] as Profile).id).toBe("p-1");
  });

  it("skips the before-fetch entirely for services with no hooks or collections", async () => {
    await plain.createProfile({ id: "p-2", name: "Grace", email: "grace@example.com" });

    findUniqueCalls = 0;
    await plain.updateProfile("p-2", { name: "Grace H." });
    expect(findUniqueCalls).toBe(0);

    findUniqueCalls = 0;
    await plain.deleteProfile("p-2");
    expect(findUniqueCalls).toBe(0);
  });
});

describe("room-based emitUpdate (two-tier)", () => {
  let server: TestServer;
  let owner: TestClient;
  let viewer: TestClient;
  const service = new PlainProfileService();

  beforeAll(async () => {
    store.set("user-owner", {
      id: "user-owner",
      name: "Owner",
      email: "owner@example.com",
    });

    server = await createTestServer({
      services: { profileService: service as unknown as BaseServiceInstance },
    });

    // Default hasElevatedAccess: socket.userId === entryId — the owner
    // subscribes to their own profile, the viewer to someone else's.
    owner = await server.connectAs("user-owner");
    viewer = await server.connectAs("user-viewer");
  });

  afterAll(async () => {
    owner?.close();
    viewer?.close();
    if (server) await server.stop();
  });

  it("subscribe returns filtered data per tier", async () => {
    const ownerView = await owner.emit<{ entryId: string }, Profile>("profileService:subscribe", {
      entryId: "user-owner",
    });
    const viewerView = await viewer.emit<{ entryId: string }, Profile>("profileService:subscribe", {
      entryId: "user-owner",
    });

    expect(ownerView.email).toBe("owner@example.com");
    expect(viewerView.email).toBeUndefined();
    expect(viewerView.name).toBe("Owner");
  });

  it("emitUpdate sends full data to elevated subscribers, stripped to others", async () => {
    const eventName = "profileService:update:user-owner";
    const ownerUpdate = waitForEvent<Partial<Profile>>(owner.socket, eventName);
    const viewerUpdate = waitForEvent<Partial<Profile>>(viewer.socket, eventName);

    await service.updateProfile("user-owner", {
      name: "Owner Prime",
      email: "prime@example.com",
    });

    const [ownerPayload, viewerPayload] = await Promise.all([ownerUpdate, viewerUpdate]);

    expect(ownerPayload.name).toBe("Owner Prime");
    expect(ownerPayload.email).toBe("prime@example.com");
    expect(viewerPayload.name).toBe("Owner Prime");
    expect(viewerPayload.email).toBeUndefined();
  });

  it("elevated subscribers receive exactly one emit (not one per tier room)", async () => {
    const eventName = "profileService:update:user-owner";
    let received = 0;
    const handler = () => {
      received++;
    };
    owner.socket.on(eventName, handler);

    await service.updateProfile("user-owner", { name: "Once" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    owner.socket.off(eventName, handler);
    expect(received).toBe(1);
  });

  it("unsubscribe stops updates for both tiers", async () => {
    await owner.emit("profileService:unsubscribe", { entryId: "user-owner" });

    const eventName = "profileService:update:user-owner";
    let received = 0;
    const handler = () => {
      received++;
    };
    owner.socket.on(eventName, handler);

    await service.updateProfile("user-owner", { name: "Silent" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    owner.socket.off(eventName, handler);
    expect(received).toBe(0);
  });
});
