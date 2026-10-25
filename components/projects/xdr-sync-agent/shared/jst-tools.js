// Resolve separately managed tools from the user's home, independent of this project's location.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const localModule = path => import(pathToFileURL(join(homedir(), path)).href);
export const { Bridge, CliError } = await localModule('jushuitan-order-page/src/bridge.js');
export const { readPage } = await localModule('jushuitan-order-page/src/page.js');
export const { sessionFromCookieHeader, saveSession, loadSession } = await localModule('jushuitan-inventory-warning/src/chrome-session.js');
export const { callApi, summaryParams } = await localModule('jushuitan-inventory-warning/src/api.js');
