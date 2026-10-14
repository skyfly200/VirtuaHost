<template lang="pug">
  v-dialog(:value="!!clip" max-width="520" @input="$emit('close')")
    v-card(v-if="clip")
      v-card-title.share-title Share "{{ clip.title }}"
      v-card-text
        .section-label Stream link
        p.hint A signed link that any media player can open and seek in. It stops working when it expires.
        v-row(dense align="center")
          v-col(cols="5")
            v-select(v-model="hours" :items="durations" label="Valid for" dense outlined hide-details)
          v-col
            v-btn(color="primary" depressed block :loading="linking" :disabled="!info.links.enabled" @click="makeLink")
              v-icon(left) mdi-link-variant
              | Create link
        p.hint(v-if="!info.links.enabled") Set STREAM_SECRET on the server to enable stream links.
        v-text-field(v-if="link" :value="link.url" readonly dense outlined hide-details class="mt-3" append-icon="mdi-content-copy" @click:append="copy(link.url)")
        .hint(v-if="link") Expires {{ link.expires | when }}

        v-divider.my-4
        .section-label Cloud storage
        p.hint(v-if="!info.storage.enabled") No cloud is configured. Set up Google Drive (rclone) or ownCloud on the server.
        template(v-else)
          p.hint Uploads the file to your cloud and returns a public link.
          v-btn(v-for="t in info.storage.targets" :key="t.name" outlined class="mr-2 mb-2" :loading="uploading === t.name" @click="upload(t.name)")
            v-icon(left) mdi-cloud-upload-outline
            | {{ t.label }}
          template(v-if="cloud")
            v-text-field(:value="cloud.url" label="Share page" readonly dense outlined hide-details class="mt-2" append-icon="mdi-content-copy" @click:append="copy(cloud.url)")
            v-text-field(v-if="cloud.directUrl" :value="cloud.directUrl" label="Direct audio link (for players)" readonly dense outlined hide-details class="mt-3" append-icon="mdi-content-copy" @click:append="copy(cloud.directUrl)")
      v-card-actions
        v-spacer
        v-btn(text @click="$emit('close')") Close
</template>

<script lang="ts">
  import Vue from 'vue';
  import api, { errorMessage } from '../api';
  import { info } from '../providers';
  import { notify } from '../notify';
  import { copyText } from '../clipboard';

  export default Vue.extend({
    name: 'ShareDialog',
    props: { clip: { type: Object, default: null } },

    data: () => ({
      info,
      hours: 24,
      durations: [
        { text: '1 hour', value: 1 }, { text: '24 hours', value: 24 },
        { text: '7 days', value: 168 }, { text: '30 days', value: 720 },
      ],
      link: null as null | { url: string; expires: string },
      cloud: null as null | { url: string; directUrl?: string },
      linking: false,
      uploading: '',
    }),

    computed: {
      clipId(): string { return this.clip ? this.clip.id : ''; },
    },

    watch: {
      // Reset only when a different clip is opened; refreshed data for the same clip must not clear the link.
      clipId: {
        immediate: true,
        handler() {
          this.link = null;
          this.cloud = this.clip && this.clip.cloud ? this.clip.cloud : null;
        },
      },
    },

    filters: {
      when: (iso: string) => new Date(iso).toLocaleString(),
    },

    methods: {
      async makeLink() {
        this.linking = true;
        try {
          this.link = (await api.post(`/clips/${this.clip.id}/link`, { hours: this.hours })).data;
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.linking = false;
        }
      },
      async upload(target: string) {
        this.uploading = target;
        try {
          this.cloud = (await api.post(`/clips/${this.clip.id}/share`, { target })).data;
          this.$emit('changed');
          notify('Uploaded', 'success');
        } catch (e) {
          notify(errorMessage(e), 'error');
        } finally {
          this.uploading = '';
        }
      },
      async copy(text: string) {
        notify((await copyText(text)) ? 'Copied' : 'Could not copy; select the text instead', 'info');
      },
    },
  });
</script>

<style lang="scss" scoped>
.share-title { word-break: break-word; font-size: 1.1rem; }
.section-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; opacity: 0.6; margin-bottom: 4px; }
.hint { font-size: 0.85rem; opacity: 0.7; margin: 4px 0 8px; }
</style>
