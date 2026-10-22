/** Turning a command line (plus an optional args object) into a command and its values. */

import { CommandError, UsageError } from "./errors.js";
import { Command, Group, Param, schemaTypes } from "./tree.js";

/** Split a help path such as "issue create", "issue/create" or "issue > create". */
export function splitPath(path: string): string[] {
  return path.split(/[\s/>]+/).filter(Boolean);
}

/** Split a command line like a POSIX shell: quotes, backslash escapes, no expansion. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else current += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) current += line[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === "\\") {
      if (i + 1 >= line.length) throw new CommandError("cannot parse command line: no escaped character");
      current += line[++i];
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
    } else {
      current += c;
      inToken = true;
    }
  }
  if (quote) throw new CommandError("cannot parse command line: no closing quotation");
  if (inToken) tokens.push(current);
  return tokens;
}

/** Follow tokens down the tree as far as they name groups and commands. */
export function walk(root: Group, tokens: string[]): { node: Group | Command; path: string[]; rest: string[] } {
  let node: Group | Command = root;
  const path: string[] = [];
  let i = 0;
  while (node instanceof Group && i < tokens.length) {
    const child: Group | Command | undefined = node.lookup(tokens[i]);
    if (!child) break;
    node = child;
    path.push(child.name);
    i++;
  }
  return { node, path, rest: tokens.slice(i) };
}

export function unknownCommand(group: Group, path: string[], token: string): CommandError {
  const where = path.join(" ") || "the root";
  const names = [...group.children.values()].flatMap((c) => [c.name, ...c.aliases]);
  const close = closeMatches(token, names, 3);
  const hint = close.length ? ` Did you mean: ${close.map((c) => [...path, c].join(" ")).join(", ")}?` : "";
  const available = [...group.children.keys()].join(", ") || "none";
  return new CommandError(`Unknown command ${JSON.stringify(token)} in ${where}.${hint} Available: ${available}.`);
}

/** Assign command-line tokens and the args object to the command's parameters. */
export function bind(command: Command, tokens: string[], args?: Record<string, unknown> | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  let loose: string[] = [];

  let optionsDone = false;
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++];
    if (optionsDone || !token.startsWith("--")) {
      loose.push(token);
      continue;
    }
    if (token === "--") {
      optionsDone = true;
      continue;
    }
    const eq = token.indexOf("=");
    const key = eq < 0 ? token.slice(2) : token.slice(2, eq);
    let raw = eq < 0 ? undefined : token.slice(eq + 1);
    let param = command.param(key);
    if (!param && key.startsWith("no-")) {
      const negated = command.param(key.slice(3));
      if (negated?.isBool) {
        assign(values, negated, false);
        continue;
      }
    }
    if (!param) throw unknownOption(command, key);
    if (param.isBool && raw === undefined) {
      assign(values, param, true);
      continue;
    }
    if (raw === undefined) {
      if (i >= tokens.length) throw new UsageError(`${param.flag} needs a value`);
      raw = tokens[i++];
    }
    assign(values, param, coerce(param, raw));
  }

  const open = command.params.filter((p) => p.positional && !(p.name in values));
  open.forEach((param, n) => {
    if (!loose.length) return;
    if (param.isArray && n === open.length - 1) {
      for (const raw of loose) assign(values, param, coerce(param, raw));
      loose = [];
    } else {
      assign(values, param, coerce(param, loose.shift()!));
    }
  });
  if (loose.length) throw new UsageError(`unexpected argument(s): ${loose.map(quote).join(" ")}`);

  for (const [key, value] of Object.entries(args ?? {})) {
    const param = command.param(key);
    if (!param) throw unknownOption(command, key);
    if (param.name in values) throw new UsageError(`${param.name} is given both in the command line and in args`);
    values[param.name] = value;
  }
  return values;
}

function assign(values: Record<string, unknown>, param: Param, value: unknown): void {
  if (param.isArray) {
    const list = (values[param.name] ??= []) as unknown[];
    list.push(...(Array.isArray(value) ? value : [value]));
  } else if (param.name in values) {
    throw new UsageError(`${param.name} is given more than once`);
  } else {
    values[param.name] = value;
  }
}

/**
 * Turn a command-line token into a value, guided by the parameter's schema.
 *
 * Strings stay strings; anything else is read as JSON when it parses, so `3`,
 * `true`, `[1,2]` and `{"a":1}` arrive typed. A token for an array is one item,
 * unless it is a JSON array.
 */
function coerce(param: Param, raw: string): unknown {
  let schema = param.schema;
  if (param.isArray) {
    if (raw.startsWith("[")) {
      const parsed = tryJson(raw);
      if (Array.isArray(parsed)) return parsed;
    }
    const arrayBranch = [schema, ...(schema.anyOf ?? [])].find((s) => s.items);
    schema = arrayBranch?.items ?? {};
  }
  if (schemaTypes(schema).has("string")) return raw;
  return tryJson(raw) ?? raw;
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function quote(token: string): string {
  return /^[\w@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, `'"'"'`)}'`;
}

function unknownOption(command: Command, key: string): UsageError {
  const flags = command.params.map((p) => p.flag);
  const [close] = closeMatches("--" + key, flags, 1);
  const hint = close ? ` Did you mean ${close}?` : "";
  return new UsageError(`unknown option --${key}.${hint} Options: ${flags.join(", ") || "none"}.`);
}

function closeMatches(word: string, candidates: string[], n: number): string[] {
  return candidates
    .map((c) => ({ c, score: 1 - distance(word, c) / Math.max(word.length, c.length) }))
    .filter((m) => m.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((m) => m.c);
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
