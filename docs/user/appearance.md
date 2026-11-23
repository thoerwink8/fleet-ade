# Appearance and themes

On web and desktop, open **Settings → Appearance** to follow the system appearance or stay in light
or dark mode, and to pick one of three themes: the default, Grove, or Ember. Each theme has a light
and a dark palette, so the mode and the theme are chosen independently. Appearance preferences are
saved separately on each device or browser. A theme from an older version that is no longer offered,
including a custom or imported theme, opens as the default theme.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → General → Keybindings**.

A phone uses these same settings. [Mobile setup](./install.md#mobile-app)

## Font size

**Font size** offers three steps: Standard, Comfortable, and Large. One step scales the interface,
the composer, chat text, code, and the terminal together.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts. This preference
applies to the web and desktop clients.

## Math

Turn on **Render math** in **Settings → Appearance** to typeset LaTeX in messages and Markdown
previews on web and desktop. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.
