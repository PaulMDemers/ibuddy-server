# Validation

October 5, 2026: Linux x86-64, Node 24, physical i-Buddy `1130:0002`, using interface 1 through Docker's explicitly mapped USB node.

- Six automated test cases passed, including protocol fixtures, preserving LEDs during motion, actuator release on failure, reset cancellation, cooldown, LED expiry, strict HTTP validation and bearer-token checks.
- The device accepted every eight-byte setup/output transfer for red, green, blue, purple and off head colors, heart on/off, two wing flaps, short left/right pulses and final reset. USB delivery was checked independently of the later physical demonstration.
- A slower attended demonstration cycled all seven head colors, blinked the heart three times, flapped the wings three times and briefly turned left/right, then reset. The owner confirmed that all physical controls worked well on October 5, 2026.
- Live API checks passed for one-second LED expiry, rejection of overlapping controls, interrupting a flap with reset, immediate motor cooldown rejection, unauthorized status rejection and LAN health access. Final commanded state was all-off/neutral (`FF`).
- Docker stopped gracefully with exit code 0 and reopened/reset the physical USB device on restart. A separate container with no USB device mapping continued serving health and rejected controls with HTTP 503.
- `npm audit --omit=dev` reported zero known dependency vulnerabilities at validation time.

Unplug/replug with a changed USB bus address and host reboot recovery were not physically exercised. Update/recreate the mapped container if the node changes. Runtime traces, local credentials and host-specific configuration stay outside the public repository.

## Bounded alerts — October 5, 2026

Nine automated tests now pass, adding asynchronous alert completion, total delay bounds, motor idle cleanup, reset/shutdown cancellation, HTTP 202/bounds/busy behavior and status during a native USB transfer. The live integration initially exposed usb 3.x native borrow errors when status accessed USB getters during a transfer. Connection/location metadata is now cached in JavaScript while idle; a regression fixture deliberately throws on every native getter during status reads.

After that fix, a five-second alert accepted with an action id, completed, and reported LEDs off and motors idle. A second live alert was cancelled through reset while running, also ending idle. Dashboard-side scheduling survived service recreation. These checks validate acknowledged USB commands and API outcomes; the owner has not separately confirmed the physical alarm pattern. The earlier owner-confirmed individual controls remain documented above.


## Attention dance — October 5, 2026

Eleven automated tests pass. Dance coverage checks the full 25,000 ms delay budget, five phrases, seven head colors, two flaps and alternating turns per phrase, 4,200 ms motor rest, all-off completion, reset cancellation, HTTP acceptance/strict empty body, and independent alert/dance outcomes. The alert profile retains its earlier behavior through the shared routine runner.

A full dance was invoked through the dashboard and reached the completed outcome with accepted USB outputs. A separate dance was stopped through the dashboard during execution; the outputs returned to off/idle. This documents USB/API results; the owner has not separately confirmed this physical choreography.

## Multiple figures — October 5, 2026

Seventeen Node tests pass. New fixtures use three figures with mixed supported product ids and cover discovery/removal/reappearance, stable port ids despite address changes, independent targeting, shared group start/id, concurrent-request rejection, all-device reset, partial startup cancellation before motors move, per-device failure outcomes, authenticated inventory and strict target validation. An unopened native USB handle can report address zero; Linux sysfs resolves its actual address before generating explicit Docker node mappings, with a regression test. The hardware-check script now prints each member's output.

Two physical figures (products 0001 and 0002) were opened and reset through separately mapped Docker USB nodes. A dashboard-triggered full 25-second group dance completed on both under one action id. A second group dance was cancelled with dashboard Stop; both members reported cancelled and acknowledged all-off/idle. These are USB/API observations; owner confirmation of simultaneous physical choreography remains pending. No additional host USB permissions or privileged container mode were introduced. More than two physical figures, changed-port/replug and host reboot scenarios remain unverified; arbitrary count is covered with simulated three-device tests.

## Automatic USB mapping recovery — October 6, 2026

27 Node tests pass. See [USB_RECOVERY.md](USB_RECOVERY.md) for timer installation, state, recovery timing, maintenance reservation, tests and live validation. An intentionally incomplete mapping recovered both attached figures automatically; an active individual dance completed before recreation. A second live recovery exercised the idle reservation and rejection of a new dance. Physical unplug/replug and full host reboot remain untested; systemd timer enablement and lingering configuration are verified. The owner confirmed both figures danced successfully on October 6 after the earlier manual mapping repair.
