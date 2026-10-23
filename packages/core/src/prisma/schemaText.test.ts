// Reading a Prisma schema's text (`schemaText.ts`): which fields may hold
// null and which models have an `id` the tracker can key, by Prisma field
// name, with relation fields never taken for columns. The real client's text
// is read in `trackPrisma.test.ts`.

import { describe, expect, it } from "vitest";
import { parsePrismaSchema, prismaSchemaOf, schemaTextOf } from "./schemaText";

const SCHEMA = `
// A comment, and a doc comment below.
generator client {
  provider = "prisma-client"
}

datasource db {
  provider = "postgresql"
}

enum Role {
  ADMIN
  MEMBER // a value, not a field
}

/// A model with every kind of field.
model Task {
  id        String   @id @default(cuid())
  title     String   @map("task_title") // a mapped column keeps its field name
  notes     String?
  ordinal   Int      @default(0)
  tags      String[]
  link      String   @default("https://example.com/a//b")
  legacy    String?  @ignore
  shape     Unsupported("circle")?
  projectId String
  project   Project  @relation(fields: [projectId], references: [id])
  parent    Task?    @relation("Subtasks")
  subtasks  Task[]   @relation("Subtasks")

  @@index([projectId, ordinal])
  @@map("tasks")
}

model Project {
  id    Int    @id @default(autoincrement())
  tasks Task[]
}

// A table keyed by a composite id: nothing to key its rows by.
model VerificationToken {
  identifier String
  token      String

  @@id([identifier, token])
}

model Member {
  id   Role @id
  name String
}

model Draft {
  id   String? @unique
  body String
}

model Blob {
  id   Bytes @id
  data Bytes
}

model Hidden {
  id String @id

  @@ignore
}
`;

describe("parsePrismaSchema", () => {
  const schema = parsePrismaSchema(SCHEMA);

  it("answers whether a field may hold null: Type? may, Type and Type[] may not", () => {
    expect(schema.nullable("task", "notes")).toBe(true);
    expect(schema.nullable("task", "ordinal")).toBe(false);
    expect(schema.nullable("task", "tags")).toBe(false);
    // By Prisma field name, whatever @map names the column; a `//` in a string is not a comment.
    expect(schema.nullable("task", "title")).toBe(false);
    expect(schema.nullable("task", "link")).toBe(false);
    // The model in either spelling.
    expect(schema.nullable("Task", "notes")).toBe(true);
  });

  it("does not answer for what is not a column of a model it declares", () => {
    // Relations, an @ignore field, an Unsupported one, a block attribute and an unknown field.
    for (const field of ["project", "parent", "subtasks", "legacy", "shape", "@@index", "nope"]) {
      expect(schema.nullable("task", field)).toBeUndefined();
    }
    expect(schema.nullable("nothing", "id")).toBeUndefined();
    expect(schema.nullable("role", "ADMIN")).toBeUndefined();
    expect(schema.nullable("hidden", "id")).toBeUndefined();
  });

  it("answers whether the tracker can key a model's rows by its id", () => {
    expect(schema.trackable("task")).toBe(true);
    expect(schema.trackable("Project")).toBe(true);
    expect(schema.trackable("member")).toBe(true);
    expect(schema.trackable("verificationToken")).toBe(false);
    // Left to the rows: an optional id; an id the tracker cannot key (bytes); a model it ignores.
    expect(schema.trackable("draft")).toBeUndefined();
    expect(schema.trackable("blob")).toBeUndefined();
    expect(schema.trackable("hidden")).toBeUndefined();
    expect(schema.trackable("nothing")).toBeUndefined();
  });

  it("takes a field's kind from the runtime data model when it lists the model", () => {
    const runtime = {
      models: {
        Task: {
          fields: [
            { name: "id", kind: "scalar" },
            { name: "notes", kind: "object" },
            { name: "ordinal", kind: "scalar" },
          ],
        },
        VerificationToken: { fields: [{ name: "id", kind: "scalar" }] },
      },
    };
    const checked = parsePrismaSchema(SCHEMA, runtime);
    expect(checked.nullable("task", "ordinal")).toBe(false);
    // The runtime says it is a relation, or does not list it: no answer.
    expect(checked.nullable("task", "notes")).toBeUndefined();
    expect(checked.nullable("task", "title")).toBeUndefined();
    // An id the runtime knows and the text does not show is left to the probe.
    expect(checked.trackable("verificationToken")).toBeUndefined();
    // A model the runtime does not list is read from the text alone.
    expect(checked.nullable("project", "id")).toBe(false);
  });

  it("answers nothing from text that declares no model", () => {
    for (const text of ["", "bm90IGEgc2NoZW1h", "enum Role {\n  ADMIN\n}"]) {
      const empty = parsePrismaSchema(text);
      expect([empty.nullable("task", "notes"), empty.trackable("task")]).toEqual([
        undefined,
        undefined,
      ]);
    }
  });
});

describe("the schema text of a client", () => {
  it("is read from the engine config Prisma keeps, and is never thrown for", () => {
    const client = { _engineConfig: { inlineSchema: SCHEMA } };
    expect(schemaTextOf(client)).toBe(SCHEMA);
    expect(prismaSchemaOf(client)?.nullable("task", "notes")).toBe(true);
    const throwing = {
      get _engineConfig(): never {
        throw new Error("internal");
      },
    };
    for (const other of [
      undefined,
      null,
      {},
      { _engineConfig: {} },
      { _engineConfig: { inlineSchema: 1 } },
      throwing,
    ]) {
      expect(schemaTextOf(other)).toBeUndefined();
      expect(prismaSchemaOf(other)).toBeUndefined();
    }
  });
});
