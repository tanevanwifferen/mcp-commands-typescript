/** CliServer: an MCP server that exposes a command tree through two tools. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Implementation } from "@modelcontextprotocol/sdk/types.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { CommandError, UsageError } from "./errors.js";
import * as help from "./help.js";
import { bind, splitPath, tokenize, unknownCommand, walk } from "./parse.js";
import { Group, type Extra } from "./tree.js";

export interface CliServerOptions {
  /** Server name, also the title of the root help page. */
  name: string;
  version?: string;
  /** What the server is for; the first thing the model reads. */
  description?: string;
  /** MCP instructions sent at initialization. Defaults to the description plus a short explanation of help and run. */
  instructions?: string;
  /** Name of the discovery tool. Default "help". */
  helpTool?: string;
  /** Name of the execution tool. Default "run". */
  runTool?: string;
  /** Put the top-level command listing in the help tool's description, so the model knows the commands without a call. Default true. */
  listCommandsInDescription?: boolean;
  /** Extra Implementation fields and ServerOptions, passed on to McpServer. */
  serverInfo?: Partial<Implementation>;
  serverOptions?: ServerOptions;
}

/**
 * An MCP server whose commands are discovered with `help` and executed with `run`.
 *
 * ```ts
 * const app = new CliServer({ name: "beads", description: "Git-backed issue tracker" });
 * const issue = app.group("issue", "Manage issues");
 * issue.command("create", {
 *   description: "Create an issue.",
 *   args: { title: z.string(), priority: z.number().int().default(2) },
 * }, ({ title, priority }) => ({ title, priority }));
 * await app.connect(new StdioServerTransport());
 * ```
 */
export class CliServer extends Group {
  /** The underlying McpServer; add resources and prompts to it as usual. */
  readonly mcp: McpServer;
  readonly helpToolName: string;
  readonly runToolName: string;
  readonly listCommandsInDescription: boolean;

  constructor(options: CliServerOptions) {
    super(options.name, options.description ?? "");
    this.helpToolName = options.helpTool ?? "help";
    this.runToolName = options.runTool ?? "run";
    this.listCommandsInDescription = options.listCommandsInDescription ?? true;
    const instructions =
      options.instructions ??
      `${options.description ? options.description + "\n\n" : ""}` +
        `This server is a command tree, used like a CLI. Call ${this.helpToolName}() to list the commands, ` +
        `${this.helpToolName}("<command path>") for a group or a command's arguments, ` +
        `and ${this.runToolName}("<command path> <arguments> --option value") to execute one.`;
    this.mcp = new McpServer(
      { ...options.serverInfo, name: options.name, version: options.version ?? "0.0.0" },
      { ...options.serverOptions, instructions },
    );
  }

  // -- Using the tree directly (tests, other front ends) --

  /** The help page for a path: "" for the root, "issue", "issue create", ... */
  helpText(path = "", depth = 1): string {
    const { node, path: found, rest } = walk(this, splitPath(path));
    if (rest.length) throw unknownCommand(node as Group, found, rest[0]);
    return help.render(node, found, depth);
  }

  /** Parse and run one command line, returning what the command returned. */
  async execute(line: string, args?: Record<string, unknown> | null, extra?: Extra): Promise<unknown> {
    const { node, path, rest } = walk(this, tokenize(line));
    const end = rest.indexOf("--");
    const options = end < 0 ? rest : rest.slice(0, end);
    if (options.includes("--help") || options.includes("-h")) return help.render(node, path);
    if (node instanceof Group) {
      if (rest.length) throw unknownCommand(node, path, rest[0]);
      const what = path.length ? `${JSON.stringify(path.join(" "))} is a group, not a command` : "No command given";
      throw new CommandError(`${what}.\n\n${help.renderGroup(node, path)}`);
    }
    try {
      return await node.invoke(bind(node, rest, args), extra);
    } catch (e) {
      if (e instanceof UsageError) throw new UsageError(`${e.message}\n\n${help.renderCommand(node, path)}`);
      throw e;
    }
  }

  // -- MCP --

  /** Register the help and run tools for the current tree and connect. */
  async connect(transport: Transport): Promise<void> {
    this.registerTools();
    await this.mcp.connect(transport);
  }

  async close(): Promise<void> {
    await this.mcp.close();
  }

  private registered: { remove(): void }[] = [];

  /** Register (or re-register) the help and run tools; `connect` does this for you. */
  registerTools(): void {
    this.registered.forEach((t) => t.remove());

    let helpDescription =
      "List the commands of this server and show how to call them. " +
      'help() lists the top-level commands, help("<group>") a group\'s commands, ' +
      'help("<group> <command>") a command\'s arguments and options. ' +
      "Raise depth to list nested groups too.";
    if (this.help) helpDescription = `${this.name}: ${this.help}\n\n${helpDescription}`;
    if (this.listCommandsInDescription && this.children.size) {
      const page = help.renderGroup(this, [], 1);
      helpDescription += "\n\n" + page.slice(page.indexOf("\n\n") + 2);
    }

    const sample = help.example(this) ?? 'issue create "Title" --priority 1';
    const helpTool = this.mcp.registerTool(
      this.helpToolName,
      {
        title: `${this.name}: list commands`,
        description: helpDescription,
        inputSchema: {
          path: z.string().default("").describe('Command path, e.g. "" for the root, "issue", "issue create".'),
          depth: z.number().int().min(1).max(10).default(1).describe("How many levels of nested groups to list."),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ path, depth }) => {
        try {
          return text(this.helpText(path, depth));
        } catch (e) {
          if (e instanceof CommandError) return text(e.message, true);
          throw e;
        }
      },
    );

    const runTool = this.mcp.registerTool(
      this.runToolName,
      {
        title: `${this.name}: run a command`,
        description: help.runDescription(this),
        inputSchema: {
          command: z
            .string()
            .describe(`One ${this.name} command line: path, arguments, options. E.g. ${sample}`),
          args: z
            .record(z.string(), z.unknown())
            .nullish()
            .describe("Optional parameter values by name, for structured input."),
        },
      },
      async ({ command, args }, extra) => {
        try {
          return toResult(await this.execute(command, args, extra));
        } catch (e) {
          if (e instanceof CommandError) return text(e.message, true);
          const err = e instanceof Error ? e : new Error(String(e));
          return text(`${err.name}: ${err.message}`, true);
        }
      },
    );
    this.registered = [helpTool, runTool];
  }
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

function toResult(value: unknown): CallToolResult {
  if (value && typeof value === "object" && Array.isArray((value as CallToolResult).content)) {
    return value as CallToolResult;
  }
  if (value === undefined || value === null) return text("OK");
  if (typeof value === "string") return text(value);
  return text(JSON.stringify(value));
}
