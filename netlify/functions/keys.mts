import type { Config } from "@netlify/functions";
import { handleKeys } from "../../lib/handlers/keys.js";

export default (req: Request) => handleKeys(req);

export const config: Config = {
  path: "/api/keys",
};
