# Winamp skin assets — attribution

The files in `src/winamp/skin/` are taken from the
[webamp](https://github.com/captbaritone/webamp) project
("Winamp 2 reimplemented for the browser"):

- `base-skin.css`
- `main-window.css`
- `playlist-window.css`

Copyright (c) Jordan Eldredge (captbaritone), MIT License.

```
MIT License

Copyright (c) 2017 Jordan Eldredge

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Only the presentation layer (CSS skin sprites + layout) is reused. None of
webamp's audio, playback, or state-management code is included: all transport,
playlist, synthesis, and scheduling behavior in this app remains our own
custom SF2/MIDI engine.
