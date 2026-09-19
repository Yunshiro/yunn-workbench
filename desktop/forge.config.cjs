const path = require("node:path");
const { signAsync } = require("@electron/osx-sign");

const iconPath = path.join(__dirname, "assets", process.platform === "win32" ? "icon.ico" : "icon.icns");
const productName = "Yunn Workbench";

const adHocSignOptions = {
  identity: "-",
  identityValidation: false,
  // Ad-hoc signatures do not have a shared Apple Team ID. Avoid enabling
  // additional runtime validation for builds that cannot be notarized.
  hardenedRuntime: false,
  timestamp: false,
};

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.yunshiro.yunn-workbench",
    icon: iconPath,
    osxSign: process.platform === "darwin"
      ? adHocSignOptions
      : undefined,
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_forgeConfig, { platform, outputPaths }) => {
      if (platform !== "darwin") return;
      // Re-sign only after Packager has finalized the complete bundle. Without
      // this pass macOS 26 can reject Electron Framework with a Team ID mismatch
      // even though every individual signature verifies successfully.
      for (const outputPath of outputPaths) {
        await signAsync({
          app: path.join(outputPath, `${productName}.app`),
          ...adHocSignOptions,
        });
      }
    },
  },
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
