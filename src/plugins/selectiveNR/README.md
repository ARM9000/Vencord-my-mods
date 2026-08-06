# SelectiveNR

Per-user noise gate for Discord voice channels.

Right-click any user in a VC → **Suppress** to apply a noise gate to their audio stream. Right-click again → **Unsuppress** to restore audio. Suppressed state is per-session(no local saving)

## How it works

A noise gate state machine runs on a 50 ms tick. Speaking state comes from Discord's `SpeakingStore`; when a suppressed user starts talking the gate opens (attack), holds, then closes again (release) once they stop. The gain is applied by driving that user's local volume, with their pre-suppression volume saved so it can be restored. Unsuppressed users are never touched.

## Settings

| Setting | Description | Default |
|---|---|---|
| Attack | How fast the gate opens when someone speaks (ms) | 5 ms |
| Release | How fast the gate closes after they stop (ms) | 120 ms |
| Hold | Extra time to keep gate open after signal drops — prevents word clipping (ms) | 200 ms |
| Reduction | Gain applied when gate is closed (dBFS) | -100 dB |

## Usage

1. Join a voice channel
2. Right-click any user in the member list
3. Click **Suppress** — their background noise will be gated
4. Click **Unsuppress** to restore their audio

## Author

ARM9000
