# i-Buddy USB protocol

Research checked October 5, 2026 against the independently maintained [py3buddy driver](https://github.com/armijnhemel/py3buddy/blob/632aba521897ba15c79e11f21325fcc0393fd814/py3buddy/py3buddy.py) and [ibuddy technical notes](https://github.com/pbrier/ibuddy/blob/524c2773e5604f80d3b249a024e0e5c2473e452a/ibuddy/TECHNICAL). This server is a new Node implementation; upstream applications are not bundled.

The tested figures use VID `0x1130`, PIDs `0x0001` and `0x0002`, with two HID interfaces. The pinned py3buddy driver above lists both variants with the same report protocol; other listed variants are not automatically selected here. Output goes to interface 1. Each command sends a setup report followed by an output report through a class/interface OUT control transfer: `bmRequestType=0x21`, `bRequest=0x09`, `wValue=0x0002`, `wIndex=1`. Each payload is eight bytes:

```text
Setup:   22 09 00 02 01 00 00 00
Output:  55 53 42 43 00 40 02 XX
Reset:   55 53 42 43 00 40 02 FF
```

The ninth leading zero shown in HIDAPI examples is their report-ID prefix; it is not included in these control-transfer payloads.

| Bits in XX | Meaning |
| --- | --- |
| 7 | Heart LED: 0 on, 1 off |
| 6, 5, 4 | Blue, green, red head LEDs respectively; each is active low |
| 3–2 | Wings: 01 up, 10 down, 11 neutral/reset |
| 1–0 | Torso: 01 left, 10 right, 11 reset; 00 has variant/previous-position-dependent centering behavior |

The API starts and ends with `FF` and does not expose raw bytes or persistent actuator drive. Reset is an all-off/neutral command, not a guarantee of a geometric center position. There is no physical-state sensor readback implemented by this API: a successful command means both USB transfers accepted all eight bytes.

The transport uses the current [`usb` v3 WebUSB API](https://github.com/node-usb/node-usb-rs), including bounded control-transfer timeouts and Linux interface claiming/detachment. The locked version is `3.2.1`. A USB timeout or partial write rejects the request and closes the handle; the next request can reopen/reset it if the configured device node remains accessible.
