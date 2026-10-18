import Vue from 'vue';
import api from './api';

export interface Info {
  loaded: boolean;
  tts: {
    names: string[];
    capabilities: { ssml: boolean; pitch: boolean; rate: boolean; gain: boolean; dialogue?: boolean };
    providers: Array<{ name: string; capabilities: { ssml: boolean; pitch: boolean; rate: boolean; gain: boolean; dialogue?: boolean; tone?: boolean }; defaultVoice: string; models: string[] }>;
  };
  llm: { enabled: boolean; names: string[]; models: Array<{ provider: string; default: string; models: string[] }> };
  storage: { enabled: boolean; targets: Array<{ name: string; label: string }> };
  links: { enabled: boolean };
  fx: { available: boolean; presets: Array<{ name: string; label: string; description: string }> };
  sfx: { available: boolean; count: number; effects: Array<{ name: string; source: string; label: string }> };
  limits: { maxText: number; maxSsml: number; maxPrompt: number };
}

// What the server can do (speech provider, AI drafting, cloud sharing). Loaded after login.
export const info: Info = Vue.observable({
  loaded: false,
  tts: { names: [], capabilities: { ssml: true, pitch: true, rate: true, gain: true }, providers: [] },
  llm: { enabled: false, names: [], models: [] },
  storage: { enabled: false, targets: [] },
  links: { enabled: false },
  fx: { available: false, presets: [] },
  sfx: { available: false, count: 0, effects: [] },
  limits: { maxText: 500, maxSsml: 2000, maxPrompt: 1000 },
});

export async function loadInfo() {
  try {
    const { data } = await api.get('/providers');
    Object.assign(info, data, { loaded: true });
    // The server only says whether effects are available; the preset list is a separate call.
    info.fx = { available: false, presets: [] };
    info.sfx = { available: false, count: 0, effects: [] };
    if (data.fx && data.fx.available) {
      const presets = (await api.get('/fx/presets')).data.presets;
      info.fx = { available: true, presets };
    }
    if (data.sfx && data.sfx.available) await loadSfx();
  } catch (e) { /* the pages still work with defaults */ }
}

export async function loadSfx() {
  try {
    const { data } = await api.get('/sfx');
    info.sfx = { available: !!data.available, count: data.effects.length, effects: data.effects };
  } catch (e) { /* sound effects stay off */ }
}
