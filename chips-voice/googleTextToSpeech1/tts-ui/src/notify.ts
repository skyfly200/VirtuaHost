import Vue from 'vue';

// One app-wide toast: notify('Saved', 'success').
export const toast = Vue.observable({ show: false, text: '', color: 'info' });

export function notify(text: string, color: 'success' | 'info' | 'warning' | 'error' = 'info') {
  toast.text = text;
  toast.color = color;
  toast.show = true;
}
