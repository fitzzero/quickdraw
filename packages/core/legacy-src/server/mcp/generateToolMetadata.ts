import * as fs from "fs";
import * as path from "path";
import type { GenerateToolMetadataOptions, ServiceInfo, ServiceMethodInfo } from "./types";

function extractFieldNames(schemaContent: string): string[] {
  const fields: string[] = [];
  const lines = schemaContent.split("\n");
  for (const line of lines) {
    const fieldMatch = line.match(/^\s*(\w+)\s*:/);
    if (fieldMatch?.[1]) {
      const name = fieldMatch[1];
      const isOptional = line.includes(".optional()") || line.includes(".nullable()");
      fields.push(isOptional ? `${name}?` : name);
    }
  }
  return fields;
}

function buildPayloadHint(fields?: string[]): string {
  if (!fields || fields.length === 0) return "";
  return `(${fields.join(", ")})`;
}

function parseServiceFile(filePath: string): ServiceInfo | null {
  const content = fs.readFileSync(filePath, "utf-8");

  const classMatch = content.match(/export class (\w+Service)/);
  if (!classMatch?.[1]) return null;

  const className = classMatch[1];
  const serviceName = className.charAt(0).toLowerCase() + className.slice(1);

  const aclMatch = content.match(/hasEntryACL:\s*(true|false)/);
  const hasEntryACL = aclMatch ? aclMatch[1] === "true" : false;

  let aclPattern = "No ACL";
  if (hasEntryACL) {
    if (content.includes("override async checkEntryACL")) {
      aclPattern = "Membership table";
    } else {
      aclPattern = "JSON ACL (default)";
    }
  }
  if (content.includes("override checkAccess")) {
    aclPattern = "Custom (self-access pattern)";
  }

  const schemas = new Map<string, string>();
  const schemaRegex = /const (\w+Schema) = z\.object\(\{([\s\S]*?)\}\);/g;
  let schemaMatch;
  while ((schemaMatch = schemaRegex.exec(content)) !== null) {
    if (!schemaMatch[1] || !schemaMatch[2]) continue;
    const schemaContent = schemaMatch[2]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n  ");
    schemas.set(schemaMatch[1], schemaContent);
  }

  const methods: ServiceMethodInfo[] = [];
  const methodRegex = /this\.defineMethod\(\s*["'](\w+)["'],\s*["'](\w+)["']/g;
  let methodMatch;
  while ((methodMatch = methodRegex.exec(content)) !== null) {
    const methodName = methodMatch[1] ?? "";
    const accessLevel = methodMatch[2] ?? "Read";

    const methodStart = methodMatch.index;
    let parenDepth = 0;
    let methodEnd = methodStart;
    let foundStart = false;

    for (let i = methodStart; i < content.length; i++) {
      if (content[i] === "(") {
        parenDepth++;
        foundStart = true;
      } else if (content[i] === ")") {
        parenDepth--;
        if (foundStart && parenDepth === 0) {
          methodEnd = i;
          break;
        }
      }
    }

    const methodBlock = content.substring(methodStart, methodEnd + 1);
    const hasSchema = methodBlock.includes("schema:");
    const schemaRef = methodBlock.match(/schema:\s*(\w+Schema)/);
    const hasResolver = methodBlock.includes("resolveEntryId:");

    let payloadFields: string[] | undefined;
    if (schemaRef?.[1]) {
      const schemaContent = schemas.get(schemaRef[1]);
      if (schemaContent) {
        payloadFields = extractFieldNames(schemaContent);
      }
    }

    methods.push({
      name: methodName,
      accessLevel,
      hasSchema,
      schemaName: schemaRef?.[1],
      hasResolver,
      payloadFields,
    });
  }

  return {
    name: serviceName,
    className,
    hasEntryACL,
    aclPattern,
    methods,
    schemas,
  };
}

function findServiceDirs(dir: string, basePath = ""): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

      if (fs.existsSync(path.join(fullPath, "index.ts"))) {
        results.push(relativePath);
      }

      const nested = findServiceDirs(fullPath, relativePath);
      results.push(...nested);
    }
  }

  return results;
}

function generateToolsFileContent(services: ServiceInfo[]): string {
  let content = `/**
 * MCP Tool Metadata
 * 
 * Auto-generated from service definitions.
 * DO NOT EDIT - regenerate with: pnpm docs:generate
 */

export type MethodSpec = {
  name: string;
  access: "Public" | "Read" | "Moderate" | "Admin";
  entryScoped: boolean;
  payloadHint: string;
};

export type ServiceToolSpec = {
  name: string;
  description: string;
  methods: MethodSpec[];
  methodNames: string[];
};

`;

  const serviceSpecs: string[] = [];
  for (const service of services) {
    const methodSpecs = service.methods.map((method) => {
      const hint = buildPayloadHint(method.payloadFields);
      return `    {
      name: "${method.name}",
      access: "${method.accessLevel}" as const,
      entryScoped: ${method.hasResolver},
      payloadHint: "${hint}",
    }`;
    });

    const methodDescriptions = service.methods
      .map((method) => {
        const hint = buildPayloadHint(method.payloadFields);
        return `- ${method.name}${hint}`;
      })
      .join("\\n");

    const description = `${service.className} service.\\n\\nMethods:\\n${methodDescriptions}`;

    serviceSpecs.push(`  {
    name: "${service.name}",
    description: "${description}",
    methods: [\n${methodSpecs.join(",\n")}\n    ],
    methodNames: [${service.methods.map((m) => `"${m.name}"`).join(", ")}],
  }`);
  }

  content += `export const SERVICE_TOOLS: ServiceToolSpec[] = [\n${serviceSpecs.join(",\n")}\n];\n\n`;
  content += `export const SERVICE_TOOLS_BY_NAME: Record<string, ServiceToolSpec> = Object.fromEntries(\n  SERVICE_TOOLS.map(s => [s.name, s])\n);\n\n`;
  content += `export function getServiceNames(): string[] {
  return SERVICE_TOOLS.map(s => s.name);
}

export function getServiceTool(serviceName: string): ServiceToolSpec | undefined {
  return SERVICE_TOOLS_BY_NAME[serviceName];
}

export function methodExists(serviceName: string, methodName: string): boolean {
  const service = SERVICE_TOOLS_BY_NAME[serviceName];
  return !!service?.methodNames.includes(methodName);
}

export function getMethodSpec(serviceName: string, methodName: string): MethodSpec | undefined {
  const service = SERVICE_TOOLS_BY_NAME[serviceName];
  return service?.methods.find(m => m.name === methodName);
}
`;

  return content;
}

function generateServiceDoc(service: ServiceInfo): string {
  let doc = `# ${service.className}\n\n`;
  doc += `**Service Name:** \`${service.name}\`\n\n`;
  doc += `**Access Control:** ${service.aclPattern}\n\n`;
  if (service.hasEntryACL) {
    doc += `**Entry-level ACL:** Enabled\n\n`;
  }
  doc += `---\n\n## Methods\n\n`;

  for (const method of service.methods) {
    doc += `### ${method.name}\n\n`;
    doc += `- **Access Level:** \`${method.accessLevel}\`\n`;
    doc += `- **Socket Event:** \`${service.name}:${method.name}\`\n`;
    if (method.hasResolver) {
      doc += `- **Entry-scoped:** Yes\n`;
    }
    if (method.hasSchema && method.schemaName) {
      doc += `- **Validation:** Zod schema (\`${method.schemaName}\`)\n`;
      const schemaContent = service.schemas.get(method.schemaName);
      if (schemaContent) {
        doc += `\n**Payload Schema:**\n\n\`\`\`typescript\n{\n  ${schemaContent}\n}\n\`\`\`\n`;
      }
    } else {
      doc += `- **Validation:** None\n`;
    }
    doc += `\n`;
  }

  doc += `---\n\n*Generated by quickdraw-core*\n`;
  return doc;
}

/**
 * Generate MCP tool metadata and optional API documentation from service source files.
 *
 * Parses `defineMethod()` calls and Zod schemas from service `index.ts` files
 * to produce TypeScript tool metadata and markdown documentation.
 */
export function generateToolMetadata(options: GenerateToolMetadataOptions): void {
  const { servicesDir, toolsOutputPath, docsOutputDir } = options;

  const serviceDirs = findServiceDirs(servicesDir);

  if (docsOutputDir && !fs.existsSync(docsOutputDir)) {
    fs.mkdirSync(docsOutputDir, { recursive: true });
  }

  const toolsDir = path.dirname(toolsOutputPath);
  if (!fs.existsSync(toolsDir)) {
    fs.mkdirSync(toolsDir, { recursive: true });
  }

  const allServices: ServiceInfo[] = [];

  for (const serviceDir of serviceDirs) {
    const indexPath = path.join(servicesDir, serviceDir, "index.ts");
    if (!fs.existsSync(indexPath)) continue;

    const serviceInfo = parseServiceFile(indexPath);
    if (!serviceInfo) continue;

    allServices.push(serviceInfo);

    if (docsOutputDir) {
      const doc = generateServiceDoc(serviceInfo);
      const outputPath = path.join(docsOutputDir, `${serviceInfo.className}.md`);
      fs.writeFileSync(outputPath, doc);
    }
  }

  if (docsOutputDir) {
    const indexContent =
      `# API Documentation\n\nAuto-generated documentation for all services.\n\n## Services\n\n` +
      allServices.map((s) => `- [${s.className}](./${s.className}.md)`).join("\n") +
      `\n\n---\n\n*Generated by quickdraw-core*\n`;
    fs.writeFileSync(path.join(docsOutputDir, "README.md"), indexContent);
  }

  const toolsContent = generateToolsFileContent(allServices);
  fs.writeFileSync(toolsOutputPath, toolsContent);

  const totalMethods = allServices.reduce((sum, s) => sum + s.methods.length, 0);
  // eslint-disable-next-line no-console
  console.log(
    `Generated ${allServices.length} service tools (${totalMethods} methods) -> ${toolsOutputPath}`,
  );
}
