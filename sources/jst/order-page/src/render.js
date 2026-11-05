import { readFileSync } from 'node:fs';
import { writePrivate } from './storage.js';

export function render(snapshot, path) {
  const template = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const json = JSON.stringify(snapshot).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return writePrivate(path, template.replace('/*SNAPSHOT*/null', () => json));
}
