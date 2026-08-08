# Face-Touch Alarm

A tiny web app that watches your webcam and buzzes whenever your hand touches
your face. It opens a small floating window (Document Picture-in-Picture) so the
detection keeps running while you work in other tabs.

Everything runs in your browser. No server, and no video ever leaves your machine.

## Files

```
index.html   the page and its structure
style.css    all styling
app.js       all the logic (camera, detection, buzzer, floating window)
```

That's the whole app — three files, plus this README.

## How it works

1. The camera feed goes into a `<video>` element.
2. Two MediaPipe models run on each frame: one finds your **face** (a box),
   one finds your **hands** (21 points each). They load from a CDN, so the
   first start needs an internet connection.
3. If any hand point lands inside the face box, that's a touch → the buzzer's
   volume turns on. When your hand leaves, it turns off.
4. The whole live view is moved into a floating always-on-top window, and the
   detection loop runs on *that* window's animation frames — which is why it
   keeps working when your main tab is hidden.

## Run it

**Browser:** Chrome or Edge (the floating-window feature is Chromium-only).

Camera access needs a secure page, which means either `https://` or
`localhost` — opening the file directly from your disk (`file://`) won't work.

- **Quick local test:** from this folder run `python3 -m http.server`, then
  open `http://localhost:8000`.
- **Live:** deploy to GitHub Pages (steps below — it's served over HTTPS).

## Deploy to GitHub Pages

Same flow as a normal static site:

1. Put these files in the repo (the root, or a `/docs` folder).
2. Commit and push from VS Code.
3. On GitHub: **Settings → Pages → Build and deployment**, set **Source** to
   *Deploy from a branch*, pick your branch and the folder you used, and save.
4. Wait a moment, then open the URL GitHub gives you and click **Start watching**.

## Tuning

Open `app.js` and edit the settings block near the top:

- `FACE_PADDING` — bigger = a touch registers from further away.
- `RELEASE_DELAY_MS` — how long the buzz lingers after your hand leaves.
- `BUZZ_FREQUENCY` / `BUZZ_VOLUME` — the sound of the buzzer.
