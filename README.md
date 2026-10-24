# mcp-commands

**MCP servers shaped like a CLI.** You define a tree of commands, like `git` or `beads`, and the
model sees only two tools: `help` and `run`.

```
issue create "Fix login" 1 bd-3 --description "Users get logged out after 5 minutes"
```

A regular MCP server sends the model a schema for every tool. That costs context before the
model has done anything, and the cost grows with each tool you add. mcp-commands keeps the
tool list at two however many commands you have. The model reads help for a command only when
it is about to use it, the way you'd run `--help`.

Also available for Python: [mcp-commands-python](https://github.com/tanevanwifferen/mcp-commands-python)
and Go: [mcp-commands-go](https://github.com/tanevanwifferen/mcp-commands-go).

## Install

```sh
npm install mcp-commands @modelcontextprotocol/sdk zod
```

Built on the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) and zod 4.

## Example

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CliServer, CommandError } from "mcp-commands";

const app = new CliServer({
  name: "beads",
  version: "1.0.0",
  description: "Issue tracker with dependencies. Use it to plan work and find what is ready next.",
});

const issue = app.group("issue", "Create, update and inspect issues");

issue.command(
  "create",
  {
    description: "Create an issue.",
    args: {
      title: z.string().describe("Short summary of the work."),
      priority: z.number().int().min(0).max(4).default(2).describe("0 is the most urgent, 4 the least."),
      deps: z.array(z.string()).optional().describe("IDs of issues that must be closed first."),
    },
    options: {
      description: z.string().default("").describe("Longer explanation, acceptance criteria."),
    },
  },
  async ({ title, priority, deps, description }, extra) => {
    // values are typed and validated
  },
);

issue.command(
  "list",
  { description: "List issues, open ones by default.", aliases: ["ls"], options: { all: z.boolean().default(false) } },
  ({ all }) => [],
);

app.command("ready", { description: "Open issues whose dependencies are all closed." }, () => []);

await app.connect(new StdioServerTransport());
```

The API follows `McpServer.registerTool`:

- `args` and `options` are zod shapes. `.describe()` gives a parameter its description.
- **Arguments** are positional, in the order you declare them. **Options** can only be passed as `--name value`.
- In `description`, the first paragraph is the one-liner shown in listings. The rest appears
  on the command's help page.
- `extra` is the SDK's `RequestHandlerExtra`, or `undefined` when you call `execute` directly.
- A handler can return a string, any JSON-serializable value, or `undefined` (shown as `OK`).
  It can also return a `CallToolResult`.
- `throw new CommandError("...")` fails the call with exactly that message.

Groups nest as deep as you like: `issue.group("label", "Manage labels")`.

## What the model sees

**`help(path = "", depth = 1)`**. The top-level listing is already in this tool's
description and in the server's MCP instructions, so the model usually doesn't need to call
it for the root:

```
beads: Issue tracker with dependencies. Use it to plan work and find what is ready next.

Commands:
  issue …  Create, update and inspect issues (4 commands)
  ready    Open issues whose dependencies are all closed.
```

`help("issue create")`:

```
Usage: issue create <title> [priority] [deps...] [options]

Create an issue.

Arguments:
  title     (string, required)  Short summary of the work.
  priority  (integer, default 2, >= 0, <= 4)  0 is the most urgent, 4 the least.
  deps      (string[])  IDs of issues that must be closed first.

Options:
  --description  (string, default "")  Longer explanation, acceptance criteria.
```

**`run(command, args?)`** executes one command line. `args` is an optional object of
parameter values, for input that is awkward to quote.

Both tools are titled and described per server (`beads: run a command`, and a `run`
description that starts with the server's name, description and top-level commands, with an
example taken from its own tree), so a client with several mcp-commands servers connected can
tell their `run` tools apart.

## Command-line rules

- The first words are the command path. Aliases work (`issue ls`).
- Arguments are positional, in declaration order. They can also be given as `--name value`.
- Options take `--name value` or `--name=value`. camelCase names become kebab-case (`dryRun` → `--dry-run`).
- Booleans: `--flag` sets true, `--no-flag` sets false.
- Arrays: an array argument in the last position takes the remaining words (`issue create t 1 bd-1 bd-2`).
  Otherwise repeat the option (`--deps a --deps b`) or pass JSON (`--deps '["a","b"]'`).
- Quoting works like a POSIX shell. `--` ends options. `--help` shows the command's help.
- Words for string parameters stay strings, so `123` stays `"123"`. Words for other types are
  parsed as JSON (`3`, `true`, `{"a": 1}`).

Errors are written for the model to act on:

```
--status: Invalid option: expected one of "open"|"in_progress"|"closed" (got string)

Usage: issue update <id> [options]
...
```

```
Unknown command "isue" in the root. Did you mean: issue? Available: issue, ready.
```

## Options

```ts
new CliServer({
  name,
  version,
  description,
  instructions,                    // defaults to the description plus how to use help/run
  helpTool: "help",                // tool names
  runTool: "run",
  listCommandsInDescription: true, // put the root listing in the help tool's description
  serverInfo,                      // extra Implementation fields for McpServer
  serverOptions,                   // ServerOptions for McpServer
});
```

`app.mcp` is the underlying `McpServer`, so you can add resources and prompts to it as usual.
`connect()` registers the two tools. If you connect `app.mcp` yourself, call `app.registerTools()` first.

## Testing without MCP

```ts
await app.execute('issue create "Fix login" --priority 1'); // returns what the handler returned
app.helpText("issue create");
```

## Development

```sh
npm install
npm test
npm run build
npx tsx examples/beads.ts
```

## License

MIT
