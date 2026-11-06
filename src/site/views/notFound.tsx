// The ledger's 404 (unknown page, version or route) and the page shown when a screen fails.
import type { Stats } from "../../readModel";
import { Layout } from "../layout";

export function NotFound(props: { stats: Stats | null }) {
  return (
    <Layout
      title="No such page in the ledger · Fineprint"
      description="Fineprint has no record at this address."
      stats={props.stats}
      current={null}
    >
      <div class="wrap lost">
        <h1>No such page in the ledger.</h1>
        <p class="lede">Nothing is recorded at this address. The link may be mistyped, or the page may not be one Fineprint watches.</p>
        <p class="actions">
          <a class="btn" href="/">
            See the latest changes
          </a>
        </p>
      </div>
    </Layout>
  );
}

/** A screen could not be read: said plainly, with the way back, and without touching the database again. */
export function ServerError() {
  return (
    <Layout title="Something went wrong · Fineprint" description="Fineprint could not show this page." stats={null} current={null}>
      <div class="wrap lost">
        <h1>This page could not be shown.</h1>
        <p class="lede">Reading the ledger failed. Nothing recorded is lost. Try again in a minute.</p>
        <p class="actions">
          <a class="btn" href="/">
            See the latest changes
          </a>
        </p>
      </div>
    </Layout>
  );
}
