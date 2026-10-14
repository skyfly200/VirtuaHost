import Vue from 'vue';
import api from './api';

export interface Info {
  loaded: boolean;
  tts: { names: string[]; capabilities: { ssml: boolean; pitch: boolean; rate: boolean; gain: boolean } };
  llm: { enabled: boolean; names: string[] };
  storage: { enabled: boolean; targets: Array<{ name: string; label: string }> };
  links: { enabled: boolean };
  limits: { maxText: number; maxSsml: number; maxPrompt: number };
}

// What the server can do (speech provider, AI drafting, cloud sharing). Loaded after login.
export const info: Info = Vue.observable({
  loaded: false,
  tts: { names: [], capabilities: { ssml: true, pitch: true, rate: true, gain: true } },
  llm: { enabled: false, names: [] },
  storage: { enabled: false, targets: [] },
  links: { enabled: false },
  limits: { maxText: 500, maxSsml: 2000, maxPrompt: 1000 },
});

export async function loadInfo() {
  try {
    const { data } = await api.get('/providers');
    Object.assign(info, data, { loaded: true });
  } catch (e) { /* the pages still work with defaults */ }
}
