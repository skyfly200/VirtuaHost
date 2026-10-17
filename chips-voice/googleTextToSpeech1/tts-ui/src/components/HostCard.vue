<template lang="pug">
  v-card.host(elevation="6")
    v-card-title.title-row
      span Virtual host
      v-spacer
      v-switch(:input-value="status.settings.enabled" @change="save({ enabled: !!$event })" inset hide-details dense class="mt-0" aria-label="Virtual host on or off")
    v-card-text
      p.hint Writes a short link about each song and plays it as the next one starts, over the music. Stays quiet during spots and live DJs.
      v-row(dense)
        v-col(cols="6")
          v-text-field(:value="status.settings.every" @change="save({ every: Number($event) })" label="Every N songs" type="number" min="1" outlined dense hide-details)
        v-col(cols="6")
          v-select(:value="status.settings.lines" @change="save({ lines: $event })" :items="lineModes" label="Lines" outlined dense hide-details)
      v-combobox(:value="status.settings.voice" @change="save({ voice: $event || '' })" :items="voices" item-text="label" item-value="id" :return-object="false" label="Voice" outlined dense hide-details class="mt-3" clearable)
      v-select(v-if="info.fx.available" :value="status.settings.fx || 'none'" @change="save({ fx: $event === 'none' ? '' : $event })" :items="effects" label="Audio treatment" outlined dense hide-details class="mt-3")
      .status-block
        .row
          v-chip(x-small label :color="status.running ? 'success' : 'grey'") {{ status.running ? 'watching' : 'off' }}
          span.now(v-if="status.current") {{ status.current.artist }} - {{ status.current.title }}
        .line(v-if="status.ready") Next link: "{{ status.ready.text }}"
        .line(v-else-if="status.preparing") Writing a link...
        .line(v-if="status.last") Last: "{{ status.last.text }}" {{ status.last.played ? '' : '(skipped: ' + status.last.reason + ')' }}
        .line.err(v-if="status.error") {{ status.error }}
        .counts {{ status.counters.played }} played · {{ status.counters.skipped }} skipped · {{ status.counters.failed }} failed
      v-divider(class="my-3")
      v-row(dense align="center")
        v-col
          v-text-field(v-model="testArtist" label="Test: artist" outlined dense hide-details)
        v-col
          v-text-field(v-model="testTitle" label="Test: title" outlined dense hide-details)
        v-col(cols="auto")
          v-btn(small depressed :loading="testing" :disabled="!testTitle" @click="test") Try line
      .line.test(v-if="testLine") {{ testLine }}
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { notify } from '../notify';
  import { info } from '../providers';

  export default Vue.extend({
    name: 'HostCard',

    data: () => ({
      info,
      status: {
        running: false, settings: { enabled: false, every: 1, lines: 'template', voice: '', fx: '', provider: '' },
        current: null, ready: null, preparing: false, last: null, error: '', counters: { prepared: 0, played: 0, skipped: 0, failed: 0 },
      } as any,
      voices: [] as Array<{ id: string; label: string }>,
      testArtist: 'Boards of Canada',
      testTitle: 'Roygbiv',
      testLine: '',
      testing: false,
      timer: 0,
    }),

    computed: {
      lineModes(): Array<{ text: string; value: string }> {
        return [{ text: 'Templates', value: 'template' }, ...(info.llm.enabled ? [{ text: 'AI written', value: 'llm' }] : [])];
      },
      effects(): Array<{ text: string; value: string }> {
        return [{ text: 'None', value: 'none' }, ...info.fx.presets.filter((p: any) => p.name !== 'none').map((p: any) => ({ text: p.label, value: p.name }))];
      },
    },

    mounted() {
      this.load();
      this.timer = window.setInterval(this.load, 8000);
      api.get('/tts/voices')
        .then(({ data }) => { this.voices = data.map((v: any) => ({ id: v.id, label: v.name || v.id })); })
        .catch(() => { /* free text still works */ });
    },
    beforeDestroy() { window.clearInterval(this.timer); },

    methods: {
      async load() {
        try { this.status = (await api.get('/host')).data; } catch (e) { /* keep the last status */ }
      },
      async save(patch: any) {
        try { this.status = (await api.put('/host', patch)).data; } catch (e) { notify(errorMessage(e), 'error'); this.load(); }
      },
      async test() {
        this.testing = true;
        try {
          this.testLine = (await api.post('/host/say', { artist: this.testArtist, title: this.testTitle, dryRun: true })).data.text;
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.testing = false;
        }
      },
    },
  });
</script>

<style lang="scss" scoped>
.host { border-radius: 20px !important; margin-top: 24px; }
.title-row { padding-bottom: 4px; }
.hint { font-size: 0.85rem; opacity: 0.7; }
.status-block { margin-top: 16px; font-size: 0.9rem; .row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; } .now { opacity: 0.85; } .line { opacity: 0.8; margin-top: 4px; word-break: break-word; } .err { color: var(--v-error-base); } .counts { opacity: 0.55; margin-top: 6px; font-size: 0.8rem; } }
.test { margin-top: 8px; font-style: italic; opacity: 0.9; }
</style>
