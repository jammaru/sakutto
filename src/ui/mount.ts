import { mount, type Component } from 'svelte';
import { t, uiLocaleTag } from '@/shared/i18n';
import '@/ui/tokens.css';
import '@/ui/base.css';

export function mountPage(app: Component): void {
  document.documentElement.lang = uiLocaleTag();
  document.title = t('extensionName');

  const target = document.getElementById('app');
  if (!target) throw new Error('App root element is missing.');

  mount(app, { target });
}
