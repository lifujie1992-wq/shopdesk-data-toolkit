// Produce a static candidate catalog from loaded page functions. Does not invoke candidates.
import { Bridge } from '../src/bridge.js';
import { writePrivate } from '../src/storage.js';
const b = new Bridge();
await b.connect();
const result = await b.run(function () {
  const frames = [];
  function walk(w) { try { if (/\/app\/order\/order\/(list|OrderEditorNew)\.aspx/i.test(w.location.pathname)) frames.push(w); for (let i=0;i<w.frames.length;i++) walk(w.frames[i]); } catch {} }
  walk(window);
  return frames.map(w => {
    const calls = [];
    for (const name of Object.keys(w)) {
      try {
        if (typeof w[name] !== 'function') continue;
        const source = String(w[name]);
        for (const m of source.matchAll(/\b(_ACP|_ACPHW|_ACU|_ACUHW)\s*\(\s*["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/g)) {
          calls.push({ function: name, helper: m[1], endpoint: m[1].startsWith('_ACU') ? m[2] : w.location.pathname, method: m[1].startsWith('_ACU') ? (m[3] || '<dynamic>') : m[2], evidence: 'static_function_reference_only', runtime_verified: false });
        }
      } catch {}
    }
    return { page: w.location.pathname, calls };
  });
}, {});
const output = writePrivate(new URL('../INTERFACE-CANDIDATES.json', import.meta.url).pathname, JSON.stringify({ generated_at: new Date().toISOString(), note: 'Static references include write operations. No candidate is authorized for invocation by this catalog. See ARCHAEOLOGY.md for verified reads.', pages: result }, null, 2) + '\n');
console.log(JSON.stringify({ output, pages: result.map(p => ({ page: p.page, references: p.calls.length })) }));
