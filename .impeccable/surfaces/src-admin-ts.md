---
version: 1
slug: "src-admin-ts"
primary_target: "src/admin.ts"
related_targets: ["src/admin.css","src/token-worker.ts"]
---

# Admin document browser

Scope: `/admin` on the Access-protected token Worker. Mode: Operate.
Operators browse indexed documents, filter by ID prefix, open an exact ID,
and inspect live metadata. The interface is read-only.

## Direction contract

THESIS: An archive index makes document identity and its recorded state easy
to compare. Refuse decorative dashboard metrics and invented health labels.

OWN-WORLD: Deep teal navigation, cool green ground, white table surface, pale
green selection, and dark teal text. System UI typography stays compact;
monospace is reserved for IDs, hashes, and exact measurements.

STORY: See the directory's coverage limit, find a document, select it, then
read sequence state, summary state, connections, and logical storage capacity.
Direct ID lookup also discovers older documents.

FIRST VIEWPORT: A compact teal header above the page title and directory
coverage note. A wide document table occupies the left; a selected-record
panel occupies the right. Prefix filtering sits over the table. Exact lookup
is a separate labeled form. The signature is a three-part capacity strip
separating used bytes, writable capacity, and cleanup reserve. Native links
and GET forms work without JavaScript. Selection changes the URL; narrow
screens stack the detail panel after the list and jump to its anchor.
Motion is limited to a brief selection-surface transition, disabled when
reduced motion is requested.

FORM: Municipal archive finding aid, grounded candidate 4, seed ec7e7d92.
Other grounded candidates: engineering change record, transit wayfinding,
specimen catalog, atlas marginalia, reference manual index, component catalog.
Raised by the specimen's numeric alignment, the inlay's finite capacity,
the timetable's scan rhythm, the guide map's clear selection, and the
convention catalog's density.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Constraints: Reuse verified Access identity and its configured audience.
No new frontend dependencies, secrets in browser output, document mutation,
cloud deployment, fabricated data, or DDS inspection. Untouched legacy
documents cannot be enumerated. List pages are bounded; only the selected
document is queried for live metadata.
