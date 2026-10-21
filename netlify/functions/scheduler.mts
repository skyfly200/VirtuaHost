import type { Config } from "@netlify/functions";
import { runDueSchedules } from "../../lib/scheduler.js";
import { createLogger } from "../../lib/log.js";

const log = createLogger("scheduler");

// Runs every minute and makes whatever schedules are due (lib/scheduler.ts).
export default async () => {
  const result = await runDueSchedules();
  if (result.ran || result.skipped) log.info("schedules processed", result);
};

export const config: Config = {
  schedule: "* * * * *",
};
