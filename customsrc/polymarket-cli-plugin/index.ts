// index.ts
import { execFile } from "child_process";

interface PluginLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface PluginApi {
  registerTool(tool: Record<string, unknown>): void;
  logger: PluginLogger;
}

const ALLOWED_COMMANDS = [
  "markets",
  "market",
  "events",
  "event",
  "clob prices",
  "clob spread",
  "clob book",
  "clob trades",
  "data portfolio",
  "data positions",
  "data profit",
  "data leaderboard",
  "data activity",
];

function isAllowed(args: string[]): boolean {
  const cmd = args.slice(0, 2).join(" ");
  const cmdSingle = args[0];
  return ALLOWED_COMMANDS.includes(cmd) || ALLOWED_COMMANDS.includes(cmdSingle);
}

export default function register(api: PluginApi) {
  api.registerTool({
    name: "polymarket_cli",
    description:
      "Query Polymarket for market data, prices, order books, positions, and events. Read-only commands only.",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "string",
          description:
            "The polymarket CLI arguments (e.g. 'markets --search bitcoin', 'clob prices --id 123', 'data portfolio')",
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
    async execute(_id: unknown, params: { args: string }) {
      const parts = params.args.split(/\s+/).filter(Boolean);

      if (parts.length === 0) {
        return { content: [{ type: "text", text: "Error: no arguments provided." }] };
      }

      if (!isAllowed(parts)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: command '${parts.slice(0, 2).join(" ")}' is not allowed. Read-only commands only: ${ALLOWED_COMMANDS.join(", ")}`,
            },
          ],
        };
      }

      const fullArgs = [...parts, "--output", "json"];

      return new Promise((resolve) => {
        execFile("polymarket", fullArgs, { timeout: 30_000 }, (err, stdout, stderr) => {
          if (err) {
            api.logger.error("Polymarket CLI error:", err.message);
            resolve({
              content: [{ type: "text", text: `Error: ${err.message}\n${stderr}` }],
            });
            return;
          }
          resolve({
            content: [{ type: "text", text: stdout || stderr || "(no output)" }],
          });
        });
      });
    },
  });
}
