/**
 * An error the AI should see as-is: a bad command line, or a refusal from a command.
 * Throw it from a command to fail with a clean message.
 */
export class CommandError extends Error {
  override name = "CommandError";
}

/** The command line does not fit the command; the command's help is appended. */
export class UsageError extends CommandError {
  override name = "UsageError";
}
