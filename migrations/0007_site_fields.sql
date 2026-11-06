-- What the site needs from the recorder (site plan, Task 2). Additive: two new columns, nothing else.

-- A change's counts against the version before it, as JSON: {"blocks":{"added","removed","changed"},
-- "facts":{...}|null,"layout_only":bool}. NULL for a baseline, and until the out-of-band fill computes it.
ALTER TABLE versions ADD COLUMN delta_json TEXT;

-- The R2 key of the version's 640 by 400 thumbnail (thumbs/<id>.jpg), or NULL when it has none.
ALTER TABLE versions ADD COLUMN thumb_key TEXT;
