import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CliServer, CommandError, UsageError } from "../src/index.js";

function makeApp(): CliServer {
  const app = new CliServer({ name: "beads", description: "Issue tracker" });
  const issue = app.group("issue", "Manage issues");

  issue.command(
    "create",
    {
      description: "Create an issue.",
      args: {
        title: z.string().describe("Short summary."),
        priority: z.number().int().default(2).describe("0-4."),
        deps: z.array(z.string()).optional(),
      },
      options: { draft: z.boolean().default(false), dryRun: z.boolean().default(false) },
    },
    ({ title, priority, deps, draft, dryRun }) => ({ title, priority, deps: deps ?? null, draft, dryRun }),
  );

  issue.command(
    "delete",
    { description: "Delete an issue.", aliases: ["rm"], args: { id: z.string() } },
    async ({ id }) => {
      if (id === "bd-0") throw new CommandError("bd-0 is protected");
      return `deleted ${id}`;
    },
  );

  const label = issue.group("label", "Manage labels");
  label.command(
    "add",
    { description: "Add labels.", args: { id: z.string(), labels: z.array(z.string()) } },
    ({ labels }) => labels,
  );

  app.command("ready", { description: "Show ready work." }, () => undefined);
  return app;
}

describe("execute", () => {
  it("binds positionals and options", async () => {
    const app = makeApp();
    expect(await app.execute('issue create "Fix login" 1 bd-1 bd-2')).toEqual({
      title: "Fix login",
      priority: 1,
      deps: ["bd-1", "bd-2"],
      draft: false,
      dryRun: false,
    });
    expect(await app.execute("issue create x --priority=3 --deps a --deps b --draft --dry-run")).toEqual({
      title: "x",
      priority: 3,
      deps: ["a", "b"],
      draft: true,
      dryRun: true,
    });
    const r = (await app.execute(`issue create x --deps '["a","b"]' --no-draft`)) as any;
    expect(r.deps).toEqual(["a", "b"]);
    expect(r.draft).toBe(false);
  });

  it("takes an args object", async () => {
    const app = makeApp();
    expect(await app.execute("issue create", { title: "t", deps: ["a"], draft: true })).toMatchObject({
      title: "t",
      priority: 2,
      deps: ["a"],
      draft: true,
    });
    await expect(app.execute("issue create t", { title: "u" })).rejects.toThrow(/both/);
  });

  it("keeps numbers as strings for string params", async () => {
    expect(((await makeApp().execute("issue create 123")) as any).title).toBe("123");
  });

  it("walks nested groups and fills a trailing array", async () => {
    expect(await makeApp().execute("issue label add bd-1 a b c")).toEqual(["a", "b", "c"]);
  });

  it("resolves aliases, awaits async handlers and passes command errors", async () => {
    const app = makeApp();
    expect(await app.execute("issue rm bd-3")).toBe("deleted bd-3");
    await expect(app.execute("issue delete bd-0")).rejects.toThrow("bd-0 is protected");
  });

  it("explains errors", async () => {
    const app = makeApp();
    await expect(app.execute("issue craete x")).rejects.toThrow(/Did you mean: issue create/);
    await expect(app.execute("issue create")).rejects.toThrow(/missing required argument <title>[\s\S]*Usage: issue create <title>/);
    await expect(app.execute("issue create x --prio 1")).rejects.toThrow(/Did you mean --priority/);
    await expect(app.execute("issue create x high")).rejects.toThrow(UsageError);
    await expect(app.execute("issue")).rejects.toThrow(/is a group/);
    await expect(app.execute("issue create 'unterminated")).rejects.toThrow(/closing quotation/);
  });

  it("answers --help inline", async () => {
    expect(await makeApp().execute("issue create --help")).toMatch(/^Usage: issue create/);
  });
});

describe("help", () => {
  it("renders pages", () => {
    const app = makeApp();
    const root = app.helpText();
    expect(root).toContain("issue …");
    expect(root).toContain("(3 commands)");
    expect(root).not.toContain("label");
    expect(app.helpText("", 2)).toContain("  label …");
    const cmd = app.helpText("issue create");
    expect(cmd).toContain("Usage: issue create <title> [priority] [deps...] [options]");
    expect(cmd).toContain("Short summary.");
    expect(cmd).toContain("--dry-run");
    expect(app.helpText("issue/label")).toBe(app.helpText("issue > label"));
  });
});

describe("over MCP", () => {
  it("exposes help and run", async () => {
    const app = makeApp();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await app.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["help", "run"]);
    expect(tools[0].description).toContain("issue …");

    const text = (r: any) => r.content[0].text as string;
    let r = await client.callTool({ name: "help", arguments: { path: "issue" } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("create <title>");

    r = await client.callTool({ name: "run", arguments: { command: "issue create 'A b' --priority 0" } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe('{"title":"A b","priority":0,"deps":null,"draft":false,"dryRun":false}');

    r = await client.callTool({ name: "run", arguments: { command: "issue delete bd-0" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("bd-0 is protected");

    r = await client.callTool({ name: "run", arguments: { command: "ready" } });
    expect(text(r)).toBe("OK");
    await client.close();
  });
});
