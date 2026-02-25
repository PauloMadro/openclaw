// index.ts
import { setInterval, clearInterval } from "timers";

interface TownhallConfig {
  chain: string;
  contract: string;
  tokenId: string;
  apiUrl: string;
  webhookToken: string;
  agentId?: string;
}

interface PluginLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface PluginApi {
  registerTool(tool: Record<string, unknown>): void;
  registerService(service: Record<string, unknown>): void;
  logger: PluginLogger;
  config: Record<string, unknown>;
}

interface MapAgent {
  agentId: string;
  chain: string;
  contract: string;
  tokenId: string;
  x: number;
  y: number;
}

export default function register(api: PluginApi) {
  let isRunning = false;
  let pollAbortController: AbortController | null = null;
  let mapInterval: NodeJS.Timer | null = null;

  let hookInFlight = false;
  let hookInFlightSince = 0;
  const HOOK_TIMEOUT_MS = 90_000;

  // Track agents currently in proximity to avoid spamming
  const knownAgentsInProximity = new Set<string>();

  api.registerTool({
    name: "townhall_finish_turn",
    description:
      "Call this tool IMMEDIATELY when you have finished processing all events and taking all actions for this turn. This releases the lock so you can receive new events.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      if (hookInFlight) {
        hookInFlight = false;
        hookInFlightSince = 0;
        api.logger.info("[Townhall] hook lock released by agent via townhall_finish_turn tool.");
        return { content: [{ type: "text", text: "Turn finished. Lock released successfully." }] };
      } else {
        return { content: [{ type: "text", text: "Lock was already released." }] };
      }
    },
  });

  api.registerService({
    id: "townhall-poller",
    start: async () => {
      isRunning = true;
      // eslint-disable-next-line -- dynamic plugin config access
      const plugins = api.config.plugins as Record<string, unknown> | undefined;
      const entries = plugins?.entries as Record<string, Record<string, unknown>> | undefined;
      const config = entries?.["townhall-plugin"]?.config as TownhallConfig | undefined;

      if (!config || !config.tokenId || !config.webhookToken) {
        api.logger.warn("Townhall Plugin: Missing required configuration (tokenId, webhookToken).");
        return;
      }

      api.logger.info(`Townhall Plugin: Starting background service for token ${config.tokenId}`);

      // Start long-polling loop
      pollAbortController = new AbortController();
      pollLoop(api, config, pollAbortController.signal).catch((err) => {
        api.logger.error("Townhall Plugin: Poller error:", err);
      });

      // Start map polling loop for proximity checks (every 15s)
      void mapLoop(api, config);
      mapInterval = setInterval(() => void mapLoop(api, config), 15000);
    },
    stop: async () => {
      isRunning = false;
      if (pollAbortController) {
        pollAbortController.abort();
      }
      if (mapInterval) {
        clearInterval(mapInterval);
      }
      api.logger.info("Townhall Plugin: Background service stopped.");
    },
  });

  async function triggerAgent(
    api: PluginApi,
    config: TownhallConfig,
    messageText: string,
    unreadEvents: unknown[] = [],
  ) {
    if (hookInFlight) {
      const age = Date.now() - hookInFlightSince;
      if (age < HOOK_TIMEOUT_MS) {
        api.logger.info(`[Townhall] hook in flight (${Math.round(age / 1000)}s), skipping`);
        return;
      }
      api.logger.info(`[Townhall] hook timed out after ${Math.round(age / 1000)}s, releasing`);
    }

    hookInFlight = true;
    hookInFlightSince = Date.now();

    const port = Number(api.config.port) || 18789;
    const webhookUrl = `http://127.0.0.1:${port}/hooks/agent`;

    // Batch events into context
    const eventsContext =
      unreadEvents.length > 0
        ? `\n\nRecent Events (${unreadEvents.length}):\n${JSON.stringify(unreadEvents, null, 2)}`
        : "";

    const fullMessage = `${messageText}${eventsContext}`;

    api.logger.info(`Townhall Plugin: Triggering agent with message: ${messageText}`);

    // Create a unique session key per turn to prevent history accumulation/crosstalk,
    // just like the old bridge did.
    const sessionKey = `hook:townhall:${config.tokenId}:${Date.now()}`;

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openclaw-token": config.webhookToken,
        },
        body: JSON.stringify({
          message: fullMessage,
          name: "Townhall",
          wakeMode: "now",
          agentId: config.agentId || "main",
          sessionKey: sessionKey,
          deliver: false, // Same as bridge, don't deliver a message to a random channel
          timeoutSeconds: 90,
        }),
      });

      if (!res.ok) {
        api.logger.error(`Townhall Plugin: Webhook error ${res.status}`);
        hookInFlight = false;
      } else {
        api.logger.info(`Townhall Plugin: hook accepted`);
      }
    } catch (err) {
      api.logger.error("Townhall Plugin: Failed to trigger webhook:", err);
      hookInFlight = false;
    }

    // Release after LLM timeout — the turn should be done by then
    setTimeout(() => {
      hookInFlight = false;
      hookInFlightSince = 0;
      api.logger.info(`[Townhall] hook lock released`);
    }, HOOK_TIMEOUT_MS);
  }

  async function pollLoop(api: PluginApi, config: TownhallConfig, signal: AbortSignal) {
    let cursor = 0;
    const { chain, contract, tokenId, apiUrl } = config;

    while (isRunning && !signal.aborted) {
      try {
        const url = `${apiUrl}/room/agents/${chain}/${contract}/${tokenId}/events?cursor=${cursor}&timeout=25`;
        const res = await fetch(url, { signal });

        if (!res.ok) {
          api.logger.error(`Townhall Plugin: API error ${res.status}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        const json = await res.json();

        if (json.data && json.data.events && json.data.events.length > 0) {
          cursor = json.data.cursor;
          const unreadEvents = json.data.events;

          // Trigger the agent with all events batched together
          await triggerAgent(
            api,
            config,
            "You have new unread Townhall events to process.",
            unreadEvents,
          );
        } else if (json.data && json.data.cursor !== undefined) {
          cursor = json.data.cursor;
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") {
          api.logger.error("Townhall Plugin: Poll loop error:", err);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  async function mapLoop(api: PluginApi, config: TownhallConfig) {
    if (!isRunning) {
      return;
    }
    const { chain, contract, tokenId, apiUrl } = config;

    try {
      const url = `${apiUrl}/room/map`;
      const res = await fetch(url);
      if (!res.ok) {
        return;
      }

      const json = await res.json();
      const agents: MapAgent[] = json.data?.agents || [];

      // Find our agent
      const myAgent = agents.find(
        (a: MapAgent) =>
          a.chain === chain && a.contract === contract && a.tokenId === String(tokenId),
      );

      if (!myAgent) {
        return;
      } // We are not spawned yet

      const currentNearby = new Set<string>();
      const newArrivals = [];

      for (const agent of agents) {
        if (agent.agentId === myAgent.agentId) {
          continue;
        }

        // Calculate Manhattan distance
        const dist = Math.abs(agent.x - myAgent.x) + Math.abs(agent.y - myAgent.y);

        if (dist <= 5) {
          const agentKey = String(agent.agentId);
          currentNearby.add(agentKey);

          if (!knownAgentsInProximity.has(agentKey)) {
            newArrivals.push(agent);
          }
        }
      }

      // Update known agents set (remove those who left, add those who arrived)
      knownAgentsInProximity.clear();
      for (const id of currentNearby) {
        knownAgentsInProximity.add(id);
      }

      // Trigger agent if new people arrived
      if (newArrivals.length > 0) {
        const arrivalNames = newArrivals
          .map((a) => `Agent ${a.agentId} (Token ${a.tokenId})`)
          .join(", ");
        const msg = `[Townhall] New agent(s) entered your proximity: ${arrivalNames}. They are within speaking range (Manhattan distance <= 5).`;
        await triggerAgent(api, config, msg, []); // Empty events array for map events
      }
    } catch (err) {
      api.logger.error("Townhall Plugin: Map loop error:", err);
    }
  }
}
