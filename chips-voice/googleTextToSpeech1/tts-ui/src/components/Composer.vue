<template lang="pug">
  v-card.composer(elevation="6")
    v-card-title.title-row
      span New announcement
      v-spacer
      v-btn-toggle(v-if="caps.ssml || caps.dialogue" v-model="mode" mandatory dense rounded color="primary" borderless)
        v-btn(value="text" small) Text
        v-btn(v-if="caps.ssml" value="ssml" small) SSML
        v-btn(v-if="caps.dialogue" value="dialogue" small) Dialogue
    v-card-text
      v-textarea(
        v-if="mode === 'text'" ref="text" v-model="text" label="What should be announced?" outlined auto-grow rows="3"
        :counter="info.limits.maxText" :rules="[v => v.length <= info.limits.maxText || 'Too long']" hide-details="auto"
      )
      v-textarea(
        v-else-if="mode === 'ssml'" v-model="ssml" label="SSML" outlined auto-grow rows="3" class="mono" hide-details="auto"
        hint="Wrap the content in <speak>...</speak>" persistent-hint
      )
      .dialogue(v-else)
        v-row(v-for="(line, i) in turns" :key="i" dense align="start" class="line")
          v-col(cols="12" sm="4")
            v-combobox(v-model="line.voice" :items="voices" item-text="label" item-value="id" :return-object="false" label="Voice" outlined dense hide-details)
          v-col
            v-textarea(v-model="line.text" label="Says" outlined dense auto-grow rows="1" hide-details placeholder="[softly] audio tags work with ElevenLabs v3" @focus="activeLine = i")
            v-text-field(v-if="caps.tone" v-model="line.tone" label="Delivery (optional)" outlined dense hide-details class="mt-1" placeholder="dry, sleepy")
          v-col(cols="auto")
            v-btn(icon small :disabled="turns.length < 2" @click="turns.splice(i, 1)" aria-label="Remove line")
              v-icon(small) mdi-close
        v-btn(text small color="primary" @click="addTurn")
          v-icon(left small) mdi-plus
          | Add line
        v-btn(text small @click="pasting = !pasting" class="ml-2")
          v-icon(left small) mdi-text-box-outline
          | Paste a script
        div(v-if="pasting" class="mt-2")
          v-textarea(v-model="scriptText" outlined dense auto-grow rows="4" label="One line per turn: Name: what they say" hide-details placeholder="Rocky: Britta, what are we listening to?\nBritta: [laughs] No idea.")
          v-btn(small depressed color="primary" class="mt-2" :disabled="!scriptText.trim()" @click="applyScript") Use this script
      .helpers
        v-btn(v-if="info.llm.enabled && mode !== 'ssml'" text small color="secondary" class="mt-2" @click="drafting = true")
          v-icon(left small) mdi-creation
          | Draft with AI
        v-menu(v-if="info.sfx.available && mode !== 'ssml'" offset-y max-height="320")
          template(v-slot:activator="{ on }")
            v-btn(text small class="mt-2" v-on="on")
              v-icon(left small) mdi-music-note-plus
              | Sound effect
          v-list(dense)
            v-list-item(v-for="e in info.sfx.effects" :key="e.name" @click="insertSfx(e.name)")
              v-list-item-title {{ e.name }}
            v-divider
            v-list-item(@click="sounds = true")
              v-list-item-title Manage sounds...

      v-expansion-panels.options(flat accordion)
        v-expansion-panel
          v-expansion-panel-header
            span
              v-icon(left small) mdi-tune-variant
              | Voice and delivery
              span.provider  {{ provider || info.tts.names.join(' → ') }}
          v-expansion-panel-content
            v-select(v-if="info.tts.providers.length > 1" v-model="provider" :items="providerItems" label="Speech provider" outlined dense class="mb-2" hint="Automatic uses the first provider and falls back to the next if it fails" persistent-hint)
            v-select(v-if="modelItems.length > 1" v-model="model" :items="modelItems" label="Model" outlined dense class="mb-2" hint="Some models handle tone and conversation better than others" persistent-hint)
            v-text-field(v-if="caps.tone" v-model="tone" label="Tone / delivery" outlined dense class="mb-2" placeholder="warm, slow, a little tired" hint="Direction for how it is said (models that support it)" persistent-hint :counter="300")
            v-combobox(v-if="mode !== 'dialogue'" v-model="voice" :items="voices" item-text="label" item-value="id" :return-object="false" label="Voice" outlined dense :loading="loadingVoices" hint="Pick a voice or type a voice id" persistent-hint class="mb-2")
            v-select(v-model="format" :items="formats" label="Format" outlined dense v-if="!fxOn")
            template(v-if="info.fx.available")
              v-switch(v-model="fxOn" label="Effects and voice changer" inset hide-details dense class="mt-0 mb-3")
              FxFields(v-if="fxOn" v-model="fx")
            v-slider(v-if="caps.rate" v-model="speed" label="Speed" min="0.25" max="4" step="0.05" thumb-label="always" :thumb-size="28")
              template(v-slot:thumb-label="{ value }") {{ Number(value).toFixed(2) }}
            v-slider(v-if="caps.pitch" v-model="pitch" label="Pitch" min="-20" max="20" step="1" thumb-label="always" :thumb-size="28")
            v-slider(v-if="caps.gain" v-model="volume" label="Gain (dB)" min="-16" max="16" step="0.5" thumb-label="always" :thumb-size="28")

      v-switch(v-model="preempt" inset color="error" hide-details class="preempt")
        template(v-slot:label)
          span Interrupt the live DJ
          v-tooltip(bottom)
            template(v-slot:activator="{ on }")
              v-icon(small right v-on="on") mdi-information-outline
            span When a DJ is on air, cut in over them. Off: the announcement is skipped instead.
    v-card-actions.actions
      v-btn(text :loading="saving" :disabled="!ready" @click="save")
        v-icon(left) mdi-content-save-outline
        | Save
      v-btn(text :disabled="!ready" @click="scheduling = true")
        v-icon(left) mdi-clock-outline
        | Schedule
      v-spacer
      v-btn(color="primary" large depressed :loading="speaking" :disabled="!ready" @click="speak")
        v-icon(left) mdi-bullhorn-outline
        | Announce now

    template(v-if="history.length")
      v-divider
      v-subheader Recent
      v-list(two-line dense color="transparent")
        v-list-item(v-for="h in history" :key="h.id")
          v-list-item-icon
            v-icon(:color="h.color") {{ h.icon }}
          v-list-item-content
            v-list-item-title {{ h.text }}
            v-list-item-subtitle {{ h.when }} · {{ h.note }}
          v-list-item-action-text
            v-btn(icon small :disabled="!h.clipId" @click="replay(h)" :aria-label="'Play again: ' + h.text")
              v-icon mdi-replay
            v-btn(icon small :disabled="!h.clipId" @click="shareClip = { id: h.clipId, title: h.text }" aria-label="Share")
              v-icon mdi-share-variant-outline

    v-dialog(v-model="drafting" max-width="480")
      v-card
        v-card-title Draft with AI
        v-card-text
          v-textarea(v-model="brief" label="What is it about?" placeholder="Doors open at 7, last call at 11:30, mention the raffle" outlined auto-grow rows="3" :counter="info.limits.maxPrompt" autofocus)
          v-select(v-model="draftTone" :items="tones" label="Tone" outlined dense hide-details)
          v-switch(v-model="draftDialogue" label="A conversation between two voices" inset hide-details dense)
          v-switch(v-if="draftDialogue && info.sfx.available" v-model="draftSfx" label="Include sound effects" inset hide-details dense class="mt-0")
          v-select(v-if="draftModels.length > 1" v-model="draftModel" :items="draftModels" label="AI model" outlined dense hide-details class="mt-3")
          .hint(v-if="info.llm.names.length") Written by {{ info.llm.names.join(' → ') }}. Review the text before announcing.
        v-card-actions
          v-spacer
          v-btn(text @click="drafting = false") Cancel
          v-btn(color="secondary" depressed :loading="writing" :disabled="!brief.trim()" @click="draft")
            v-icon(left small) mdi-creation
            | Write it
    SfxDialog(:open="sounds" @close="sounds = false" @insert="insertSfx")
    ScheduleDialog(:open="scheduling" :source="scheduleSource" @close="scheduling = false" @saved="$emit('scheduled')")
    ShareDialog(:clip="shareClip" @close="shareClip = null")
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { notify } from '../notify';
  import { info } from '../providers';
  import ShareDialog from './ShareDialog.vue';
import FxFields from './FxFields.vue';
import SfxDialog from './SfxDialog.vue';
  import ScheduleDialog from './ScheduleDialog.vue';

  interface Entry { id: number; text: string; clipId: string; when: string; note: string; color: string; icon: string; }

  const HISTORY_KEY = 'chipsvoice.history';

  function loadHistory(): Entry[] {
    try { return JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
  }

  export default Vue.extend({
    name: 'Composer',
    components: { ShareDialog, ScheduleDialog, FxFields, SfxDialog },

    data: () => ({
      info,
      mode: 'text',
      text: '',
      ssml: '<speak>Hello world</speak>',
      voice: '',
      provider: '',
      turns: [{ voice: '', text: '' }, { voice: '', text: '' }] as Array<{ voice: string; text: string }>,
      sounds: false,
      activeLine: 0,
      tone: '',
      model: '',
      draftTone: 'friendly',
      draftDialogue: false,
      draftSfx: true,
      draftModel: '',
      pasting: false,
      scriptText: '',
      fxOn: false,
      fx: { preset: 'none', pitch: 0, speed: 1, tighten: false },
      voices: [] as Array<{ id: string; label: string }>,
      loadingVoices: false,
      format: 'OGG_OPUS',
      formats: ['OGG_OPUS', 'MP3', 'LINEAR16'],
      speed: 1,
      pitch: 0,
      volume: 3,
      preempt: false,
      speaking: false,
      saving: false,
      scheduling: false,
      shareClip: null as any,
      drafting: false,
      writing: false,
      brief: '',
      tones: ['friendly', 'upbeat', 'calm', 'formal', 'playful', 'urgent'],
      history: loadHistory() as Entry[],
    }),

    computed: {
      caps(): any {
        const p: any = info.tts.providers.find((x: any) => x.name === (this.provider || info.tts.names[0]));
        return p ? p.capabilities : info.tts.capabilities;
      },
      modelItems(): Array<{ text: string; value: string }> {
        const p: any = info.tts.providers.find((x: any) => x.name === (this.provider || info.tts.names[0]));
        return p && p.models.length > 1 ? p.models.map((m: string) => ({ text: m, value: m })) : [];
      },
      draftModels(): Array<{ text: string; value: string }> {
        const first: any = info.llm.models[0];
        return first && first.models.length > 1 ? first.models.map((m: string) => ({ text: m + (m === first.default ? ' (default)' : ''), value: m === first.default ? '' : m })) : [];
      },
      providerItems(): Array<{ text: string; value: string }> {
        return [{ text: 'Automatic', value: '' }, ...info.tts.providers.map((p: any) => ({ text: p.name, value: p.name }))];
      },
      content(): string {
        if (this.mode === 'dialogue') return this.turns.map((t) => t.text).join(' ').trim();
        return (this.mode === 'ssml' ? this.ssml : this.text).trim();
      },
      ready(): boolean {
        if (this.mode === 'dialogue') return this.turns.length > 0 && this.turns.every((t) => t.voice && t.text.trim());
        return !!this.content && (this.mode === 'ssml' || this.text.length <= info.limits.maxText);
      },
      scheduleSource(): any { return this.scheduling ? { spec: this.payload() } : null; },
    },

    watch: {
      provider() { this.loadVoices(); },
      caps(c: any) {
        if (this.mode === 'ssml' && !c.ssml) this.mode = 'text';
        if (this.mode === 'dialogue' && !c.dialogue) this.mode = 'text';
      },
    },

    mounted() { this.loadVoices(); },

    methods: {
      loadVoices() {
      this.loadingVoices = true;
      api.get('/tts/voices', { params: this.provider ? { provider: this.provider } : {} })
        .then(({ data }) => {
          this.voices = data.map((v: any) => ({
            id: v.id,
            label: [v.name || v.id, v.gender && `(${String(v.gender).toLowerCase()})`].filter(Boolean).join(' '),
          }));
          if (!this.voices.some((v) => v.id === this.voice)) this.voice = this.voices.length ? this.voices[0].id : '';
          this.turns.forEach((t, i) => { if (!t.voice && this.voices.length) t.voice = this.voices[Math.min(i, this.voices.length - 1)].id; });
        })
        .catch(() => { this.voices = []; })
        .then(() => { this.loadingVoices = false; });
      },
      applyScript() {
        const lines = this.scriptText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const sfxOnly = /^(\[\s*sfx\s*:[^\]]*\]\s*)+$/i;
        let last = '';
        const parsed: any[] = lines.map((l) => {
          if (sfxOnly.test(l)) return { voice: last, text: l, sfxOnly: true };
          const m = l.match(/^([^:(]{1,40}?)\s*(?:\(([^)]{1,200})\))?\s*:\s*(.+)$/);
          if (!m) return null;
          last = m[1].trim();
          return { voice: last, text: m[3].trim(), tone: m[2] ? m[2].trim() : '' };
        });
        if (parsed.some((t) => !t)) { notify('Every line needs a speaker, like "Rocky: Hello there."', 'warning'); return; }
        const firstVoice = (parsed.find((t) => !t.sfxOnly) || { voice: '' }).voice;
        this.turns = parsed.map((t) => ({ voice: t.voice || firstVoice, text: t.text, tone: t.tone || '' })) as any;
        this.pasting = false;
      },
      insertSfx(name: string) {
        const tag = `[sfx:${name}]`;
        if (this.mode === 'dialogue') {
          const line = this.turns[this.activeLine] || this.turns[this.turns.length - 1];
          line.text = `${line.text}${line.text && !/\s$/.test(line.text) ? ' ' : ''}${tag}`;
          return;
        }
        const area: any = this.$refs.text;
        const el: HTMLTextAreaElement | null = area && area.$refs && area.$refs.input ? area.$refs.input : null;
        const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : this.text.length;
        const before = this.text.slice(0, at);
        const after = this.text.slice(at);
        this.text = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${tag}${after && !/^\s/.test(after) ? ' ' : ''}${after}`;
      },
      addTurn() {
        const last = this.turns[this.turns.length - 1];
        const other = this.voices.find((v) => !last || v.id !== last.voice);
        this.turns.push({ voice: other ? other.id : '', text: '' });
      },
      payload() {
        return {
          provider: this.provider || undefined,
          fx: this.fxOn && info.fx.available ? this.fx : undefined,
          tone: this.caps.tone && this.tone ? this.tone : undefined,
          model: this.modelItems.length && this.model ? this.model : undefined,
          turns: this.mode === 'dialogue' ? this.turns.map((t: any) => ({ voice: t.voice, text: t.text, tone: t.tone || undefined })) : undefined,
          text: this.text,
          ssml: this.ssml,
          ssmlMode: this.mode === 'ssml',
          voice: this.voice,
          format: this.format,
          rate: this.speed,
          pitch: this.pitch,
          gain: this.volume,
          preempt: this.preempt,
        };
      },
      remember(entry: Partial<Entry>) {
        const now = new Date();
        const full: Entry = {
          id: now.getTime(),
          text: this.content.replace(/<[^>]+>/g, '').slice(0, 80),
          clipId: '',
          when: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          note: '', color: 'success', icon: 'mdi-check-circle-outline',
          ...entry,
        };
        this.history = [full, ...this.history].slice(0, 8);
        try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history)); } catch (e) { /* ignore */ }
      },
      async speak() {
        this.speaking = true;
        try {
          const { data } = await api.post('/speak', this.payload());
          const reuse = data.reused ? ' (reused from library)' : '';
          if (data.played === false) {
            notify(`Not played: ${data.reason}. Turn on "Interrupt the live DJ" to cut in.`, 'warning');
            this.remember({ clipId: data.clip.id, note: data.reason, color: 'warning', icon: 'mdi-alert-circle-outline' });
          } else {
            notify(`Announcement sent to the stream${reuse}`, 'success');
            this.remember({ clipId: data.clip.id, note: `sent${reuse}` });
          }
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.speaking = false;
        }
      },
      async save() {
        this.saving = true;
        try {
          const { data } = await api.post('/synth', this.payload());
          notify(data.reused ? 'Already in the library' : 'Saved to the library', 'success');
          this.remember({ clipId: data.clip.id, note: 'saved only', icon: 'mdi-content-save-outline' });
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.saving = false;
        }
      },
      async replay(entry: Entry) {
        try {
          const { data } = await api.post(`/clips/${entry.clipId}/play`, { preempt: this.preempt });
          if (data.played === false) notify(`Not played: ${data.reason}`, 'warning'); else notify('Playing again', 'success');
        } catch (e) {
          notify(errorMessage(e), 'error');
        }
      },
      async draft() {
        this.writing = true;
        try {
          const speakers = this.voices.slice(0, 2).map((v) => v.id);
          const { data } = await api.post('/announcements/draft', {
            prompt: this.brief, tone: this.draftTone, model: this.draftModel || undefined,
            format: this.draftDialogue ? 'dialogue' : 'text', speakers: speakers.length ? speakers : undefined, sfx: this.draftDialogue && this.draftSfx,
          });
          if (data.format === 'dialogue') { this.scriptText = data.text; this.applyScript(); this.mode = 'dialogue'; } else { this.text = data.text; this.mode = 'text'; }
          this.drafting = false;
          notify('Draft ready. Check it before announcing.', 'success');
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.writing = false;
        }
      },
    },
  });
</script>

<style lang="scss" scoped>
.composer { border-radius: 20px !important; }
.title-row { padding-bottom: 8px; }
.options { margin: 12px 0; ::v-deep .v-expansion-panel { background: transparent !important; } }
.provider { opacity: 0.55; font-size: 0.8rem; margin-left: 8px; }
.preempt { margin-top: 4px; }
.actions { padding: 8px 16px 16px; }
.hint { font-size: 0.85rem; opacity: 0.7; margin-top: 8px; }
.line { margin-bottom: 8px; }
.helpers { display: flex; flex-wrap: wrap; gap: 4px; }
.mono ::v-deep textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; }
</style>
