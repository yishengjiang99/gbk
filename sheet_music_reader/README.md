# Sheet Music Reader

Dependency-free JavaScript port of the first-pass "Sweden" MIDI transcription.

## CLI

```sh
npm run generate
node ./cli.js ./sweden_photo_transcription.mid
```

## Browser

```sh
npm run serve
```

Then open `http://127.0.0.1:8765/public/`.

The browser page imports the same `src/swedenMidi.js` module and downloads the generated MIDI as `sweden_photo_transcription.mid`.
