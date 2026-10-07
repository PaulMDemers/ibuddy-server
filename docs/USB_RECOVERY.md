# Automatic USB recovery on Linux

The optional host timer keeps the Docker API's explicit USB mappings aligned with attached i-Buddies. It recognizes only VID `1130`, PIDs `0001` and `0002`. Adding figures, changing ports and changed USB addresses are handled without manually editing Compose. No host USB permission changes or privileged container mode are needed.

## Install

First configure and build the API normally, using the README. The host needs Node 24+, the local Docker daemon at `/var/run/docker.sock`, Docker Compose, systemd user services, and an account already authorized to use Docker. The host scripts use Node built-ins and read sysfs; they do not open USB devices or require the `usb` native dependency.

```bash
node scripts/install-usb-recovery.js
loginctl enable-linger "$USER"
systemctl --user start ibuddy-usb-recovery.service
systemctl --user status ibuddy-usb-recovery.timer
```

The installer writes user service/timer files with the absolute repository and Node paths and enables the timer. Re-run it if either path changes (including removal of an old NVM Node version). Lingering starts the user's systemd manager at boot and keeps it running after logout; Docker must also be enabled at boot. Enabling lingering may require administrator authorization on other hosts. The timer starts ten seconds after the user manager starts and checks fifteen seconds after each service run. Recovery runs as the existing Docker-authorized user, with `NoNewPrivileges` and a restrictive umask. It has no Docker socket mount inside the API container.

## Behavior

The checker reads supported devices from `/sys/bus/usb/devices` and their character nodes under `/dev/bus/usb`. Its fingerprint includes port/product, bus address, node inode/device number and creation-change timestamp. This detects a replaced node even when the same USB address is reused. It compares the result with the running container's actual device mappings, not only the Compose file.

A change must remain stable across two samples. Normal idle recovery starts in roughly 15–35 seconds, plus container startup time. Changes while a routine is active are deferred until it finishes. The bearer-protected `POST /api/maintenance` endpoint accepts `{}` and atomically reserves an idle fleet for thirty seconds: it returns 409 if busy, and new commands receive 503 while reserved. Status reports `busy: true` and `maintenanceUntil`; reset and status remain available. The host reserves before recreation, closing the race with a newly started routine. If recreation fails, the reservation expires automatically.

An unreachable running API receives a 75-second grace period before recreation, allowing a bounded routine to expire. Authentication errors defer recovery rather than triggering restart. Docker failure backs off for thirty seconds; subsequent timer runs retry. The helper uses the local Docker socket explicitly and never emits expanded Compose configuration or token values. An absent container is left absent; a stopped container with unchanged mappings is left stopped. Changed mappings may start a stopped container, so disable the timer for maintenance.

Recovery atomically replaces ignored `compose.usb.yaml` with just the current supported nodes, then recreates only the API from its existing local image (`--no-build --pull never`). A stable empty inventory removes stale mappings and keeps a no-device API serving health; returning figures are mapped on subsequent samples. LED outputs reset to off during recreation. Accepted or failed dances/alarms are never replayed. A scheduled alarm falling during recovery may fail; the dashboard records that outcome rather than retrying movement.

Runtime bookkeeping is `runtime/usb-recovery.json` (ignored, mode 600 inside a mode-700 directory). It is not a schedule or credential store. Removing it resets the comparison baseline; mismatched mapped addresses still recover, but a same-address node replacement needs a prior generation baseline. Do not delete it routinely.

## Operate

```bash
journalctl --user -u ibuddy-usb-recovery.service -n 30 --no-pager
systemctl --user list-timers ibuddy-usb-recovery.timer
# Check now through systemd, which serializes service invocations:
systemctl --user start ibuddy-usb-recovery.service
# Pause before maintenance or intentionally stopping/removing the API:
systemctl --user disable --now ibuddy-usb-recovery.timer
systemctl --user stop ibuddy-usb-recovery.service
docker compose stop
# Resume after maintenance:
systemctl --user enable --now ibuddy-usb-recovery.timer
```

Use the installer to re-enable after moving/upgrading Node. Stop the timer before manually changing USB mappings or replacing the API. If `.env` credentials change, the helper reads the new file each run; rotate the dashboard token copy too. If a USB node is inaccessible even after mapping repair, inspect the hardware connection and Docker/API logs. Recovery repairs mappings; it does not power-cycle a failed USB port.

## Validation

October 6, 2026: 27 Node tests pass. Recovery fixtures cover sysfs filtering, address/node generations, stable debounce, two-device mappings, all-unplugged/returning inventory, busy and unreachable grace periods, failure backoff, absent/stopped containers, protected atomic writes, and a new routine racing the idle check. API tests cover reservation, busy rejection, per-device/group command guards, lease expiry and fresh-handle retry after a temporary open failure. The live tests exposed a figure resetting during restart; idle discovery now retries disconnected figures with newly discovered handles, rather than retaining a failed handle indefinitely. Transient zero-address sysfs readings defer the host scan until enumeration settles.

A live Docker container was deliberately recreated with only one of two attached figures mapped. The timer noticed the mismatch, deferred while the reachable figure ran a bounded dance, then automatically recreated the API and reopened both figures. The reachable figure completed its dance before recreation. A second live stale-mapping check passed with the maintenance reservation enabled; an attempted dance during reservation returned 503. The timer and lingering are enabled, and unit validation passes. A physical unplug/replug and full host reboot have not been exercised for this release; boot configuration is verified, not a reboot outcome.

References: [Docker device isolation and runtime configuration](https://docs.docker.com/engine/containers/run/), [systemd timers](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html), [loginctl lingering](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html).
