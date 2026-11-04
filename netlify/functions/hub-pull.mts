import type { Config } from "@netlify/functions";
import { handleHubPull } from "../../lib/handlers/hub-pull.js";

export default (req: Request) => handleHubPull(req);

export const config: Config = {
  path: ["/api/pull/stations/:id/heartbeat", "/api/pull/stations/:id/queue", "/api/pull/stations/:id/queue/:item/audio", "/api/pull/stations/:id/queue/:item/ack"],
};
