#!/usr/bin/env node
import { watchOnce } from '../src/failure-watch.js';
try { console.log(JSON.stringify({ at: new Date().toISOString(), failure_watch: await watchOnce() })); }
catch { console.error(JSON.stringify({ at: new Date().toISOString(), failure_watch: { error: 'watch_failed' } })); process.exitCode = 1; }
