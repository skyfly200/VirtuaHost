import type { Config } from "@netlify/functions";
import { handleHost } from "../../lib/handlers/host.js";

export default (req: Request) => handleHost(req);

export const config: Config = {
  path: ["/api/host", "/api/host/preview"],
};
