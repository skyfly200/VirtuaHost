import type { Config } from "@netlify/functions";
import { runDueSchedules } from "../../lib/scheduler.js";

// Runs every minute and makes whatever schedules are due (lib/scheduler.ts).
export default async () => {
  const result = await runDueSchedules();
  if (result.ran || result.skipped) console.log(`schedules: ran ${result.ran}, skipped ${result.skipped}`);
};

export const config: Config = {
  schedule: "* * * * *",
};
