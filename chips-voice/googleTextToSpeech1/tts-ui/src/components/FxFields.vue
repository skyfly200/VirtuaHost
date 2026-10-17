<template lang="pug">
  div.fx
    v-select(:value="value.preset" @input="set({ preset: $event })" :items="presets" label="Effect" outlined dense :hint="description" persistent-hint class="mb-2")
    v-slider(:value="value.pitch" @input="set({ pitch: $event })" label="Pitch (voice changer)" min="-12" max="12" step="1" thumb-label="always" :thumb-size="28" hide-details class="mt-6")
    v-slider(:value="value.speed" @input="set({ speed: $event })" label="Speed" min="0.5" max="2" step="0.05" thumb-label="always" :thumb-size="28" hide-details class="mt-6")
      template(v-slot:thumb-label="{ value }") {{ Number(value).toFixed(2) }}
    v-switch(:input-value="value.tighten" @change="set({ tighten: !!$event })" label="Trim long pauses" inset hide-details dense class="mt-2")
</template>

<script lang="ts">
  import Vue from 'vue';
  import { info } from '../providers';

  // Effect settings editor. v-model value: { preset, pitch, speed, tighten }.
  export default Vue.extend({
    name: 'FxFields',
    props: { value: { type: Object, required: true } },
    computed: {
      presets(): Array<{ text: string; value: string }> {
        return info.fx.presets.map((p: any) => ({ text: p.label, value: p.name }));
      },
      description(): string {
        const p: any = info.fx.presets.find((x: any) => x.name === this.value.preset);
        return p ? p.description : '';
      },
    },
    methods: {
      set(change: any) { this.$emit('input', { ...this.value, ...change }); },
    },
  });
</script>
