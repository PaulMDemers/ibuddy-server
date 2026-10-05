import {Fleet} from './fleet.js';
import {createApi} from './http-api.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8082);
const token = process.env.API_TOKEN || '';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && token.length < 24) throw new Error('A non-loopback HOST requires API_TOKEN of at least 24 characters');
const controller = new Fleet();
try { await controller.refresh(); } catch (error) { console.error('Startup USB connection:', error.message); }
const server = createApi(controller, {token});
server.listen(port, host, () => console.log(`i-Buddy API listening on ${host}:${port}; USB connected=${controller.status().connectedCount}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; shutdown(); });
const discovery = setInterval(() => controller.refresh().catch(error => console.error('USB discovery:', error.message)), 5000);
discovery.unref();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(discovery);
  server.close();
  try { await controller.close(); } catch (error) { console.error('Shutdown reset:', error.message); }
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
