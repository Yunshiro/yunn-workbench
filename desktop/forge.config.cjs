const path = require("node:path");

const iconPath = path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.icns");

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.yunshiro.yunn-workbench",
    icon: iconPath,
    osxSign: process.platform === "darwin"
      ? {
          identity: "-",
          identityValidation: false,
        }
      : undefined,
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
        setupIcon: path.join(__dirname, "assets", "icon.ico"),
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
