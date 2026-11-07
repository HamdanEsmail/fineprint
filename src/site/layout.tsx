// The document every screen shares: head (the title and description, also as og: tags for link previews,
// styles, the two preloaded fonts, the optional enhance.js), the header (wordmark, stamp, nav) and the footer
// (the spend meter). No inline script or style element: the CSP allows only files from this origin, and every
// screen works without the script.
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { Stats } from "../readModel";
import { Notice, Stamp } from "./components";
import { spendMeter, stampFor } from "./format";

type Current = "home" | "watchlist" | "about" | null;

const NAV: { key: Exclude<Current, null>; href: string; text: string }[] = [
  { key: "home", href: "/", text: "Changes" },
  { key: "watchlist", href: "/watchlist", text: "Watchlist" },
  { key: "about", href: "/about", text: "About" },
];

/**
 * A full page. `stats` is null on the 404 and error pages, which render without the database: the
 * stamp and the spend meter are left out there, and the footer keeps only its links. `refreshSeconds`
 * makes the document reload itself (the page view, while a new version's screenshot is being taken);
 * it is a meta tag, so it works with JavaScript off. `noindex` keeps a screen out of search engines (the
 * watchlist answering a form or a search).
 */
export function Layout(props: {
  title: string;
  description: string;
  stats: Stats | null;
  current: Current;
  refreshSeconds?: number;
  noindex?: boolean;
  children: Child;
}) {
  const { stats } = props;
  const stamp = stats === null ? null : stampFor(stats);
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          {props.refreshSeconds === undefined ? null : <meta http-equiv="refresh" content={String(props.refreshSeconds)} />}
          <title>{props.title}</title>
          <meta name="description" content={props.description} />
          <meta property="og:title" content={props.title} />
          <meta property="og:description" content={props.description} />
          {props.noindex ? <meta name="robots" content="noindex" /> : null}
          <meta name="theme-color" content="#f3eee4" />
          <link rel="preload" href="/assets/fonts/fraunces-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="stylesheet" href="/assets/tokens.css" />
          <link rel="stylesheet" href="/assets/site.css" />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <script src="/assets/enhance.js" defer></script>
        </head>
        <body>
          <a class="skip" href="#main">
            Skip to the content
          </a>
          {stats?.spend_paused ? (
            <Notice>Spending is paused at the budget line. Changes the Monitors report are still recorded, without screenshots or price tables.</Notice>
          ) : null}
          <header class="top">
            <div class="wrap">
              <a class="wordmark" href="/">
                Fineprint{" "}
                {stamp ? <Stamp text={stamp.text} live={stamp.live} /> : null}
              </a>
              <nav aria-label="Main">
                <ul>
                  {NAV.map((item) => (
                    <li>
                      <a href={item.href} aria-current={props.current === item.key ? "page" : undefined}>
                        {item.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </header>
          <main id="main">{props.children}</main>
          <footer>
            <div class="wrap">
              {stats ? <p class="meterline">{spendMeter(stats)}</p> : null}
              <ul>
                <li>
                  <a href="/api/export.json">Download everything as JSON</a>
                </li>
                <li>
                  <a href="/about">How it works</a>
                </li>
              </ul>
            </div>
          </footer>
        </body>
      </html>
    </>
  );
}
