module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.yunshiro.yunn-workbench",
    executableName: "yunn-workbench",
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {},
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
      config: {},
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "yunn_workbench",
        setupExe: "Yunn-Workbench-Setup.exe",
      },
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
  ],
};
