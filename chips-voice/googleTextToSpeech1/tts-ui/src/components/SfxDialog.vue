<template lang="pug">
  v-dialog(:value="open" max-width="560" @input="$emit('close')")
    v-card
      v-card-title Sound effects
      v-card-text
        p.hint In any script, write <code>[sfx:name]</code> where the effect should play. Add <code>over</code> to mix it over the next words, <code>vol=0.5</code> for quieter, <code>wait=1</code> for a pause after.
        v-list(dense two-line)
          v-list-item(v-for="e in info.sfx.effects" :key="e.name")
            v-list-item-content
              v-list-item-title {{ e.name }}
              v-list-item-subtitle {{ e.source === 'uploaded' ? 'Uploaded' : 'Built in' }}{{ e.label && e.label !== e.name ? ' · ' + e.label : '' }}
            v-list-item-action-text
              v-btn(icon small :loading="playing === e.name" @click="preview(e.name)" :aria-label="'Preview ' + e.name")
                v-icon mdi-play
              v-btn(icon small @click="$emit('insert', e.name)" :aria-label="'Insert ' + e.name")
                v-icon mdi-plus
              v-btn(v-if="e.source === 'uploaded'" icon small @click="remove(e.name)" :aria-label="'Delete ' + e.name")
                v-icon mdi-trash-can-outline
        v-divider(class="my-3")
        .label Upload your own
        v-row(dense align="center")
          v-col(cols="5")
            v-text-field(v-model="newName" label="Name" outlined dense hide-details placeholder="station-jingle")
          v-col
            v-file-input(v-model="file" label="Audio file" outlined dense hide-details accept="audio/*" prepend-icon="")
          v-col(cols="auto")
            v-btn(small depressed color="primary" :loading="uploading" :disabled="!file || !newName" @click="upload") Add
        v-alert(v-if="error" type="error" dense text class="mt-3") {{ error }}
      v-card-actions
        v-spacer
        v-btn(text @click="$emit('close')") Close
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { info, loadSfx } from '../providers';
  import { notify } from '../notify';

  export default Vue.extend({
    name: 'SfxDialog',
    props: { open: Boolean },
    data: () => ({ info, playing: '', newName: '', file: null as File | null, uploading: false, error: '', audio: null as HTMLAudioElement | null }),
    watch: { open(now: boolean) { if (now) { this.error = ''; loadSfx(); } else this.stop(); } },
    beforeDestroy() { this.stop(); },
    methods: {
      stop() { if (this.audio) { this.audio.pause(); this.audio = null; } },
      async preview(name: string) {
        this.stop();
        this.playing = name;
        try {
          // The preview needs the login, so it is fetched with the token rather than played from a bare URL.
          const { data } = await api.get(`/sfx/${encodeURIComponent(name)}/audio`, { responseType: 'blob' });
          this.audio = new Audio(URL.createObjectURL(data));
          this.audio.onended = () => { this.playing = ''; };
          await this.audio.play();
        } catch (e) {
          notify(errorMessage(e), 'error');
          this.playing = '';
        }
      },
      async upload() {
        if (!this.file) return;
        this.uploading = true;
        this.error = '';
        try {
          await api.post('/sfx', this.file, { params: { name: this.newName }, headers: { 'Content-Type': this.file.type || 'application/octet-stream' } });
          notify('Sound added', 'success');
          this.newName = '';
          this.file = null;
          await loadSfx();
        } catch (e) {
          this.error = errorMessage(e);
        } finally {
          this.uploading = false;
        }
      },
      async remove(name: string) {
        if (!window.confirm(`Delete the sound "${name}"?`)) return;
        try { await api.delete(`/sfx/${encodeURIComponent(name)}`); await loadSfx(); } catch (e) { notify(errorMessage(e), 'error'); }
      },
    },
  });
</script>

<style lang="scss" scoped>
.hint { font-size: 0.85rem; opacity: 0.75; code { background: rgba(127, 127, 127, 0.2); padding: 0 4px; border-radius: 4px; } }
.label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; opacity: 0.6; margin-bottom: 6px; }
</style>
