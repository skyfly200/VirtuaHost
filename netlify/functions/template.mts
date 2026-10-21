import type { Config } from "@netlify/functions";
import { handleTemplate } from "../../lib/handlers/template.js";

export default (req: Request) => handleTemplate(req);

export const config: Config = {
  path: "/api/template",
};
