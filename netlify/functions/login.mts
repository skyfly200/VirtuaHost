import type { Config } from "@netlify/functions";
import { handleLogin } from "../../lib/handlers/login.js";

export default (req: Request) => handleLogin(req);

export const config: Config = {
  path: "/api/login",
};
