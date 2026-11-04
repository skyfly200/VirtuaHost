import type { Config } from "@netlify/functions";
import { handleLive } from "../../lib/handlers/live.js";

export default (req: Request) => handleLive(req);

export const config: Config = {
  path: "/api/live",
};
