// Shared open/close motion. Surfaces are @fleet/design (fa-dialog, fa-backdrop, fa-pop, fa-cmd).
const DIALOG_BACKDROP_BASE_CLASS =
  "fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0";

// Dialogs fill their max-width. The command palette leaves width to .fa-cmd (640px,
// max-width 100% inside the padded viewport) so w-full cannot override it.
const DIALOG_POPUP_MOTION_CLASS =
  "-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative flex min-h-0 min-w-0 scale-[calc(1-0.1*var(--nested-dialogs))] flex-col opacity-[calc(1-0.1*var(--nested-dialogs))] outline-none transition-[scale,opacity,translate] duration-200 ease-in-out data-nested:data-ending-style:translate-y-8 data-nested:data-starting-style:translate-y-8 data-nested-dialog-open:origin-top data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 [-webkit-app-region:no-drag]";

const DIALOG_POPUP_BASE_CLASS = `${DIALOG_POPUP_MOTION_CLASS} w-full`;

// .fa-cmd--modal would pin the popup at 15% with z-index 41, under z-50 overlays and
// without the native titlebar inset the viewport already applies.
const COMMAND_POPUP_CLASS = `fa-pop fa-cmd ${DIALOG_POPUP_MOTION_CLASS}`;

export { COMMAND_POPUP_CLASS, DIALOG_BACKDROP_BASE_CLASS, DIALOG_POPUP_BASE_CLASS };
