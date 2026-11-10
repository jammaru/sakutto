/**
 * Pages cited by the PLaMo Community License itself. Article 3 names the registration form,
 * and the bundled copies in `licenses/` name the license pages they were copied from.
 */
export const PLAMO_OFFICIAL_LINKS = {
  registration: 'https://forms.gle/mTL8tBLrMYXKNZD56',
  licenseJa: 'https://plamo.preferredai.jp/info/plamo-community-license-ja',
  licenseEn: 'https://plamo.preferredai.jp/info/plamo-community-license-en',
} as const;

/** The extension's own pages: the privacy policy and the source repository. */
export const PROJECT_LINKS = {
  privacy: 'https://jammaru.com/sakutto/privacy/',
  source: 'https://github.com/jammaru/sakutto',
  localServerDocs: 'https://github.com/jammaru/sakutto/blob/main/docs/design/mlx-backend.md',
} as const;
