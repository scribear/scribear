# @scribear/visualizer-ui

## 0.3.0

### Patch Changes

- 64a2a70: Stop MUI's subtitle variants emitting stray `<h6>` elements (WCAG 2.1 AA,
  `heading-order`).

  MUI's `Typography` maps the `subtitle1` and `subtitle2` _variants_ to an `h6`
  _element_ via its default `variantMapping`, whether or not the text is a
  heading, and this repo has no `variantMapping` override. Any decorative small
  text therefore entered the document outline at level 6.
  - Session-calendar column labels are labels, not sections, and landed at `h6`
    under a page whose last heading is `h2`. They render as text now; the grid
    contributes no headings at all.
  - The visualizer drawer's panel title is in a shared UI library that cannot
    know its host's heading levels, so any fixed level is a violation in some
    host. It renders as text rather than guessing.
  - The Documentation and Deployment Check pages set `variant="h5"` without
    `component`, so each had an `h5` as its top heading and no `h1` at all —
    every other page in the console uses `variant="h5" component="h1"`. Their
    card and finding titles are real subsections and now say so with
    `component="h2"`, which is also how a screen-reader user moves between them.

## 0.2.0

## 0.1.0
