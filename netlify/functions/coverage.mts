import type { Config } from "@netlify/functions";
import { handleCoverage } from "../../lib/handlers/coverage.js";

export default (req: Request) => handleCoverage(req);

export const config: Config = {
  path: "/api/coverage",
};
