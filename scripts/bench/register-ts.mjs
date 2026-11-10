import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./resolve-ts.mjs', import.meta.url), pathToFileURL('./'));
