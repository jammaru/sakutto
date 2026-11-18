import { defineConfig } from 'wxt';
import { reproducibleEntryStylesheets } from './scripts/reproducible-entry-stylesheets.ts';
import {
  CHROME_PERMISSIONS,
  FIREFOX_PERMISSIONS,
  MAIL_HOST_PATTERNS,
  OPTIONAL_HOST_PERMISSIONS,
  commandSuggestions,
  firefoxGeckoSettings,
} from './src/shared/manifest';

const fixtureHostPermissions =
  process.env.SAKUTTO_FAKE_ENGINE === '1' || process.env.SAKUTTO_E2E_REAL === '1'
    ? [
        'http://127.0.0.1/*',
        'http://localhost/*',
        'https://x.com/*',
        'https://www.x.com/*',
        // Mail hosts are runtime optional in the release build. The e2e fixture build grants
        // them at install so the banner specs can open mail pages without a native prompt.
        ...MAIL_HOST_PATTERNS,
      ]
    : [];

const hostPermissions = [...new Set(fixtureHostPermissions)];

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  imports: false,
  manifestVersion: 3,
  vite: () => ({
    // Vite picks the order of the injected <link rel="stylesheet"> tags per HTML entry from a
    // cache shared across entries and filled by whichever entry finishes transforming first,
    // so the same commit can zip differently between runs. The plugin normalizes each entry's
    // tags to the order its own chunk graph defines.
    plugins: [reproducibleEntryStylesheets()],
    define: {
      __SAKUTTO_FAKE_ENGINE__: JSON.stringify(process.env.SAKUTTO_FAKE_ENGINE === '1'),
    },
  }),
  manifest: ({ browser }) => {
    const firefox = browser === 'firefox';
    return {
      name: '__MSG_extensionName__',
      short_name: '__MSG_extensionShortName__',
      description: '__MSG_extensionDescription__',
      default_locale: 'en',
      ...(firefox ? {} : { minimum_chrome_version: '116' }),
      permissions: [...(firefox ? FIREFOX_PERMISSIONS : CHROME_PERMISSIONS)],
      optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
      // Release builds ask for no install-time host access. Mail banners, like YouTube
      // captions, request their origin at runtime and register their scripts after a grant.
      // The e2e fixture build may script the local and mail fixtures directly.
      host_permissions: hostPermissions,
      commands: commandSuggestions(firefox ? 'firefox' : 'chrome'),
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: firefoxGeckoSettings(),
            },
          }
        : {
            cross_origin_embedder_policy: { value: 'require-corp' },
            cross_origin_opener_policy: { value: 'same-origin' },
          }),
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
      },
      icons: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
      // folder-enable.html is opened only as a top-level extension tab (tabs.create). It must
      // not appear in web_accessible_resources with use_dynamic_url, or Chrome blocks the static
      // runtime.getURL() used for that tab (ERR_BLOCKED_BY_CLIENT).
      web_accessible_resources: [],
    };
  },
});
