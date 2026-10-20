import type { Config } from "@netlify/functions";
import { handleFlier } from "../../lib/handlers/flier.js";

export default (req: Request) => handleFlier(req);

export const config: Config = {
  path: ["/api/flier/read", "/api/flier/promo"],
};
