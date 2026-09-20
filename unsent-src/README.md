# The offline Unsent Project app sources

Everything here feeds `tools/build-unsent-app.py`, which writes `unsent.html`
(the Apps/Tools tile) and its `deploy-static/` copy. Nothing in the built page
touches the network.

## Where each file came from

Captured 2026-09-13 from the live site, mostly out of a browser HAR
(`theunsentproject.com_Archive [26-09-13 14-48-52].har`):

| File | Source |
| --- | --- |
| `shell.html` | the site's server-rendered page for `/`, with the Next.js, tag-manager, ad and error-reporting tags removed and its images swapped for placeholders |
| `app.js` | ported from its client bundle: the canvas card renderer (module 3498/210/9941), the colour schemes (7244), the filter panel and heading copy (index page chunk) |
| `posts.json` | `tools/fetch-unsent-archive.py`, which pages the site's own API |
| `assets/site.css` | `/_next/static/css/4a3915b2e66d70ce.css` |
| `assets/template.png` | `/template.png`, the 440x496 card frame stamped over every card |
| `assets/tup-logo.jpg`, `assets/tup-typing.gif` | the two logos the page shows |
| `assets/favicon.ico` | `/favicon.ico` |

The API (`https://app-api.theunsentproject.com/postsonly`) answers only to
`Access-Control-Allow-Origin: https://theunsentproject.com`, so a copy served
from anywhere else cannot call it. That is why the posts are bundled.

## What the port keeps and what it drops

Kept: the card rendering maths (440x496, 44px arial message wrapped to seven
lines at 359px, 33px arial name at x=107, background fill under the template,
name on top), the palette and per-colour text colour, the filter list and its
order, the headings, the 45-per-page infinite scroll with its 250ms beat, and
the age gate (remembered in `localStorage`).

Dropped: Google Tag Manager, AdSense, Sentry, the Typekit and Google Fonts
lookups, the one WordPress-era background image in the stylesheet, and every
call to the live API. Search runs on the bundled snapshot, so `searchType=message`
works here even though the live API returns nothing for it.

## Refreshing

Assets are re-fetched automatically when missing, and the snapshot comes from
the API, so a refresh is:

```
python tools/fetch-unsent-archive.py head     # the recent end, ~2 min
python tools/fetch-unsent-archive.py extra    # every colour + deep seeks, ~4 min
python tools/build-unsent-app.py
```

Deep offsets are slow (the API does an unindexed OFFSET scan, around 10s a
page), which is why the harvest is split into two passes: `head` walks the
first 5,400 posts, `extra` takes one page per colour plus a few far-out seeks.
Runs merge into `posts.json` by post id.
