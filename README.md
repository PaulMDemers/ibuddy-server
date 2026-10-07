# i-Buddy Server

Node.js REST API for any number of MSN i-Buddy USB figures: head colors, heart light, wing flapping, torso turns and bounded flashing/movement alerts and dances. Linux/Docker hardware support is tested with vendor `1130`, products `0001` and `0002`. Each figure has its own controller; group routines share a start barrier and action id. Node 24+, one dependency (`usb`, pinned in the lockfile), no cloud service.

## Start with Docker on Linux

Attach the figures, install the pinned host dependency for discovery, and generate an explicit Docker mapping for each supported figure:

```bash
cp .env.example .env
chmod 600 .env
# Edit .env: replace API_TOKEN with a random secret.
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm ci
node scripts/configure-usb.js
docker compose up -d --build --wait
curl http://127.0.0.1:8082/health
```

Compose publishes on localhost by default. Set `BIND_IP=0.0.0.0` in your local `.env` for LAN access; all control/status endpoints require `Authorization: Bearer <API_TOKEN>`. Keep that file out of Git and do not expose the service to the Internet. `/health` is unauthenticated and reports API availability and whether the server has opened a USB connection.

The discovery script writes ignored `compose.usb.yaml` and sets `COMPOSE_FILE` in the local `.env`. The container gets only the listed USB nodes, with no privileged mode and all capabilities dropped. It runs as root **inside the container** because the host's USB node is normally owned by root; it has a read-only root filesystem, no host source/credential mounts, limited logs, and restarts with Docker. Only i-Buddy interface 1 is claimed; its HID kernel driver is temporarily detached if necessary and reattached on graceful close. No sudo or host-wide USB permission changes are needed for this deployment.

```bash
docker compose logs --tail=20
docker compose stop  # reset all outputs, release USB, then stop
docker compose start --wait
```

For automatic add/replug/reboot mapping repair, install the optional [USB recovery timer](docs/USB_RECOVERY.md). Without that timer, regenerate the device mapping and recreate the container after adding/removing a figure or changing USB nodes:

```bash
node scripts/configure-usb.js
docker compose up -d --force-recreate --wait
```

The API discovers devices every five seconds when idle, and on inventory/control requests. The optional host recovery timer handles changed Docker mappings independently. Device ids use USB bus, port topology and product id; address changes at the same port keep the id, moving ports changes it. Identical figures are distinguished by their ports because they have no serial number. Direct Node execution can discover newly attached accessible figures without container recreation. Docker still needs regeneration for new/changed nodes. The API stays available when USB devices are absent/inaccessible; controls return 503. No recognized devices makes the mapping script fail while preserving the old mapping. Host reboot/replug recovery still requires physical verification.

## API

Unqualified `/api/*` controls apply to **all present supported figures**. For one figure, use `/api/devices/:id/head`, `/heart`, `/flap`, `/turn`, `/alert`, `/dance` or `/reset`, with the same command body except no `target` field. All POST bodies are JSON objects, including `{}` for reset. Unknown fields, wrong types, oversized bodies and invalid bounds are rejected before USB writes. Foreign browser Origins are rejected. Responses describe the last acknowledged output command, **not measured physical LED or actuator state**. Head LEDs offer on/off RGB combinations, not analog brightness or arbitrary RGB.

| Method/path | JSON body | Behavior |
| --- | --- | --- |
| GET `/health` | — | API health and USB connection flag; no token |
| GET `/api/status` | — | Aggregate connectivity, device counts, busy/cooldown, group outcomes and per-device states |
| GET `/api/devices` | — | Refresh discovery and return the same fleet inventory/status |
| GET `/api/devices/:id/status` | — | Status of one present figure; 404 for unknown/disconnected ids |
| POST `/api/head` | `{"color":"purple","ttlSeconds":60}` | off, red, green, blue, yellow, cyan, purple/magenta, white |
| POST `/api/heart` | `{"on":true,"ttlSeconds":60}` | Heart light on/off |
| POST `/api/flap` | `{"count":3,"intervalMs":150}` | 1–5 flaps; 100–250 ms per wing phase, with 100 ms idle gaps |
| POST `/api/turn` | `{"direction":"left","durationMs":200}` | left/right pulse, 50–400 ms, then actuator idle |
| POST `/api/alert` | `{"durationSeconds":30}` | Start a flashing/movement alert, 5–60 seconds; HTTP 202 with action id |
| POST `/api/dance` | `{"target":"all"}` or `{}` | Start a fixed 25-second attention-getting dance; HTTP 202 with action id |
| POST `/api/reset` | `{}` | Cancel the current action, LEDs off, actuators idle |
| POST `/api/maintenance` | `{}` | Reserve an idle fleet for mapping recovery for 30 seconds; 409 while busy |

LED `ttlSeconds` defaults to 60 and accepts 1–120. Any LED command renews the **combined head/heart lease**; both turn off at its expiry. Motion preserves LED settings and returns both actuators to idle even on cancellation/failure when USB still responds. Movement commands have a two-second cooldown after completion; repeat motion receives 429 with `Retry-After: 2`. Overlapping commands receive 409 instead of being queued. Reset can interrupt motion. Physical centering is not guaranteed by the reset byte.

Alerts default to 30 seconds and run asynchronously while holding the controller lock. They alternate red/blue head flashes and the heart light, with a short wing flap and alternating left/right turn each three-second cycle. Each wing phase and turn lasts 150 ms; motors remain idle for over two seconds between bursts. Duration counts animation delays; USB transfer overhead adds a little time. Completion and reset finish with all LEDs off and motors idle. `activeAction` reports the running alert id/type/start/duration; `lastAlert` reports the latest id and `completed`, `cancelled` or `failed` outcome. Poll status to follow an accepted alert; 202 means started, not physically measured completion. Reset and graceful shutdown cancel alerts. Scheduling and persistence belong to the caller; this USB API does not store schedules or repeat failed requests.

The dance uses five different five-second phrases: seven changing head colors and heart flashes, two 150 ms wing flaps, and one 200 ms alternating left/right turn per phrase. Motors rest for 4.2 seconds between bursts. Its 25 seconds of animation delays plus USB overhead normally fit within 20–30 seconds. It shares alert cancellation, exclusive access, cooldown and final all-off cleanup. `activeAction.type` is `dance`; `lastDance` tracks its outcome separately so it never overwrites `lastAlert`. Global dance accepts `{}` or `{"target":"all"}`; global alert additionally accepts `target: "all"`. Individual dance accepts `{}`. Duration and raw motor commands for dance are not caller-configurable.

Group routines preflight all present controllers, acknowledge initial LEDs on every figure, then release the shared motion start barrier. Failure to start one cancels every started member before motion begins. A later failure is reported per device while responding members finish their bounded routine. `activeAction.deviceIds` identifies the participants; `lastDance`/`lastAlert` include aggregate outcome and per-device results. Global reset cancels all present figures; reset failure on one still attempts every other figure. Per-device routines can run independently; global commands reject when any member is busy or cooling down. These APIs do not impose a fixed device-count limit.

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

The hardware check operates on **all mapped figures**, visibly cycles head colors, lights the heart, flaps twice, and briefly turns each direction, then resets. It waits for readiness before starting and never retries a motion command automatically. Observe the device while running it. `API_URL` can point it at another LAN server. Automated tests use a fake USB transport and cover known protocol bytes, actuator release, cancellation, cooldown, LED expiry, auth, JSON validation and unavailable-device responses.

[Upstream reports a device overheating during testing](https://github.com/armijnhemel/py3buddy). This server limits movement duration and repetition and expires LEDs, but does not measure temperature. Keep hardware checks attended; unplug if an actuator sticks, the device heats up, or USB fails while movement is active. Forced kill, host power failure or broken USB communication can prevent the shutdown reset.

## Run directly

```bash
npm ci
npm start
```

Direct execution defaults to `127.0.0.1:8082`; set `HOST`, `PORT` and `API_TOKEN` as needed. A non-loopback `HOST` requires a token of at least 24 characters. Direct USB access needs appropriate host permissions, unlike the scoped Docker deployment. On Linux you may install `docs/99-ibuddy.rules` using an administrator, reload udev rules and reconnect the device. That optional rule grants access only to these two VID/PIDs for `plugdev`; it is not installed automatically.

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for transfer details and research references. MIT licensed; `.env`, dependencies, logs and runtime validation records are excluded from Git.
