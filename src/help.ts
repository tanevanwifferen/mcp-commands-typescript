/** Rendering help text: compact, CLI-style, meant to be read by a model. */

import { Command, Group, type JsonSchema, Param } from "./tree.js";

/** How to write a command line, with `example` as the sample. */
export function usage(example: string): string {
  return (
    "Run a command with run(command, args?). The command is one line, like a shell: " +
    `the command path, then positional arguments, then --options, e.g. ${example}. ` +
    "Values are parsed as JSON when the parameter is not a string. " +
    "Repeat an array option, or pass a JSON array (--tags '[\"a\",\"b\"]'). " +
    "Structured values can go in args instead, as an object keyed by parameter name."
  );
}

export const USAGE = usage('issue create "Fix login" --priority 1');

/**
 * A sample command line from the tree: the first command with a required argument (its
 * path and required arguments as placeholders), else the first command.
 */
export function example(group: Group): string | undefined {
  let first: string | undefined;
  const queue: [Group, string[]][] = [[group, []]];
  while (queue.length) {
    const [node, path] = queue.shift()!;
    for (const child of node.children.values()) {
      if (child instanceof Group) {
        queue.push([child, [...path, child.name]]);
        continue;
      }
      const line = [...path, child.name].join(" ");
      const required = child.params.filter((p) => p.positional && p.required).map((p) => `<${p.name}>`);
      if (required.length) return [line, ...required].join(" ");
      first ??= line;
    }
  }
  return first;
}

/**
 * The run tool's description: what the server is, its top-level commands and how to write
 * a command line, so each server's run tool reads as its own.
 */
export function runDescription(group: Group): string {
  const out = group.help ? [`${group.name}: ${group.help}`] : [];
  const names = [...group.children.values()]
    .map((c) => (c instanceof Group ? `${c.name} …` : c.name))
    .join(", ");
  let line = `Run a ${group.name} command.`;
  if (names) line += ` Top-level commands: ${names}.`;
  out.push(line + ' help("<command>") shows a command\'s arguments and options.');
  const sample = example(group);
  out.push(sample ? usage(sample) : USAGE);
  return out.join("\n\n");
}

export function render(node: Group | Command, path: string[], depth = 1): string {
  return node instanceof Command ? renderCommand(node, path) : renderGroup(node, path, depth);
}

export function renderGroup(group: Group, path: string[], depth = 1): string {
  const title = path.join(" ") || group.name;
  const out = [group.help ? `${title}: ${group.help}` : title];
  if (group.description) out.push("", group.description);
  if (!group.children.size) {
    out.push("", "(no commands)");
    return out.join("\n");
  }

  const rows: [string, string][] = [];
  listing(group, 0, Math.max(depth, 1), rows);
  const width = Math.min(Math.max(...rows.map((r) => r[0].length)), 40);
  out.push("", "Commands:");
  for (const [left, right] of rows) {
    out.push(right ? `  ${left.padEnd(width)}  ${right}` : `  ${left}`);
  }
  const prefix = path.join(" ");
  out.push("", `Details: help("${prefix ? prefix + " " : ""}<command>")`);
  return out.join("\n");
}

function listing(group: Group, level: number, depth: number, rows: [string, string][]): void {
  const pad = "  ".repeat(level);
  for (const child of group.children.values()) {
    if (child instanceof Group) {
      const n = count(child);
      rows.push([`${pad}${child.name} …`, `${child.help ? child.help + " " : ""}(${n} ${n === 1 ? "command" : "commands"})`]);
      if (depth > 1) listing(child, level + 1, depth - 1, rows);
    } else {
      rows.push([`${pad}${child.name}${briefUsage(child)}`, child.help]);
    }
  }
}

function count(group: Group): number {
  let n = 0;
  for (const c of group.children.values()) n += c instanceof Group ? count(c) : 1;
  return n;
}

function briefUsage(command: Command): string {
  return command.params
    .filter((p) => p.positional)
    .map((p) => " " + positional(p))
    .join("");
}

function positional(p: Param): string {
  const dots = p.isArray ? "..." : "";
  return p.required ? `<${p.name}${dots}>` : `[${p.name}${dots}]`;
}

export function renderCommand(command: Command, path: string[]): string {
  let usage = path.join(" ") + briefUsage(command);
  if (command.params.some((p) => !p.positional)) usage += " [options]";
  const out = [`Usage: ${usage}`];
  if (command.aliases.length) out.push(`Aliases: ${command.aliases.join(", ")}`);
  if (command.help) out.push("", command.help);
  if (command.description) out.push("", command.description);

  const sections: [string, Param[]][] = [
    ["Arguments", command.params.filter((p) => p.positional)],
    ["Options", command.params.filter((p) => !p.positional)],
  ];
  for (const [heading, params] of sections) {
    if (!params.length) continue;
    const labels = params.map((p) => (p.positional ? p.name : p.flag));
    const width = Math.min(Math.max(...labels.map((l) => l.length)), 24);
    out.push("", `${heading}:`);
    params.forEach((p, i) => {
      let line = `  ${labels[i].padEnd(width)}  ${paramInfo(p)}`;
      if (p.description) line += `  ${p.description}`;
      out.push(line);
    });
  }
  return out.join("\n");
}

const SAFE_INT = Number.MAX_SAFE_INTEGER;

function paramInfo(p: Param): string {
  const s = p.schema;
  let info = typeLabel(s);
  if (p.required) info += ", required";
  else if (s.default !== undefined && s.default !== null) info += `, default ${JSON.stringify(s.default)}`;
  const constraints: string[] = [];
  const bounds: [string, string][] = [
    ["minimum", ">="],
    ["maximum", "<="],
    ["exclusiveMinimum", ">"],
    ["exclusiveMaximum", "<"],
    ["minLength", "min length"],
    ["maxLength", "max length"],
  ];
  for (const [key, word] of bounds) {
    if (key in s && Math.abs(s[key]) !== SAFE_INT) constraints.push(`${word} ${s[key]}`);
  }
  if (s.pattern) constraints.push(`matches /${s.pattern}/`);
  if (constraints.length) info += ", " + constraints.join(", ");
  return `(${info})`;
}

export function typeLabel(schema: JsonSchema): string {
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v: unknown) => (typeof v === "string" ? v : JSON.stringify(v))).join("|");
  }
  if ("const" in schema) return JSON.stringify(schema.const);
  const branches: JsonSchema[] | undefined = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const labels = [...new Set(branches.filter((b) => b.type !== "null").map(typeLabel))];
    return labels.join("|") || "null";
  }
  const t = schema.type;
  if (Array.isArray(t)) return t.filter((x) => x !== "null").join("|");
  if (t === "array") {
    const item = typeLabel(schema.items ?? {});
    return item.includes("|") ? `(${item})[]` : `${item}[]`;
  }
  if (t === "object" && schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries<JsonSchema>(schema.properties)
      .map(([k, v]) => `${k}${required.has(k) ? "" : "?"}: ${typeLabel(v)}`)
      .join(", ");
    return `{${fields}}`;
  }
  return t ?? "any";
}
