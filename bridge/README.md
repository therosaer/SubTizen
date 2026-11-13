# SubTizen AirPlay bridge

A 2016 Samsung TV (Tizen 2.4) cannot be an AirPlay receiver: web apps cannot advertise over Bonjour,
open listening sockets or decode AirPlay audio. This bridge does that on another always-on machine on
your network and hands the result to the SubTizen app over plain HTTP.

```
iPhone / Mac --AirPlay--> shairport-sync --PCM--> ffmpeg --MP3--> GET /stream.mp3
                                  |                         `----> GET /stream.wav (raw PCM)
                                  `--metadata--> GET /status , GET /cover
```

The bridge is independent of your Subsonic/Navidrome server. You can run it on the same box for
convenience, but nothing connects the two.

## Requirements

- Node.js 16+ (no npm packages)
- [shairport-sync](https://github.com/mikebrady/shairport-sync) built with the `stdout` backend and
  metadata support (the Arch, Debian and Fedora packages are; AirPlay 2 builds work)
- `ffmpeg` with libmp3lame
- A running Avahi (Linux) or Bonjour (macOS) daemon so devices can find it
- If the machine already runs another AirPlay receiver (including a system `shairport-sync`), start the
  bridge with its own port: `--airplay-port 7001`. The bridge also gives itself a different AirPlay 2
  device ID (`--device-id-offset`, default 7); without that, a phone can connect and show track info but no
  audio arrives

## Run

```bash
node bridge/subtizen-bridge.js --name SubTizen
```

| Option | Env | Default |
|---|---|---|
| `--port` | `BRIDGE_PORT` | `5100` (HTTP port the TV talks to) |
| `--name` | `BRIDGE_NAME` | `SubTizen` (name shown in the AirPlay menu) |
| `--airplay-port` | `BRIDGE_AIRPLAY_PORT` | shairport-sync default (7000) |
| `--device-id-offset` | `BRIDGE_DEVICE_ID_OFFSET` | `7` |
| `--tv-buffer` | `BRIDGE_TV_BUFFER` | `1s`. How much the TV's player buffers before playing: `1s`, `500ms`, `32768b`, `16kb` |
| `--tv-format` | `BRIDGE_TV_FORMAT` | `mp3`, or `wav` (uncompressed) for the TV's player |
| `--demo` | | play a test tone instead of starting shairport-sync |
| `--debug` | `BRIDGE_DEBUG` | log audio rate, metadata items and listener backlog |
| | `BRIDGE_BITRATE` | `192k` |

`subtizen-bridge.service` is a ready-made systemd user unit.

## Firewall

Devices must be able to reach this machine. If it runs a firewall (for example `ufw`), allow your local
network, otherwise the TV shows "Bridge not reachable" and phones show "unable to connect". AirPlay 2 also
uses random high ports and UDP 319/320, so opening single ports is not enough:

```bash
sudo ufw allow from 192.168.0.0/24
```

(use your own network range). The bridge logs the first request from each device, and
`journalctl -k | grep "UFW BLOCK"` shows what the firewall is dropping.

## Point the TV at it

On SubTizen's connect screen fill in **AirPlay bridge** (for example `http://192.168.0.10:5100`; the port is
the bridge's `--port`, not the AirPlay port). Left blank, the app assumes the bridge is on the same host as
the Subsonic server, port 5100. Later, the username icon in the nav bar reopens these settings. Then open
the **AirPlay** tab.

When someone casts to "SubTizen", the app switches to the AirPlay tab on its own, pauses the Subsonic queue
and plays the stream with artwork, title, artist and a progress bar. Starting a Subsonic track later hands
playback back. Pausing on the phone keeps the track on screen; the tab returns to "Ready for AirPlay" when
the phone disconnects.

## HTTP API

All responses carry `Access-Control-Allow-Origin: *`.

- `GET /status`: `{ name, tv: { bufferUnit, bufferAmount, format }, state: idle|playing|paused, client, title, artist, album, duration, position, cover }`
- `GET /stream.mp3`: endless MP3 stream. Silence is sent while nothing is playing so listeners stay connected
- `GET /stream.wav`: the same audio uncompressed (44-byte WAV header claiming unknown length, then 44.1 kHz
  16-bit stereo PCM)
- `GET /cover?v=N`: current cover art (JPEG/PNG)

## The delay

On a 2016 Samsung TV the audio is about **3-4 seconds** behind the phone. The bridge hands audio to the TV
within a fraction of a second; the rest is the TV player's own buffering, which the app cannot see or reduce
further. Settings tried on a UE32K5502 (all through Samsung's AVPlay player): `mp3`/1 s about 3-4 s (the
default and the best), `wav`/1 s about 4 s, `mp3`/500 ms worse, `mp3`/16 KB about 15 s. The TV's plain
`<audio>` element buffers about 20 s, which is why the app uses AVPlay.

## Limits

- Fine for music, not for video: the delay is several seconds.
- Play, pause, skip and volume are driven from the phone. iPhones give an AirPlay 2 receiver no way to send
  commands back, so the TV remote's play/pause only mutes or unmutes the stream on the TV.
- Lossy: the AVPlay stream is MP3.
- The bridge has no authentication; keep it on your LAN.

## Testing

`node bridge/test.js` checks the metadata parser and state machine. `node bridge/subtizen-bridge.js --demo`
serves a test tone and fake metadata so the TV app can be tried without a phone.
