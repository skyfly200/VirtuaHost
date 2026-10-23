import type { Config } from "@netlify/functions";
import { handleEstimate } from "../../lib/handlers/estimate.js";

export default (req: Request) => handleEstimate(req);

export const config: Config = {
  path: "/api/estimate",
};
