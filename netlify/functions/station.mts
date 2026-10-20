import type { Config } from "@netlify/functions";
import { handleStation } from "../../lib/handlers/station.js";

export default (req: Request) => handleStation(req);

export const config: Config = {
  path: ["/api/station/next", "/api/station/ack", "/api/station/clips/:id"],
};
