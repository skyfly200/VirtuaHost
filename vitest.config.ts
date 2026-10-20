import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // chips-voice/ is a separate project with its own tests (run with node:test; see chips-voice/README.md).
    exclude: [...configDefaults.exclude, "chips-voice/**", "station-daemon/**"],
  },
});
