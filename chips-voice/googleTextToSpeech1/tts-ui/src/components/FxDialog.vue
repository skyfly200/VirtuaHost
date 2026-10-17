<template lang="pug">
  v-dialog(:value="!!clip" max-width="460" @input="$emit('close')")
    v-card(v-if="clip")
      v-card-title Effects for "{{ clip.title }}"
      v-card-text
        p.hint Makes a processed copy in the library. The original stays as it is.
        FxFields(v-model="fx")
        v-alert(v-if="error" type="error" dense text class="mt-3") {{ error }}
      v-card-actions
        v-spacer
        v-btn(text @click="$emit('close')") Cancel
        v-btn(color="primary" depressed :loading="busy" :disabled="!changed" @click="apply") Create copy
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { notify } from '../notify';
  import FxFields from './FxFields.vue';

  export default Vue.extend({
    name: 'FxDialog',
    components: { FxFields },
    props: { clip: { type: Object, default: null } },
    data: () => ({ fx: { preset: 'none', pitch: 0, speed: 1, tighten: false }, busy: false, error: '' }),
    computed: {
      changed(): boolean { const f: any = this.fx; return f.preset !== 'none' || f.pitch !== 0 || f.speed !== 1 || f.tighten; },
    },
    watch: { clip() { this.fx = { preset: 'none', pitch: 0, speed: 1, tighten: false }; this.error = ''; } },
    methods: {
      async apply() {
        this.busy = true;
        this.error = '';
        try {
          await api.post(`/clips/${this.clip.id}/fx`, { fx: this.fx });
          notify('Created a processed copy', 'success');
          this.$emit('done');
          this.$emit('close');
        } catch (e) {
          this.error = errorMessage(e);
        } finally {
          this.busy = false;
        }
      },
    },
  });
</script>

<style lang="scss" scoped>
.hint { font-size: 0.85rem; opacity: 0.7; }
</style>
