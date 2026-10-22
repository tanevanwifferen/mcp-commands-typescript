/** MCP servers shaped like a CLI: a command tree behind two tools, `help` and `run`. */

export { CommandError, UsageError } from "./errors.js";
export { CliServer, type CliServerOptions } from "./server.js";
export {
  Command,
  Group,
  Param,
  type CommandConfig,
  type Extra,
  type GroupOptions,
  type Handler,
  type Shape,
  type Values,
} from "./tree.js";
