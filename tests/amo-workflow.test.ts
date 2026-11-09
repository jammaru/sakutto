import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/amo.yml', import.meta.url), 'utf8');
const action = readFileSync(
  new URL('../.github/actions/package-extension/action.yml', import.meta.url),
  'utf8',
);
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

describe('AMO workflow', () => {
  it('signs only from workflow_dispatch and never from push', () => {
    const trigger = workflow.slice(workflow.indexOf('on:'), workflow.indexOf('concurrency:'));
    expect(trigger).toContain('workflow_dispatch:');
    expect(trigger).not.toContain('push:');
    expect(trigger).not.toContain('pull_request:');
    expect(trigger).not.toContain('tags:');
    expect(workflow).toContain('secrets.AMO_JWT_ISSUER');
    expect(workflow).toContain('secrets.AMO_JWT_SECRET');
    expect(workflow).toContain('--channel listed');
    expect(workflow).toContain('--upload-source-code');
    expect(workflow).toContain('amo-metadata.json');
    expect(workflow).not.toMatch(/run:.*\$\{\{\s*secrets\./);
  });

  it('packages Firefox through the shared action', () => {
    expect(action).toContain('target:');
    expect(action).toContain('default: chrome');
    expect(action).toContain('pnpm zip:firefox');
    expect(action).toContain('pnpm lint:firefox');
    expect(action).toContain('pnpm source:firefox');
    expect(action).toContain('scripts/compare-extension-builds.ts');
    expect(action).toContain('src/engine/wllama/firefox-webgpu-kick.ts');
    expect(ci).toContain('target: [chrome, firefox]');
    expect(ci).toContain('target: ${{ matrix.target }}');
    expect(ci).toMatch(/checks:\n {4}needs: changes\n {4}runs-on:/);
    expect(ci).not.toContain('package-firefox');
    expect(ci).not.toContain('web-ext sign');
    expect(ci).not.toContain('AMO_JWT');
    expect(packageJson).toContain('"build:firefox"');
    expect(packageJson).toContain('"zip:firefox"');
    expect(packageJson).toContain('"source:firefox"');
  });
});
