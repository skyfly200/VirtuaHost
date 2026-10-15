import Vue from 'vue';
import Vuetify from 'vuetify/lib';

Vue.use(Vuetify);

let dark = true;
try { dark = window.localStorage.getItem('chipsvoice.dark') !== 'false'; } catch (e) { /* default dark */ }

export default new Vuetify({
  icons: { iconfont: 'mdi' },
  theme: {
    dark,
    options: { customProperties: true },
    themes: {
      dark: {
        primary: '#8B7CFF',
        secondary: '#22D3EE',
        accent: '#F472B6',
        success: '#34D399',
        warning: '#FBBF24',
        error: '#FB7185',
        background: '#0B1020',
        surface: '#151B31',
      },
      light: {
        primary: '#5B4BFF',
        secondary: '#0891B2',
        accent: '#DB2777',
        success: '#059669',
        warning: '#D97706',
        error: '#E11D48',
        background: '#F4F5FB',
        surface: '#FFFFFF',
      },
    },
  },
});
