import { defineConfig } from 'wxt';

const fixtureHostPermissions =
  process.env.SAKUTTO_FAKE_ENGINE === '1' || process.env.SAKUTTO_E2E_REAL === '1'
    ? ['http://127.0.0.1/*', 'http://localhost/*']
    : null;

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  imports: false,
  manifestVersion: 3,
  vite: () => ({
    define: {
      __SAKUTTO_FAKE_ENGINE__: JSON.stringify(process.env.SAKUTTO_FAKE_ENGINE === '1'),
    },
  }),
  manifest: {
    name: '__MSG_extensionName__',
    short_name: '__MSG_extensionShortName__',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    minimum_chrome_version: '116',
    permissions: [
      'offscreen',
      'storage',
      'unlimitedStorage',
      'activeTab',
      'scripting',
      'contextMenus',
    ],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // Release builds ask for site access only when auto-translate is turned on.
    // The e2e build may script the local fixtures directly.
    ...(fixtureHostPermissions ? { host_permissions: fixtureHostPermissions } : {}),
    commands: {
      'translate-page': {
        suggested_key: { default: 'Alt+A' },
        description: '__MSG_commandTranslate__',
      },
      'toggle-bilingual': {
        suggested_key: { default: 'Alt+B' },
        description: '__MSG_commandBilingual__',
      },
      'translate-selection': {
        suggested_key: { default: 'Alt+S' },
        description: '__MSG_commandSelection__',
      },
      'translate-compose': {
        // Chrome accepts at most four suggested_key commands. If this command has no
        // key, the page uses the あA button and the context menu rather than stealing Alt+T.
        suggested_key: { default: 'Alt+T' },
        description: '__MSG_commandCompose__',
      },
    },
    cross_origin_embedder_policy: { value: 'require-corp' },
    cross_origin_opener_policy: { value: 'same-origin' },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
