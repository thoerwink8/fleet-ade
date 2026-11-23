# Release

This repository does not publish GitHub Releases or the `t3` npm package. Desktop
installers built here are unsigned and are not offered as updates.

For a local desktop build, see
[Development](./development.md#desktop-artifacts).

## Windows installer

`.github/workflows/desktop-windows.yml` builds an unsigned Windows x64 NSIS
installer on a GitHub-hosted `windows-latest` runner. The runner already has
Python and Visual Studio Build Tools. The workflow installs Node, pnpm, and the
`x86_64-pc-windows-msvc` Rust target, then runs
`node scripts/build-desktop-artifact.ts`. That script compiles
`native/resource-monitor` as part of the build. The workflow does not sign the
installer or read repository secrets.

Run **Desktop Windows** from the Actions tab (**Run workflow**). The `version`
input is the installer version written into the package. Leave it empty to use
the `version` in `apps/desktop/package.json`. The same version is part of the
artifact name.

The run uploads an artifact named `desktop-windows-<version>`, kept for 30 days.
Download `T3-Code-<version>-x64.exe` from that artifact. The workflow does not
create a GitHub Release, so the build does not become the repository's latest
release.

`workflow_dispatch` is available after this workflow is on the default branch.
A pull request that changes the workflow file also runs it, which is how a
change to the workflow is shown to produce an installer before it is merged.
