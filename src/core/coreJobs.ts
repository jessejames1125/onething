/**
 * Core-owned scheduled jobs: housekeeping for confirmations and the runner queue.
 */
import { registerCoreJob } from "./jobs";
import { expireConfirmations } from "./confirmations";
import { registerReleaseHandler, sweepTasks } from "./agentTasks";

let registered = false;

export function registerCoreJobs(): void {
  if (registered) return;
  registered = true;
  // The one tap that lets a held runner task (outside text in its bundle) go to Claude.
  registerReleaseHandler();
  registerCoreJob({ name: "confirmations.expire", schedule: { every: "1h" }, run: async (ctx) => void (await expireConfirmations(ctx)) });
  registerCoreJob({ name: "agent.sweep", schedule: { every: "15m" }, run: async (ctx) => void (await sweepTasks(ctx)) });
}
