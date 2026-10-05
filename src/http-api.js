import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {ApiError} from './controller.js';
import {HEAD_BITS} from './protocol.js';

function auth(header, token) {
  if (!token) return true;
  const provided = Buffer.from(header || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function fields(body, allowed) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new ApiError(400, 'Expected a JSON object');
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'Unknown field');
}
function number(value, fallback, min, max, name) {
  value = value === undefined ? fallback : value;
  if (!Number.isInteger(value) || value < min || value > max) throw new ApiError(400, `${name} must be ${min}–${max}`);
  return value;
}
function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'Use application/json');
  return new Promise((resolve, reject) => {
    let text = '', bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4096) { reject(new ApiError(413, 'Body too large')); return; }
      text += chunk.toString();
    });
    req.on('end', () => { try { resolve(JSON.parse(text)); } catch { reject(new ApiError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}
export function createApi(controller, {token = ''} = {}) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') {
        res.end(JSON.stringify({ok: true, deviceConnected: controller.device.connected})); return;
      }
      if (!auth(req.headers.authorization, token)) {
        res.setHeader('WWW-Authenticate', 'Bearer'); throw new ApiError(401, 'Bearer token required');
      }
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new ApiError(403, 'Invalid Origin'); }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new ApiError(403, 'Foreign Origin rejected');
      }
      if (req.method === 'GET' && path === '/api/status') { res.end(JSON.stringify(controller.status())); return; }
      const allowed = ['/api/head', '/api/heart', '/api/flap', '/api/turn', '/api/alert', '/api/reset'];
      if (!allowed.includes(path)) throw new ApiError(404, 'Unknown endpoint');
      if (req.method !== 'POST') throw new ApiError(405, 'Use POST');
      const input = await body(req);
      let result;
      if (path === '/api/head') {
        fields(input, ['color', 'ttlSeconds']);
        if (typeof input.color !== 'string' || !Object.hasOwn(HEAD_BITS, input.color)) throw new ApiError(400, 'Unknown head color');
        result = await controller.leds({head: input.color}, number(input.ttlSeconds, 60, 1, 120, 'ttlSeconds') * 1000);
      } else if (path === '/api/heart') {
        fields(input, ['on', 'ttlSeconds']);
        if (typeof input.on !== 'boolean') throw new ApiError(400, 'on must be boolean');
        result = await controller.leds({heart: input.on}, number(input.ttlSeconds, 60, 1, 120, 'ttlSeconds') * 1000);
      } else if (path === '/api/flap') {
        fields(input, ['count', 'intervalMs']);
        result = await controller.flap(number(input.count, 3, 1, 5, 'count'), number(input.intervalMs, 150, 100, 250, 'intervalMs'));
      } else if (path === '/api/turn') {
        fields(input, ['direction', 'durationMs']);
        if (!['left', 'right'].includes(input.direction)) throw new ApiError(400, 'direction must be left or right');
        result = await controller.turn(input.direction, number(input.durationMs, 200, 50, 400, 'durationMs'));
      } else if (path === '/api/alert') {
        fields(input, ['durationSeconds']);
        result = await controller.alert(number(input.durationSeconds, 30, 5, 60, 'durationSeconds'));
        res.statusCode = 202;
      } else {
        fields(input, []); result = await controller.reset();
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error.status || 503;
      if (res.statusCode === 429) res.setHeader('Retry-After', '2');
      if (!error.status) console.error('Device/API error:', error.message);
      res.end(JSON.stringify({error: error.status ? error.message : 'USB device unavailable; check server logs and connection'}));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return server;
}
