# Chalkle static deploy folder (Vercel / Netlify)

This folder is the whole site in one static bundle. Upload it as-is to
Vercel or Netlify and the site works: 1,020 games are embedded in
index.html as data URIs, and every server-backed feature (music, cloud,
AI, Live TV, YouTube) routes to the relay at chalkle.lootline.xyz because
the mirror detector now recognizes vercel.app and netlify.app hosts.

Contents:
- index.html            the full single-file build (53 MB, self-contained)
- bg-chalk.webp         page background (referenced as a sibling file)
- apple-touch-icon.png  touch icon
- tabs/*.webp           per-tab chalk backdrops (CSS backgrounds)
- assets/hls.min.js     HLS player for Live TV

## Deploy to Netlify (easiest, drag and drop)
1. Go to https://app.netlify.com/drop
2. Drag this folder onto the page.
3. Netlify assigns a URL like https://<random>.netlify.app.
4. Optional: Site settings > Change site name to a neutral slug.

## Deploy to Vercel
Option A, drag and drop:
1. Go to https://vercel.com/new
2. Click "Deploy" on the blank template, then drag this folder in.
3. Vercel assigns a URL like https://<name>.vercel.app.

Option B, CLI:
```
npm i -g vercel
vercel login
cd deploy-static
vercel --prod
```

## After deploying
- Open the URL and confirm the app boots past the cover screen.
- Music / Cloud / AI / Live TV pull from the relay, so they work without
  any backend on the static host.
- Regenerate this folder after any source change:
  node scripts/build-single-chalkle.mjs
  (then copy build/chalkle-single.html to deploy-static/index.html plus
  the sibling assets above, or re-run the copy commands).

## Notes
- The folder is ~56 MB because every game and thumbnail is embedded. The
  first load is heavy on slow connections; the browser caches it after.
- Local game folders (ugs/, mc/, game-builds/) are not included. Games
  that need sibling asset folders stay embedded only if they fit the
  single-file cap; the rest point at paths served by the main site.
- The built-in /uv/ proxy cannot exist on a static host (it probes and
  turns itself off). Saved proxy URLs from the Proxies tab still work.