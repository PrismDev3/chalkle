# Proxies in Chalkle

The Proxies tab ships with a seed list of real open-source proxies, all self-hosted:

- **Ultraviolet** - Titanium Network. Node. `https://github.com/titaniumnetwork-dev/Ultraviolet-App`
- **Scramjet** - Mercurial. Node/Express. `https://github.com/Mercurial-cc/Scramjet`
- **Rammerhead** - Shadows Network. Node. `https://github.com/binary-person/rammerhead`
- **Nebula** - Nebula Services. Astro/Node. `https://github.com/NebulaServices/Nebula`
- **Interstellar** - Interstellar Network. Express/Snowflake. `https://github.com/InterstellarNetwork/Interstellar`
- **Womginx** - zt64. Nginx proxy, no Node needed. `https://github.com/binary-person/womginx`

Every one of these needs its own host, and that is done on purpose: shared public proxies die fast, and the school filter knows them all.

## Steps

1. Pick one, follow its README to deploy (Cloudflare, Render, Replit, Vercel, Railway all work).
2. Get a public URL like `https://your-proxy.onrender.com`.
3. In Chalkle: Proxies tab, add it with the form, or set it inline on the card.
4. That URL is saved in the browser (localStorage) and the card opens the proxy.

## Modes

- **Open in this tab** - loads the proxy in a full-screen frame inside Chalkle, back button returns to the site. Good for quick sessions.
- **Open in new tab** - some proxies (or sites inside them) refuse to run in a frame; use this mode for those.

## If a proxy is blocked

The filter fights back. Rotate hosts, keep URLs out of the visible page title and out of the README once live, and do not post the live URL anywhere public. Reload the page with a different proxy card and keep sessions short.

## Local testing

Without a host, open `index.html` and set any proxy URL in the form. It will only work for sites that allow framing, which is why the new-tab mode exists too.