import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const locales = [
  'de',
  'en',
  'es',
  'fr',
  'id',
  'it',
  'ja',
  'ko',
  'pt_BR',
  'ru',
  'th',
  'vi',
  'zh_CN',
  'zh_TW',
];

for (const locale of locales) {
  const path = join(ROOT, `public/_locales/${locale}/messages.json`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const ocr = data.onboardingOcrNote;
  const reading = data.pdfOcrReading;
  if (ocr) {
    ocr.message = ocr.message.replace(/\$1\b/g, '$SIZE$').replace(/\(\$1\)/g, '($SIZE$)');
    ocr.placeholders = { size: { content: '$1' } };
  }
  if (reading) {
    reading.message = reading.message
      .replace(/\$1 of \$2/g, '$PAGE$ of $TOTAL$')
      .replace(/\$1\/\$2/g, '$PAGE$/$TOTAL$');
    reading.placeholders = {
      page: { content: '$1' },
      total: { content: '$2' },
    };
  }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}