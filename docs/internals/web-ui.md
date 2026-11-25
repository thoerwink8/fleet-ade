# Web UI

## Primitives

Controls come from [`components/ui`](../../apps/web/src/components/ui).
[AGENTS.md](../../AGENTS.md#taste) says how to use them. [Adoption](#adoption) is the checklist for
rendering one with `@fleet/design`.

`components/ui` is the only place that imports `@fleet/design/react`; lint rejects the import
anywhere else in `apps/web`. The design system's components take data where ours take composed
parts, so each primitive adapts it once and call sites stay as they are. Tokens load in the
`fleet-tokens` cascade layer, the lowest one, as `--fa-*` variables.

Don't style a raw `<button>`, `<input>`, `<select>`, or `<textarea>` to look like a control a
primitive provides. Raw elements are right when the element isn't that control: semantic rows, tabs,
resize handles, swatches, editor surfaces, anything whose behavior or geometry differs by design.

## Adoption

A slice that paints a control with `@fleet/design` meets every rule here. Numbers come from the
library's density table and type scale (`--fa-ctrl-*`, `--fa-row-*`, `.fa-caption` through
`.fa-heading`). Measure the computed value.

- Type is 12, 14, 15, 18, or 20px. Weight is 400, or 500 for button text, a selected nav item, an
  unread row title, or a block title (menu group label, dialog title, section head). Nothing is
  600 or above (`t3code/max-font-weight` and [`cssFontWeight.test.ts`](../../apps/web/src/cssFontWeight.test.ts)
  enforce this): rank comes from `--fa-fg` against `--fa-fg-muted`. Clickable text is at least 14px.
  12px is for times, hints, and labels you cannot click. Inputs, menu items, and other controls
  are 14px. 15px is body text and the composer field.
- A fixed control is 24, 28, 32, or 40px tall (`--fa-ctrl-xs`, `--fa-ctrl-sm`, `--fa-ctrl`,
  `--fa-ctrl-lg`), and that height does not change with viewport width. `Button` names those four
  heights `xs`, `sm`, `md`, and `lg`; `icon` makes the square icon-only form, and the local
  `multiline` flag preserves wrapping without adding another size. 20px (`--fa-ctrl-2xs`) is a tag,
  not a click target. A standalone control is 32px. 28px and 24px sit only inside a bar or row that
  is itself at least 32px. A checkbox or radio mark stays 16px inside that row.
- Under `pointer: coarse`, stretch the hit area to at least 44px with an `::after` and leave the
  painted height alone. The library does this for `.fa-btn`; controls it does not cover need it
  here, since growing the control to 44px would change the desktop metrics. Text inputs are the exception: below 640px the box is 36px, on the 4px
  grid and taller than the library's 32px field, with 16px type, because iOS Safari zooms the
  page on focus when a field's type is under 16px.
- A clickable list row is 32, 52, or 72px for one, two, or three lines (`--fa-row-1`, `--fa-row-2`,
  `--fa-row-3`). A row you cannot click is 24px. A table body row is 40px.
- Sizes and spacing are multiples of 4. A clickable row keeps a 2px transparent seam
  (`--fa-space-row-seam`) so two fills stay 4px apart. Borders are 1px. Radius is 4, 8, or 12.
- A floating surface (menu, dialog, popover, toast) uses opaque `--fa-overlay` and a 1px border.
  The scrim (`--fa-scrim`) may be translucent. No `backdrop-filter`. No `will-change`.
- A `.fa-*` class comes from `@fleet/design`. Do not add one in this repo. A look only this app
  needs is an `ade-` class in `apps/web/src/styles/fleet-overrides/`. A generic variant is added
  to the library first, then used from the facade. A look that belongs to one feature stays in
  that feature, not in `components/ui`.
- A theme override for the default theme, Grove, or Ember does not restyle a disabled control.
  Disabled stays at full opacity, with `--fa-fg-muted` text and the library's disabled fill. An
  opacity fade puts the text under the contrast target, and a theme colour on a disabled control
  makes it look enabled.
- Status is a coloured mark beside neutral text, not a tinted surface. In the chat view, errors
  and notices sit in the status strip above the composer. Restyling keeps what each colour or icon
  says: list every place one expresses an error, warning, or success before unifying them.
- Every "so that" in these rules (16px type so iOS does not zoom, a 44px hit area) needs an
  assertion that measures the computed value at the width that matters. A claim with no measuring
  test counts as not done, and so does an interaction the text promises but no test performs.
- A new element (hover card, row layout) gets a browser test for its position and size
  (alignment, icon size), not only for its text.
- Changing a shared colour variable: list every use outside the control you meant to change, and
  compare the whole set of variables against `main` (not one or two), including contrast of at
  least 4.5:1 for text on each fill. A cell that is below 4.5:1 today and may not be touched is
  stated as an exception, not left to a test that quietly skips it.
- A drawer, popover, scrim, or focus rule is tested rendered inside the app shell on a real
  route. A dialog nested in the shell's dialog tree draws no scrim in the underlying library, so a
  component rendered alone misses it.
- Decide "has a keyboard" or "is a touch device" from pointer and hover media queries, never from
  viewport width: a narrow desktop window still has a keyboard.
- An entry that restores, undoes, or confirms puts default focus on the safe control, so Enter
  does not discard. Say what Enter and Esc do, and keep any promise in its text ("still there next
  time") true after a reload.
- Keeping a `size` or `variant` name so callers do not change does not keep the old metrics. The
  painted height and type still fall on the sets above.
- Check the computed style in a browser, or in a browser test, at 390 and 1280 wide, in light and
  dark, for the default theme, Grove, and Ember. Put before and after screenshots in the PR.

## Styles

Style with Tailwind classes in the component that renders the element.

- Global CSS, in [`index.css`](../../apps/web/src/index.css) or any other stylesheet, is only for
  what classes on the owning component can't express: generated Markdown or imperative DOM, custom
  elements and shadow roots, animations, runtime theme variables, and browser or Electron
  integration.
- No `style={{ ... }}` or inline `<style>` for static values a class covers. Values computed at
  runtime are fine.
- Theme-only rules use `@variant dark` and `@variant light`, not `.dark` selectors.
- A new `@import` in `index.css` goes beside its component's neighbours, not at the end: every
  slice that appends there conflicts with the next one.

## Changing a default

Client settings are stored as a full snapshot, so a saved value cannot be told from a choice. A new
default reaches only new installs; existing users keep the old one unless a one-time migration
(`migrateClientSettings`) rewrites it. State what an existing user sees after upgrading.

## Composition

The composer banners are the reference.

- [`ComposerBanner.tsx`](../../apps/web/src/components/chat/ComposerBanner.tsx) exports one object
  of small slots. Slots own their classes, take `className`, and spread the rest of their props,
  merging classes with `cn`. Variants and density are props on `Root`. A slot that needs a control
  renders `Button`.
- [`ComposerBannerStack.tsx`](../../apps/web/src/components/chat/ComposerBannerStack.tsx) composes
  the slots and owns only stack behavior: priority, expand and collapse, dismiss transitions.

Build new UI the same way. Compose or extend a component instead of copying its markup and classes.
When a call site repeats a treatment another one already uses, make it a variant or a slot on the
shared component. A new composer banner or notice uses the `ComposerBanner` slots.

## Handlers in large components

V8 gives every closure created in one render a single shared scope. A memoized handler keeps
the scope of the render that created it, and that scope holds the other memoized values of that
render. When handlers in one component change at different times, each keeps an older scope that
holds older handlers, and old renders, with their server config and thread data, stay in memory
for as long as the component is mounted. React Compiler's memoized closures do the same.

In large, long-lived components such as `ChatView` and `ChatComposer`, write handlers as plain
functions and wrap them with [`useStableCallback`](../../apps/web/src/hooks/useStableCallback.ts)
only where they leave the component: props, hook dependency arrays, and effect or memo bodies.
Calls inside the component keep the plain function, so work that resumes after an `await` still
acts on the render it started in. A function that a child calls during render, or after an
`await`, comes from a module-level factory memoized on its inputs, so its closure keeps only
those inputs.

## React Compiler

The compiler memoizes a component or hook only when it can prove the code follows React's rules.
Anything it can't prove, such as reading a ref during render or calling `setState` from an effect,
makes it skip the whole function without a build error. Lint reports each skip as a
`react(...)` warning with the note "React Compiler skipped optimizing this component or hook".

Every file under `apps/web/src` must compile. Lint makes those rules errors there, and
`t3code/no-manual-memo` rejects `useMemo` and `useCallback`, which the compiler makes redundant;
no upstream rule bans them outright. It also rejects `"use memo"`. The compiler withholds a cache
scope when a value reaches plain function calls on both sides of a hook call. A `"use memo"`
helper forces one, but hides the ordering problem. Fix the order instead: plain uses of a value go
before the hook, or the helper is inlined. A `use*` helper that calls no hook is compiled as a
plain function and caches nothing, so a derived-value helper reads its source hook itself instead
of taking the value as an argument. `t3code/no-hookless-use-function` rejects a `use*` function
that calls no hook. Lint misses some bailouts, notably `try` with `finally` and
`throw` inside `try`, so [`reactCompilerCoverage.test.ts`](../../apps/web/src/reactCompilerCoverage.test.ts)
compiles every file and fails on any skip. Async handlers rarely need `try`: an
atom command settles into a result, so cleanup can follow the `await`. `useStableCallback` still
marks handlers that leave a large component, as described above.
