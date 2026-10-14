<template lang="pug">
  v-dialog(:value="open" max-width="520" @input="$emit('close')")
    v-card
      v-card-title New schedule
      v-card-text
        v-text-field(v-model="name" label="Name (optional)" outlined dense)
        template(v-if="source")
          v-alert(dense text type="info" class="mb-4") {{ sourceLabel }}
        v-select(v-else v-model="clipId" :items="clipItems" label="Clip from the library" outlined dense :loading="loadingClips")
        v-text-field(v-model="startAt" label="First run" type="datetime-local" outlined dense)
        v-switch(v-model="repeat" label="Repeat" inset hide-details class="mt-0 mb-3")
        v-row(v-if="repeat" dense)
          v-col(cols="6")
            v-text-field(v-model.number="every" label="Every" type="number" min="1" outlined dense)
          v-col(cols="6")
            v-select(v-model="unit" :items="units" label="Unit" outlined dense)
          v-col(cols="12")
            v-text-field(v-model.number="count" label="Stop after this many runs (0 = never)" type="number" min="0" outlined dense hide-details)
        v-switch(v-model="preempt" label="Interrupt the live DJ" inset color="error" hide-details)
        v-alert(v-if="error" type="error" dense text class="mt-3") {{ error }}
      v-card-actions
        v-spacer
        v-btn(text @click="$emit('close')") Cancel
        v-btn(color="primary" depressed :loading="saving" :disabled="!canSave" @click="save") Schedule
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { notify } from '../notify';

  function localInput(ms: number) {
    const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }

  export default Vue.extend({
    name: 'ScheduleDialog',
    // `source` is either { clipId, title } (from the library) or { spec } (from the composer).
    props: { open: Boolean, source: { type: Object, default: null } },

    data: () => ({
      name: '',
      clipId: '',
      startAt: localInput(Date.now() + 10 * 60000),
      repeat: false,
      every: 1,
      unit: 3600,
      units: [{ text: 'minutes', value: 60 }, { text: 'hours', value: 3600 }, { text: 'days', value: 86400 }],
      count: 0,
      preempt: false,
      clipItems: [] as Array<{ text: string; value: string }>,
      loadingClips: false,
      saving: false,
      error: '',
    }),

    computed: {
      sourceLabel(): string {
        const s: any = this.source;
        return s && s.clipId ? `Clip: ${s.title}` : `Announcement: "${String(s && s.spec && (s.spec.text || s.spec.ssml)).slice(0, 80)}"`;
      },
      canSave(): boolean { return !!this.startAt && (!!this.source || !!this.clipId); },
    },

    watch: {
      open(now: boolean) {
        if (!now) return;
        this.error = '';
        this.startAt = localInput(Date.now() + 10 * 60000);
        if (!this.source) this.loadClips();
      },
    },

    methods: {
      async loadClips() {
        this.loadingClips = true;
        try {
          const { data } = await api.get('/clips');
          this.clipItems = data.map((c: any) => ({ text: c.title, value: c.id }));
        } catch (e) { /* the list stays empty */ } finally { this.loadingClips = false; }
      },
      async save() {
        this.saving = true;
        this.error = '';
        const s: any = this.source;
        const body: any = {
          name: this.name || undefined,
          startAt: new Date(this.startAt).getTime(),
          intervalSec: this.repeat ? this.every * this.unit : 0,
          count: this.repeat ? this.count : 0,
          preempt: this.preempt,
        };
        if (s && s.spec) body.spec = s.spec; else body.clipId = (s && s.clipId) || this.clipId;
        try {
          await api.post('/schedules', body);
          notify('Scheduled', 'success');
          this.$emit('saved');
          this.$emit('close');
        } catch (e) {
          this.error = errorMessage(e);
        } finally {
          this.saving = false;
        }
      },
    },
  });
</script>
