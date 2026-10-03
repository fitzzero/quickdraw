// Tools generated from contracts (RFC 0003 section 10): names, descriptions,
// argument schemas from Standard JSON Schema, read-only hints, and the
// registration errors for schemas that cannot make a tool.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import { defineContract, mutation, query } from "../../index";
import { createServices, qd } from "./__tests__/fixtures";
import { describeTools } from "./index";

const { taskService, noteService } = createServices();

describe("describeTools", () => {
  it("makes one tool per method of the two sample contracts", () => {
    expect(describeTools([taskService, noteService])).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "description": "Reads one task by its id.",
          "inputSchema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {
              "id": {
                "type": "string",
              },
            },
            "required": [
              "id",
            ],
            "type": "object",
          },
          "name": "taskService_get",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "description": "taskService.list (query)",
          "inputSchema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {
              "done": {
                "type": "boolean",
              },
              "limit": {
                "default": 20,
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991,
                "type": "integer",
              },
            },
            "type": "object",
          },
          "name": "taskService_list",
        },
        {
          "description": "Renames a task. Needs the tasks:write scope.",
          "inputSchema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {
              "id": {
                "type": "string",
              },
              "title": {
                "minLength": 1,
                "type": "string",
              },
            },
            "required": [
              "id",
              "title",
            ],
            "type": "object",
          },
          "name": "taskService_rename",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "description": "Says who is calling.",
          "inputSchema": {
            "properties": {},
            "type": "object",
          },
          "name": "taskService_whoami",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "description": "noteService.search (query)",
          "inputSchema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {
              "input": {
                "minLength": 1,
                "type": "string",
              },
            },
            "required": [
              "input",
            ],
            "type": "object",
          },
          "name": "noteService_search",
        },
        {
          "description": "noteService.archive (mutation)",
          "inputSchema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {
              "input": {
                "oneOf": [
                  {
                    "properties": {
                      "by": {
                        "const": "id",
                        "type": "string",
                      },
                      "id": {
                        "type": "string",
                      },
                    },
                    "required": [
                      "by",
                      "id",
                    ],
                    "type": "object",
                  },
                  {
                    "properties": {
                      "by": {
                        "const": "tag",
                        "type": "string",
                      },
                      "tag": {
                        "type": "string",
                      },
                    },
                    "required": [
                      "by",
                      "tag",
                    ],
                    "type": "object",
                  },
                ],
              },
            },
            "required": [
              "input",
            ],
            "type": "object",
          },
          "name": "noteService_archive",
        },
        {
          "annotations": {
            "readOnlyHint": true,
          },
          "description": "noteService.wait (query)",
          "inputSchema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "properties": {
              "key": {
                "type": "string",
              },
            },
            "required": [
              "key",
            ],
            "type": "object",
          },
          "name": "noteService_wait",
        },
      ]
    `);
  });

  it("names tools with the name option, and selects them with include and exclude", () => {
    const names = (options: Parameters<typeof describeTools>[1]) =>
      describeTools([taskService, noteService], options).map((tool) => tool.name);
    expect(names({ include: ["noteService", "taskService.get"] })).toEqual([
      "taskService_get",
      "noteService_search",
      "noteService_archive",
      "noteService_wait",
    ]);
    expect(names({ exclude: ["taskService", "noteService.wait"] })).toEqual([
      "noteService_search",
      "noteService_archive",
    ]);
    expect(
      names({
        include: ["taskService"],
        exclude: ["taskService.whoami"],
        name: (service, method) => `${method}_${service.replace(/Service$/, "")}`,
      }),
    ).toEqual(["get_task", "list_task", "rename_task"]);
  });

  it("refuses an input schema without Standard JSON Schema, naming the method and the fix", () => {
    const legacy = defineContract("legacyService", {
      methods: { find: query({ input: z3.object({ id: z3.string() }), output: z3.string() }) },
    });
    const legacyService = qd.defineService(legacy, {
      methods: { find: { access: "public", handler: ({ input }) => input.id } },
    });
    expect(() => describeTools([legacyService])).toThrow(
      "describeTools: the input schema of legacyService.find cannot describe itself as JSON Schema, which an MCP tool needs: use Zod 4.2 or later for that schema, or leave legacyService.find out with exclude",
    );
    expect(describeTools([legacyService], { exclude: ["legacyService.find"] })).toEqual([]);
  });

  it("refuses an input JSON Schema cannot represent, unless the method takes no input", () => {
    const dated = defineContract("datedService", {
      methods: {
        since: query({ input: z.object({ at: z.date() }), output: z.number() }),
        ping: mutation({ input: z.void(), output: z.literal("pong") }),
      },
    });
    const datedService = qd.defineService(dated, {
      methods: {
        since: { access: "public", handler: () => 0 },
        ping: { access: "public", handler: () => "pong" as const },
      },
    });
    expect(() => describeTools([datedService])).toThrow(
      "describeTools: the input schema of datedService.since cannot be written as JSON Schema (Date cannot be represented in JSON Schema): change that schema, or leave datedService.since out with exclude",
    );
    expect(describeTools([datedService], { exclude: ["datedService.since"] })).toEqual([
      {
        name: "datedService_ping",
        description: "datedService.ping (mutation)",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  it("refuses unknown references, bad names and duplicate names", () => {
    const services = [taskService, noteService] as const;
    expect(() =>
      describeTools(services, { include: ["taskService.gte" as "taskService.get"] }),
    ).toThrow(
      'describeTools: include names "taskService.gte", which is not a service or method being served',
    );
    expect(() => describeTools(services, { exclude: ["chatService" as "taskService"] })).toThrow(
      'exclude names "chatService"',
    );
    expect(() => describeTools(services, { name: () => "" })).toThrow(
      'describeTools: name returned "" for taskService.get; a tool name is a non-empty string',
    );
    expect(() => describeTools(services, { name: (_service, method) => method })).not.toThrow();
    expect(() => describeTools([taskService, taskService])).toThrow(
      'describeTools: two tools are named "taskService_get": taskService.get and taskService.get',
    );
    expect(() => describeTools(services, { name: () => "same" })).toThrow(
      'two tools are named "same": taskService.get and taskService.list',
    );
  });
});
