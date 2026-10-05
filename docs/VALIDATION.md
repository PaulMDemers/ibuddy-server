# Validation

October 5, 2026: Linux x86-64, Node 24, physical i-Buddy `1130:0002`, using interface 1 through Docker's explicitly mapped USB node.

- Six automated test cases passed, including protocol fixtures, preserving LEDs during motion, actuator release on failure, reset cancellation, cooldown, LED expiry, strict HTTP validation and bearer-token checks.
- The device accepted every eight-byte setup/output transfer for red, green, blue, purple and off head colors, heart on/off, two wing flaps, short left/right pulses and final reset. This proves successful USB delivery; independent physical observation is still needed to confirm visible LEDs and mechanical behavior.
- Live API checks passed for one-second LED expiry, rejection of overlapping controls, interrupting a flap with reset, immediate motor cooldown rejection, unauthorized status rejection and LAN health access. Final commanded state was all-off/neutral (`FF`).
- Docker stopped gracefully with exit code 0 and reopened/reset the physical USB device on restart. A separate container with no USB device mapping continued serving health and rejected controls with HTTP 503.
- `npm audit --omit=dev` reported zero known dependency vulnerabilities at validation time.

Unplug/replug with a changed USB bus address and host reboot recovery were not physically exercised. Update/recreate the mapped container if the node changes. Runtime traces, local credentials and host-specific configuration stay outside the public repository.
