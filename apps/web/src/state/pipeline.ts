import { createPipelineEnvironmentAtoms } from "@t3tools/client-runtime/state/pipeline";

import { connectionAtomRuntime } from "../connection/runtime";

export const pipelineEnvironment = createPipelineEnvironmentAtoms(connectionAtomRuntime);
