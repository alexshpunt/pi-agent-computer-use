/** Exact downloads for the optional parts; every file is checked against its SHA-256 on the target before use. */

/** Portable Windows Node for the Playwright worker when Pi runs in WSL or on another machine. */
export const WINDOWS_NODE = {
  version: "v22.22.2",
  url: "https://nodejs.org/dist/v22.22.2/node-v22.22.2-win-x64.zip",
  sha256: "7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c",
  executableSha256: "ae1a50511be58e987483fdbc12125407443926d2d394669ade2352776e920dd3",
};

/** Microsoft Execution Containers; only x64/wxc-exec.exe is used, for isolated agent sessions. */
export const MXC = {
  version: "v1.0.1",
  url: "https://github.com/microsoft/mxc/releases/download/v1.0.1/mxc-release-binaries.zip",
  sha256: "0e832239454ba7fcd338ff56218a287eef4c0a01c1484084b869f55feff8abe9",
};

/** Cua's signed perception extension; the driver also verifies the catalog signature and every hash. */
export const PERCEPTION = {
  version: "0.2.1",
  name: "cua-perception-0.2.1-x86_64-pc-windows-msvc",
  release: "https://github.com/trycua/cua/releases/download/cua-perception-v0.2.1/",
  catalog: "bfb2300ff9da054d522e73351f7b337ba6157ebbe30f029a95a471fc3d13a042",
  archive: "6709579aa3f938e8200c0a51b1abe450d4fda51b09e97517e0cb4c272b5bff37",
};
