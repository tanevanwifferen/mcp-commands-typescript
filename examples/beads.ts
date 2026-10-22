/**
 * A toy issue tracker in the style of beads, served as a command tree.
 *
 * Run it with: npx tsx examples/beads.ts
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CliServer, CommandError } from "../src/index.js";

export const app = new CliServer({
  name: "beads",
  version: "0.1.0",
  description: "Issue tracker with dependencies. Use it to plan work and find what is ready to do next.",
});

const Status = z.enum(["open", "in_progress", "closed"]);

interface Issue {
  id: string;
  title: string;
  priority: number;
  deps: string[];
  description: string;
  status: z.infer<typeof Status>;
}

const issues = new Map<string, Issue>();

function find(id: string): Issue {
  const found = issues.get(id);
  if (!found) throw new CommandError(`no issue ${JSON.stringify(id)}`);
  return found;
}

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
  ({ title, priority, deps = [], description }) => {
    deps.forEach(find);
    const id = `bd-${issues.size + 1}`;
    const created: Issue = { id, title, priority, deps, description, status: "open" };
    issues.set(id, created);
    return created;
  },
);

issue.command(
  "show",
  { description: "Show one issue.", aliases: ["get"], args: { id: z.string().describe("Issue ID, e.g. bd-1.") } },
  ({ id }) => find(id),
);

issue.command(
  "update",
  {
    description: "Change the status or priority of an issue.",
    args: { id: z.string() },
    options: { status: Status.optional(), priority: z.number().int().optional() },
  },
  ({ id, status, priority }) => {
    const found = find(id);
    if (status !== undefined) found.status = status;
    if (priority !== undefined) found.priority = priority;
    return found;
  },
);

issue.command(
  "list",
  {
    description: "List issues, open ones by default.",
    aliases: ["ls"],
    options: {
      status: Status.optional().describe("Only issues with this status."),
      all: z.boolean().default(false).describe("Include closed issues."),
    },
  },
  ({ status, all }) =>
    [...issues.values()].filter((i) => (!status || i.status === status) && (all || i.status !== "closed")),
);

app.command("ready", { description: "Open issues whose dependencies are all closed, most urgent first." }, () =>
  [...issues.values()]
    .filter((i) => i.status === "open" && i.deps.every((d) => issues.get(d)?.status === "closed"))
    .sort((a, b) => a.priority - b.priority),
);

if (import.meta.url === `file://${process.argv[1]}`) {
  await app.connect(new StdioServerTransport());
}
