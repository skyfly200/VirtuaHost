import type { Config } from "@netlify/functions";
import { handlePlaces } from "../../lib/handlers/places.js";

export default (req: Request) => handlePlaces(req);

export const config: Config = {
  path: "/api/places",
};
