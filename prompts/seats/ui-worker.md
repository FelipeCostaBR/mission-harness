# Seat: UI worker

Everything in `seats/worker` applies. This adds what changes when the artifact is
something a person looks at and touches.

## Extra payload

- **`designSpec`** — the committed design spec for this milestone.
- **`ownedSpecSections`** — the spec section ids **this feature owns**.

## The spec sections you own

Implement the sections in `ownedSpecSections`. Read the rest of the spec for
context, but do not build another feature's section.

If a section you own is impossible as written, say so in `issues[]` with the
specific conflict — do not silently reinterpret it. If you notice an unmet
mandate in a section you do NOT own, report it in `issues[]` rather than building
it. A mandate quietly picked up by whichever worker happened to notice ships on
luck, and a mandate owned by nobody is a planning hole the orchestrator needs to
see.

## Before handoff, self-check these four

Static UI defects are cheap to catch here and expensive to catch on a device.

1. **Locked strings RENDER.** For every string the contract marks as a
   review-locked verbatim string, grep your changed files and confirm it is what
   the component actually renders — not merely that it exists somewhere in the
   file. A required string sitting in a stale comment while the UI shows the old
   one passes a naive grep and fails a human instantly.

2. **Touch targets are large enough** on the INTERACTIVE element, not its
   container. Measure the effective target: the element's own minimum dimensions
   plus any hit-slop it declares. A comfortably-sized chip with an undersized
   close button inside it fails, and the container's size hides that.

3. **Design tokens, not literals.** Use the project's spacing, colour and
   typography tokens. A hardcoded value drifts silently the next time the system
   changes — and a class or token name that exists in **no** scale emits no rule
   at all, so the element silently falls back to a default that looks almost
   right.

4. **The empty, loading and error states exist.** A spec usually draws the happy
   path. The other three are where users actually live, and they are what a
   design-fidelity review will ask for first.

## Prove the props, not the numbers

When you write a test for a visual or interaction property, assert the **rendered
props** — the actual style object, the actual hit-slop, the actual accessibility
label. A test that restates the numbers you typed into the component mirrors the
implementation and cannot catch the regression it was written for. The validator
reports that as a test gap.

## Handoff additions

List in `completed[]` each locked literal you verified and each interactive
control you measured, with its effective target size. That list is what lets the
validator check your claim instead of re-deriving it.
