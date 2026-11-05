import { canonicalLanguage, isChromeOnlyLanguage } from '@/shared/languages';

/** Short labels that show up on many sites. Cached once so a later visit skips inference. */
const ENGLISH_UI = [
  'Sign in',
  'Log in',
  'Sign up',
  'Log out',
  'Settings',
  'Search',
  'Home',
  'Next',
  'Previous',
  'Learn more',
  'Read more',
  'Cancel',
  'Close',
  'Menu',
  'Save',
  'Download',
] as const;

const JAPANESE_UI = [
  'ログイン',
  '設定',
  '検索',
  'ホーム',
  '次へ',
  '戻る',
  '閉じる',
  'キャンセル',
  '保存',
  '詳細',
] as const;

export interface PrewarmRequest {
  src: string;
  segments: { id: string; text: string }[];
}

export function prewarmRequest(target: string): PrewarmRequest | null {
  const language = canonicalLanguage(target);
  if (!language || isChromeOnlyLanguage(language)) return null;

  const lines = language === 'en' ? JAPANESE_UI : ENGLISH_UI;
  return {
    src: language === 'en' ? 'ja' : 'en',
    segments: lines.map((text, index) => ({ id: `ui-${String(index)}`, text })),
  };
}
