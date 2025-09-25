# SAV Relationship Explorer (Static Prototype)

This folder contains a static portal for browsing the generated SAV scene-graph
relationship JSON files. It is designed to be deployed to a static host such as
Vercel and does **not** depend on the original Flask server.

The UI mirrors the core features of the in-lab visualization:

- Manifest-driven list of available videos
- Interactive vis-network graph that animates the active relationships per frame
- Playback controls (play/pause, step, scrubber, speed)
- Category toggles with the same styling as the internal tool
- Active relationship log for the current frame
- Frame URL previews using the public Google Cloud bucket the lab exported

Frames are fetched from the lab-provided bucket at
`https://storage.googleapis.com/oe-training-jamesp-public/data/sam-v/sav_train/...`
and every video exposes its companion `metadata.json` (fps, frame count). If the
endpoint moves, regenerate the manifest with updated templates and redeploy.

## Directory Structure

```
portal/
  app.js            # Client-side logic (fetches manifest, renders UI, animates graph)
  index.html        # Static entry page
  styles.css        # Styling (responsive, light/dark aware)
  public/
    manifest.json   # Generated manifest describing available videos
    sav_rels/       # Per-video relationship JSON copies (one to one with source files)
```

## Regenerating the Public Assets

Use the helper script to copy the latest generated relationships into `public/`
and rebuild `manifest.json`:

```bash
python3 scripts/build_portal_assets.py \
  --source /gscratch/krishna/wisdomik/vsg_data/weka/oe-training-default/jamesp/data/sam-v/sav_train/sav_000/saved_rels \
  --output portal/public \
  --frame-template "https://storage.googleapis.com/oe-training-jamesp-public/data/sam-v/sav_train/{split}/{video_id}/frame{frame:04d}.png" \\
  --metadata-template "https://storage.googleapis.com/oe-training-jamesp-public/data/sam-v/sav_train/{split}/{video_id}/metadata.json"
```

- The script mirrors every `sav_*.json` into `portal/public/sav_rels/`
- The manifest records the relations URL plus fully-qualified frame/metadata URL templates
- Rerun the script whenever you regenerate predictions or if the hosting endpoint changes

## Local Preview

Any static HTTP server is sufficient for local testing:

```bash
cd portal
python3 -m http.server 5173
```

Then open <http://localhost:5173> and interact with the controls—no Python
backend is required.

## Deploying to Vercel

1. Point the Vercel project root at the `portal/` directory.
2. Select the **Static Site** (no build command) template.
3. Ensure the `public/` directory is included in the deployment output.
4. The manifest already encodes the public Google Storage frame endpoints under
   `https://storage.googleapis.com/oe-training-jamesp-public/data/sam-v/...` and
   their companion `metadata.json` files. If the lab relocates assets, rerun
   `build_portal_assets.py` with new `--frame-template` / `--metadata-template`
   values before redeploying.

## Next Improvements

- Surface additional metadata (object labels, evaluation metrics) if desired.
- Add richer metadata (object labels, evaluation metrics) if desired.
- Extend the network view to support side-by-side comparisons or semantic
  filters once additional data is available.
