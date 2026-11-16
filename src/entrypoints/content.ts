import { defineContentScript } from 'wxt/utils/define-content-script';
import { contentMain } from '@/content/main';

export default defineContentScript({
  registration: 'runtime',
  main: contentMain,
});
