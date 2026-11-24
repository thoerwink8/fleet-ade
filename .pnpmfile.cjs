const { checkNodeVersion } = require("./scripts/node-version-check.cjs");

module.exports = {
  hooks: {
    updateConfig(config) {
      // Reject wrong Node majors before any pnpm command spawns work that fails
      // with cryptic errors (for example node:sqlite APIs missing under Node 24).
      const nodeVersionProblem = checkNodeVersion();
      if (nodeVersionProblem !== undefined) {
        throw new Error(nodeVersionProblem);
      }
      // Windows installs need Linux x64 glibc binaries because WSL shares node_modules.
      // Keep other platforms native; release scripts set their own architectures.
      // oxlint-disable-next-line t3code/no-global-process-runtime -- pnpm loads this file before any Effect runtime exists.
      if (process.platform !== "win32") return config;
      return {
        ...config,
        supportedArchitectures: {
          os: ["current", "linux"],
          cpu: ["current", "x64"],
          libc: ["current", "glibc"],
        },
      };
    },
  },
};
