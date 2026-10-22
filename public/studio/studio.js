// Studio: the one place to write a script (one voice or a conversation), cast it, hear it in several voices, save it, schedule it or send it.
// (Replaces the separate Generate and Voice Lab tabs. Being built: for now it opens the Voice Lab.)
import { mountLab } from '../lab/lab.js';

export async function mountStudio(root, api) {
  return mountLab(root, api);
}
