import type { Config } from "@netlify/functions";
import { handleAlerts } from "../../lib/handlers/alerts.js";

export default (req: Request) => handleAlerts(req);

export const config: Config = {
  path: "/api/alerts",
};
