/** A controller bound at creation still advances when the global pipeline switch is off. */
export const shouldAdvancePipelineRun = (
  pipelineEnabled: boolean,
  run: { readonly controllerThreadId: string | null },
): boolean => pipelineEnabled || run.controllerThreadId !== null;
