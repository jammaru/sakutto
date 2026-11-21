/** Replaced at build time. The e2e build translates in the page instead of loading the model. */
declare const __SAKUTTO_FAKE_ENGINE__: boolean;

declare module '*.txt?raw' {
  const contents: string;
  export default contents;
}
