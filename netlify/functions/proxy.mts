import type { Config } from "@netlify/functions";
import { handleProxy } from "../../lib/handlers/proxy.js";

export default (req: Request) => handleProxy(req);

export const config: Config = {
  path: ["/api/hub", "/api/hub/*", "/api/voice", "/api/voice/*"],
};
