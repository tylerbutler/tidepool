---
name: Tidepool Admin
description: A compact archive index for finding documents and inspecting recorded server state.
colors:
  ink: "#183e40"
  muted: "#476664"
  shell: "#163f42"
  ground: "#e9f0ed"
  surface: "#ffffff"
  detail: "#f2f8f4"
  selected: "#d5eadc"
  line: "#c5d6ce"
  accent: "#236751"
  focus: "#b44d22"
  used: "#216451"
  free: "#c4dece"
  reserve: "#96722c"
typography:
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 650
    lineHeight: 1.2
  headline-compact:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.7rem"
    fontWeight: 650
    lineHeight: 1.2
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.08rem"
    fontWeight: 650
    lineHeight: 1.4
  section-title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 650
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 600
    lineHeight: 1.5
  metadata:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.5
  table-label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 600
    lineHeight: 1.5
  helper:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.55
  mono-id:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.5
  selected-id:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  strip: "2px"
  control: "4px"
  coverage: "5px"
  panel: "6px"
spacing:
  space-4: "4px"
  space-6: "6px"
  space-8: "8px"
  space-10: "10px"
  space-12: "12px"
  space-16: "16px"
  space-20: "20px"
  space-24: "24px"
  space-28: "28px"
  space-36: "36px"
  space-40: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-primary-hover:
    backgroundColor: "#194d3d"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-secondary-hover:
    backgroundColor: "#e9f3ec"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    width: "100%"
  navigation:
    backgroundColor: "{colors.shell}"
    textColor: "{colors.surface}"
  read-only:
    backgroundColor: "#dcebe1"
    textColor: "#254f40"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  directory:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
  lookup:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "20px 24px 24px"
  detail:
    backgroundColor: "{colors.detail}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
  directory-row:
    textColor: "{colors.ink}"
    padding: "16px 24px"
  directory-row-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
  capacity:
    rounded: "{rounded.strip}"
    height: "16px"
    width: "100%"
---

# Design System: Tidepool Admin

## Overview

**Creative North Star: "Archive index"**

Tidepool's admin interface is a municipal archive finding aid translated into a compact operator UI. Identity and recorded state take precedence over decoration: deep teal navigation grounds a cool-green workspace, white directory and lookup surfaces separate finding from inspection, and a pale-green detail surface holds the selected record.

This is an Operate system for ordinary desktop/browser screens in ambient work lighting. Standard system UI typography is deliberate, not a placeholder for a display face. The implementation is code-led, server-rendered HTML and CSS, with native links, GET forms, inline SVG, no JavaScript, and no shipping raster assets. The reusable visual signature is a finite, three-part logical-capacity strip, not a decorative dashboard metric.

**Key Characteristics:**
- Compact, readable operator typography with tabular numerals.
- Flat, bordered surfaces distinguished by green tonal layers.
- Explicit selection through surface color, text, and URL state.
- Native navigation and forms that remain usable without JavaScript.
- Capacity shown as measured used, writable, and cleanup-reserve portions.

Evidence: `src/admin.css` and `src/admin.ts`; current captures `.impeccable/review/desktop.png`, `mobile.png`, `empty.png`, and `notfound.png`. Product constraints come from `PRODUCT.md`; the confirmed world is `.impeccable/surfaces/src-admin-ts.md` (candidate 4, seed `ec7e7d92`). This records the implemented admin system, not an identity for unrelated project surfaces.

## Colors

A cool green neutral field supports dark teal text, a deep teal shell, and forest-green actions; warm accents have specific focus and capacity meanings. The frontmatter is the normative palette, using the shipped CSS custom-property names.

### Primary
- **Accent — forest green:** links, primary controls, text selection background, and input caret.
- **Selected — selection green:** the current directory row and the opening color of the targeted detail animation.
- **Used — capacity green:** measured logical storage already consumed.
- **Free — writable green:** the remaining normal-write portion of the capacity strip.

### Secondary
- **Reserve — cleanup ochre:** the cleanup-reserve portion and matching legend swatch; not a health grade.
- **Focus — burnt orange:** keyboard focus outlines, visually separate from the selection green.

### Neutral
- **Shell — deep teal:** navigation background.
- **Ground — cool-green ground:** the page background.
- **Surface — white:** directory, exact-ID lookup, fields, and primary-control text.
- **Detail — pale green:** selected-record and unselected-detail containers.
- **Ink — dark teal:** primary content and identifiers.
- **Muted — quiet teal:** metadata labels, helper text, and secondary timestamps.
- **Line — green-grey:** panel outlines, table headers, and internal section dividers.

Literal component-state colors remain component details rather than an invented tonal scale: primary hover darkens; secondary hover gains a light-green surface and dark text. Notices use warm cream/ochre, while request failures use pale warm-white and a muted rust border. Their exact CSS is retained in the sidecar or Components below.

Sidecar tonal ramps are synthesized for swatch previews only; they are not shipped tokens or approved new color assignments.

### Named Rules

**The Selected Record Rule.** Keep the current row green and explicitly labeled Selected; the detail surface remains pale green rather than adopting a generic elevated-card treatment.

**The Measured Color Rule.** Capacity green and ochre describe used bytes, writable bytes, and cleanup reserve; do not reinterpret them as inferred document health.

## Typography

**Heading and Body Font:** `system-ui, sans-serif`.
**Identifier Font:** `ui-monospace, SFMono-Regular, Consolas, monospace`.

**Character:** compact, familiar, and workmanlike. There is no promotional display role, imported webfont, or fixed-ratio type scale. All rem values resolve against the shipped root size (15px); numerals are tabular throughout.

### Hierarchy
- **Headline:** page heading, balanced wrapping; compact headline replaces it at the narrow breakpoint.
- **Title:** panel headings.
- **Section title:** subsections within the inspector.
- **Body:** explanatory text and controls; primary controls override the body weight to 600. Paragraphs have a default maximum measure (72ch), with the coverage explanation allowed a longer measure (90ch).
- **Label:** sentence-case field labels; parenthetical qualifications return to regular weight and muted color.
- **Metadata / table label / helper:** dense record fields, table headings, and supporting explanations respectively.
- **Mono ID / selected ID:** wrapping row IDs and metadata code; the selected record's identifier is larger and semibold.

The brand is system UI, semibold (1.25rem, 650), reducing to the title size on narrow screens. Utility text also uses observed smaller sizes: section actions (0.82rem), row actions and snapshots (0.74rem), and capacity byte annotations (0.7rem; 0.65rem on narrow screens). These are local treatments, not a new general-purpose body scale.

### Named Rules

**The Exact Identity Rule.** Use monospace for document IDs, tenant code, and hashes; retain wrapping for long values. Measurements in the shipped build use tabular system UI numerals, not the monospace measurements proposed in the direction contract.

## Layout

The header, main region, and footer share a centered maximum width (1488px). Desktop main padding is (36px 40px 24px); header gutters are (40px), with a minimum header height (76px). The heading and workspace use recurring gaps (24px). Coverage sits above the workspace with padding (16px 20px) and bottom separation (28px).

The desktop workspace is a top-aligned two-column grid (`minmax(0, 1.2fr) minmax(0, 1fr)`) with a gap (24px). The directory is wider; exact lookup precedes the detail panel in the inspector. Repeated panel insets favor (20px–24px); controls use tighter (8px) gaps and (12px–16px) padding. The spacing tokens describe observed steps, not a claim that every dimension follows one mathematical unit.

At a maximum width (1100px), the workspace becomes one column and coverage becomes a vertically stacked note with a gap (4px). The inspector becomes a column flex layout. When the detail panel is the URL target, it moves before lookup within that inspector and gains bottom separation (16px); it does not move before the directory. Lookup and detail have scroll margins (24px).

At a maximum width (560px), main gutters become (16px), main top padding becomes (28px), header gutters become (20px), and the header minimum height becomes (64px). Table row links stack ID and action; the first table column changes from (65%) to (64%). Dates and identifiers wrap rather than forcing horizontal scrolling. Panels use (20px 16px) insets; pagination and error actions may wrap. Metadata columns tighten from a (1:1.35) to a (1:1.1) ratio; capacity retains three columns.

## Elevation & Depth

There are no box shadows, hard offset shadows, lifted hover cards, or fixed overlays in this build. Depth is conveyed by the dark navigation shell, cool ground, white working surfaces, pale detail inlay, selected row, and thin borders. Those borders are native to the archive/index world and must not be prohibited as visual clutter.

### Named Rules

**The Flat Inlay Rule.** Separate working regions with tone and thin borders, not elevation; keep the selected record integrated into the workspace.

## Shapes

The form language is rectangular with restrained corner rounding: the capacity strip uses the strip radius, controls and the read-only badge use the control radius, coverage uses its intermediate radius, and panels use the panel radius. Panel and control outlines are generally (1px); navigation's active underline is (3px). The table collapses borders, uses a fixed layout, and clips within its rounded directory container.

Capacity legend swatches are small bordered squares (9px); they are semantic keys, not decorative glyph icons. The Tidepool wave mark is a real inline SVG (26px square; 22px wide on narrow screens), using three rounded strokes. No raster image treatment or image-overlay grammar is present.

## Components

### Buttons

Compact, legible rectangles, not promotional calls to action. Primary buttons use accent fill and border, white text, semibold weight (600), and a minimum height (44px). Secondary pagination links use a white surface and accent text. Hover darkens primary fill and border (`#194d3d`); secondary hover retains that darker border while using its light-green fill and ink text. Disabled buttons use opacity (0.6) and a waiting cursor; no disabled variant is currently rendered. There is no custom pressed animation.

### Inputs / Fields

White fields use a thin green-grey border (`#91ada0`), the control radius, and full available width with a minimum width (0). Placeholder text is muted (`#60766a`) at full opacity; the caret uses accent. Visible labels remain above fields with separation (8px). Prefix filtering and exact-ID lookup are distinct native GET forms; neither is a live-search control.

All keyboard-focusable elements receive the actual global `:focus-visible` treatment: an outline (3px solid focus) offset (4px). There is no focus glow, border-shift transition, or invented input error state. The skip link moves into view on focus; it is not a persistent banner.

### Navigation

A compact dark shell holds the wave mark and Tidepool home link, the current Documents link with a pale-green bottom border (`#a8d9c0`), and an underlined Sign out link (`#d3e8df`). Home and section links are white and not underlined. Ordinary content links remain underlined with an offset (0.2em); hover thickens their decoration (2px). Mobile keeps the navigation visible instead of introducing a menu.

### Read-only badge

A noninteractive status label, not a filter chip: pale-green fill, dark-green text, muted-green border (`#a8c5b5`), compact type (0.85rem), and no wrapping. Its status is also expressed in text, not just color.

### Directory / lookup / detail containers

The directory and lookup use white with the line border; detail uses its pale-green surface and a slightly stronger outline (`#b5cec0`). There are no floating card actions. The directory heading and filter share aligned insets; table headers use a lightly tinted surface (`#eff4f1`), and row separators are light green-grey (`#dde8e1`).

Rows provide a sizable ID link with a minimum height (62px). Hover tints the row (`#eff6f1`); selected fill persists on hover. The selected action becomes semibold (650), loses its underline, and says Selected; the link also carries current-state semantics. Metadata uses aligned label/value columns, with values right-aligned and allowed to wrap.

### Capacity strip

A real, proportional inline SVG spans the available width at the capacity height. Writable color underlays the strip; used bytes fill from the left; cleanup reserve occupies the right edge. The reserve is clamped to the available budget remainder by the implementation. A three-column key pairs every segment with a text label, MiB measurement, and exact bytes; the SVG has a full accessible numeric description. Do not freeze the proportions from a capture or sidecar preview into production.

When normal-write capacity is exhausted, an unrounded notice uses a cream fill (`#f7edce`), ochre border (`#b89950`), dark ochre text (`#62491a`), and padding (12px). This is a capacity condition, not an inferred service-health state.

### Empty and request-failure states

Empty directory and unselected-detail states keep their ordinary surface identities, use readable explanation text, and supply the next native action. The supplied empty capture is a no-prefix-match result, not evidence of a separate empty-state visual world. Request failures use a bordered warm-white panel (`#fff8f5`, border `#b98979`), panel radius, and padding (28px). They retain exact-ID lookup and a return-to-directory link; server failures additionally expose Try again.

### Selection motion

Only targeted detail selection animates. Under `prefers-reduced-motion: no-preference`, `:target` runs `select-record` for (360ms), with `cubic-bezier(0.16, 1, 0.3, 1)`, changing background from selected to detail. Reduced-motion users receive no animation. There are no general hover transitions, smooth-scroll behavior, translation effects, or page-load reveals.

## Do's and Don'ts

### Do:
- Do preserve the distinction between white finding surfaces, the pale-green inspector, and the explicitly selected green row.
- Do use native links, GET forms, visible labels, and the shared keyboard focus outline.
- Do retain wrapping IDs, tabular measurements, UTC timestamps, and aligned metadata values.
- Do label all three capacity portions and pair proportional color with readable numeric values.
- Do preserve useful borders and dividers; they are part of this archive's scan rhythm.

### Don't:
- Don't turn the capacity strip into decorative metrics or inferred health labels.
- Don't introduce display typography, decorative kickers, glyph icons, or lifted card styling into this compact operator system.
- Don't replace visible navigation or exact lookup with JavaScript-dependent interactions.
- Don't make color alone carry selection, capacity meaning, or read-only status.
- Don't add motion beyond the targeted surface change or animate it for reduced-motion users.
