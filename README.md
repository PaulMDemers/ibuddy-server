# i-Buddy Server

Node.js REST API for the MSN i-Buddy USB figure: head colors, heart light, wing flapping and torso turns. Linux/Docker hardware support is tested with vendor `1130`, product `0002`; other variants are deliberately not selected automatically. Node 24+, one dependency (`usb`, pinned in the lockfile), no cloud service.

## Start with Docker on Linux

Find the device's bus/address with `lsusb`, then configure its `/dev/bus/usb/BBB/DDD` path. For example, Bus 001 Device 010 means `/dev/bus/usb/001/010`.

```bash
cp .env.example .env
chmod 600 .env
# Edit .env: set USB_DEVICE and replace API_TOKEN with a random secret.
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
docker compose up -d --build --wait
curl http://127.0.0.1:8082/health
```

Compose publishes on localhost by default. Set `BIND_IP=0.0.0.0` in your local `.env` for LAN access; all control/status endpoints require `Authorization: Bearer <API_TOKEN>`. Keep that file out of Git and do not expose the service to the Internet. `/health` is unauthenticated and reports API availability and whether the server has opened a USB connection.

The container gets only the configured USB device, with no privileged mode and all capabilities dropped. It runs as root **inside the container** because the host's USB node is normally owned by root; it has a read-only root filesystem, no host source/credential mounts, limited logs, and restarts with Docker. Only i-Buddy interface 1 is claimed; its HID kernel driver is temporarily detached if necessary and reattached on graceful close. No sudo or host-wide USB permission changes are needed for this deployment.

```bash
docker compose logs --tail=20
docker compose stop  # reset all outputs, release USB, then stop
docker compose start --wait
```

USB bus addresses may change after unplug/replug or reboot. If the mapped node changes, update `USB_DEVICE` and run `docker compose up -d --force-recreate --wait`. The API remains available with an absent/inaccessible device; commands return 503. It retries opening the selected device on the next command, but a changed Docker device mapping requires recreation. Test a reboot on your own host before relying on unattended USB reconnection.

## API

All POST bodies are JSON objects, including `{}` for reset. Unknown fields, wrong types, oversized bodies and invalid bounds are rejected before USB writes. Foreign browser Origins are rejected. Responses describe the last acknowledged output command, **not measured physical LED or actuator state**. Head LEDs offer on/off RGB combinations, not analog brightness or arbitrary RGB.

| Method/path | JSON body | Behavior |
| --- | --- | --- |
| GET `/health` | — | API health and USB connection flag; no token |
| GET `/api/status` | — | Last commanded state, busy flag, LED expiry and motor cooldown |
| POST `/api/head` | `{"color":"purple","ttlSeconds":60}` | off, red, green, blue, yellow, cyan, purple/magenta, white |
| POST `/api/heart` | `{"on":true,"ttlSeconds":60}` | Heart light on/off |
| POST `/api/flap` | `{"count":3,"intervalMs":150}` | 1–5 flaps; 100–250 ms per wing phase, with 100 ms idle gaps |
| POST `/api/turn` | `{"direction":"left","durationMs":200}` | left/right pulse, 50–400 ms, then actuator idle |
| POST `/api/reset` | `{}` | Cancel the current action, LEDs off, actuators idle |

LED `ttlSeconds` defaults to 60 and accepts 1–120. Any LED command renews the **combined head/heart lease**; both turn off at its expiry. Motion preserves LED settings and returns both actuators to idle even on cancellation/failure when USB still responds. Movement commands have a two-second cooldown after completion; repeat motion receives 429 with `Retry-After: 2`. Overlapping commands receive 409 instead of being queued. Reset can interrupt motion. Physical centering is not guaranteed by the reset byte.

Example with Node's env-file support (no token printed or embedded in command history):

```bash
node --env-file=.env --input-type=module - <<'JS'
const response = await fetch('http://127.0.0.1:8082/api/head', {
  method: 'POST',
  headers: {'content-type': 'application/json', authorization: `Bearer ${process.env.API_TOKEN}`},
  body: JSON.stringify({color: 'blue', ttlSeconds: 15})
});
console.log(response.status, await response.json());
JS
```

## Hardware check and tests

```bash
npm ci
npm test
node --env-file=.env scripts/hardware-check.js
```

The hardware check visibly cycles head colors, lights the heart, flaps twice, and briefly turns each direction, then resets. It waits for readiness before starting and never retries a motion command automatically. Observe the device while running it. `API_URL` can point it at another LAN server. Automated tests use a fake USB transport and cover known protocol bytes, actuator release, cancellation, cooldown, LED expiry, auth, JSON validation and unavailable-device responses.

[Upstream reports a device overheating during testing](https://github.com/armijnhemel/py3buddy). This server limits movement duration and repetition and expires LEDs, but does not measure temperature. Keep hardware checks attended; unplug if an actuator sticks, the device heats up, or USB fails while movement is active. Forced kill, host power failure or broken USB communication can prevent the shutdown reset.

## Run directly

```bash
npm ci
npm start
```

Direct execution defaults to `127.0.0.1:8082`; set `HOST`, `PORT` and `API_TOKEN` as needed. A non-loopback `HOST` requires a token of at least 24 characters. Direct USB access needs appropriate host permissions, unlike the scoped Docker deployment. On Linux you may install `docs/99-ibuddy.rules` using an administrator, reload udev rules and reconnect the device. That optional rule grants access only to this VID/PID for `plugdev`; it is not installed automatically.

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for transfer details and research references. MIT licensed; `.env`, dependencies, logs and runtime validation records are excluded from Git.
