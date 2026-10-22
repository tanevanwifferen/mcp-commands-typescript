/** The command tree: groups that hold commands and other groups. */

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { UsageError } from "./errors.js";

export type JsonSchema = Record<string, any>;
export type Shape = Record<string, z.ZodType>;
export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Parameter values a handler receives: the parsed args and options together. */
export type Values<A extends Shape, O extends Shape> = z.output<z.ZodObject<A & O>>;

export type Handler<A extends Shape, O extends Shape> = (
  values: Values<A, O>,
  extra: Extra | undefined,
) => unknown;

export interface CommandConfig<A extends Shape, O extends Shape> {
  /** First paragraph is the one-line help shown in listings; the rest is shown on the command's page. */
  description?: string;
  /** Positional parameters, in order. They can also be given as --options. */
  args?: A;
  /** Parameters that can only be given as --options. */
  options?: O;
  aliases?: string[];
}

export interface GroupOptions {
  description?: string;
  aliases?: string[];
}

/** One parameter of a command, as the AI sees it. */
export class Param {
  constructor(
    readonly name: string,
    /** JSON schema of the value, with `$ref`s resolved. */
    readonly schema: JsonSchema,
    readonly required: boolean,
    readonly positional: boolean,
    readonly description: string | undefined,
  ) {}

  get flag(): string {
    return "--" + kebab(this.name);
  }

  get isBool(): boolean {
    const types = schemaTypes(this.schema);
    return types.size === 1 && types.has("boolean");
  }

  get isArray(): boolean {
    return schemaTypes(this.schema).has("array");
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A leaf of the tree: a function the AI can run. */
export class Command {
  readonly help: string;
  readonly description: string;
  readonly aliases: string[];
  readonly params: Param[];
  readonly schema: z.ZodObject;

  constructor(
    readonly name: string,
    config: CommandConfig<Shape, Shape>,
    readonly handler: (values: any, extra: Extra | undefined) => unknown,
  ) {
    checkName(name);
    this.aliases = (config.aliases ?? []).map(checkName);
    [this.help, this.description] = splitDescription(config.description ?? "");

    const args = config.args ?? {};
    const options = config.options ?? {};
    for (const key of Object.keys(args)) {
      if (key in options) throw new Error(`command ${name}: ${key} is both an arg and an option`);
    }
    this.schema = z.object({ ...args, ...options });
    const json = z.toJSONSchema(this.schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
    const defs = json.$defs ?? json.definitions ?? {};
    const required = new Set<string>(json.required ?? []);
    this.params = Object.entries<JsonSchema>(json.properties ?? {}).map(([key, prop]) => {
      const schema = deref(prop, defs);
      return new Param(key, schema, required.has(key), key in args, schema.description);
    });
  }

  param(key: string): Param | undefined {
    return this.params.find((p) => p.name === key || p.flag === "--" + key || p.name === key.replace(/-/g, "_"));
  }

  async invoke(values: Record<string, unknown>, extra?: Extra): Promise<unknown> {
    const parsed = this.schema.safeParse(values);
    if (!parsed.success) throw new UsageError(formatIssues(parsed.error.issues, values, this));
    return await this.handler(parsed.data, extra);
  }
}

/** An inner node of the tree: a named set of commands and subgroups. */
export class Group {
  readonly children = new Map<string, Group | Command>();
  readonly description: string;
  readonly aliases: string[];

  constructor(
    readonly name: string,
    readonly help = "",
    options: GroupOptions = {},
  ) {
    this.description = options.description ?? "";
    this.aliases = (options.aliases ?? []).map(checkName);
  }

  /** Create a subgroup, e.g. `const issue = app.group("issue", "Manage issues")`. */
  group(name: string, help?: string, options?: GroupOptions): Group {
    return this.add(new Group(checkName(name), help, options));
  }

  /** Register a command of this group. */
  command<A extends Shape = {}, O extends Shape = {}>(
    name: string,
    config: CommandConfig<A, O>,
    handler: Handler<A, O>,
  ): Command {
    return this.add(new Command(name, config, handler as Command["handler"]));
  }

  add<T extends Group | Command>(node: T): T {
    for (const key of [node.name, ...node.aliases]) {
      if (this.lookup(key)) throw new Error(`${this.name} already has a command or group named ${key}`);
    }
    this.children.set(node.name, node);
    return node;
  }

  lookup(token: string): Group | Command | undefined {
    return this.children.get(token) ?? [...this.children.values()].find((c) => c.aliases.includes(token));
  }
}

function checkName(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid command name ${JSON.stringify(name)}: use letters, digits, '-' and '_'`);
  return name;
}

function splitDescription(text: string): [string, string] {
  const trimmed = text.trim();
  const at = trimmed.search(/\n\s*\n/);
  if (at < 0) return [trimmed.split(/\s+/).join(" "), ""];
  return [trimmed.slice(0, at).split(/\s+/).join(" "), trimmed.slice(at).trim()];
}

export function kebab(name: string): string {
  return name
    .replace(/_/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

export function schemaTypes(schema: JsonSchema): Set<string> {
  const types = new Set<string>();
  const t = schema.type;
  if (typeof t === "string") types.add(t);
  else if (Array.isArray(t)) t.forEach((x) => types.add(x));
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    schemaTypes(branch).forEach((x) => types.add(x));
  }
  for (const v of schema.enum ?? []) types.add(jsonType(v));
  if ("const" in schema) types.add(jsonType(schema.const));
  types.delete("null");
  return types;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function deref(schema: any, defs: JsonSchema, seen = new Set<string>()): any {
  if (Array.isArray(schema)) return schema.map((s) => deref(s, defs, seen));
  if (!schema || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string") {
    const key = schema.$ref.split("/").pop()!;
    if (seen.has(key)) return { type: "object" };
    const { $ref, ...rest } = schema;
    return deref({ ...defs[key], ...rest }, defs, new Set([...seen, key]));
  }
  return Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, deref(v, defs, seen)]));
}

function formatIssues(issues: z.core.$ZodIssue[], values: Record<string, unknown>, command: Command): string {
  return issues
    .map((issue) => {
      const [first, ...rest] = issue.path.map(String);
      const param = first === undefined ? undefined : command.param(first);
      if (param && rest.length === 0 && values[param.name] === undefined) {
        return `missing required argument <${param.name}>`;
      }
      const label = param ? (param.positional ? param.name : param.flag) : (first ?? "?");
      const where = rest.length ? "." + rest.join(".") : "";
      const got = param ? lookupPath(values[param.name], rest) : undefined;
      return `${label}${where}: ${issue.message} (got ${JSON.stringify(got)})`;
    })
    .join("; ");
}

function lookupPath(value: unknown, path: string[]): unknown {
  return path.reduce<any>((v, k) => (v == null ? v : v[k]), value);
}
