// Builds release/cadSlop-darwin-<arch>/cadSlop.app
import { packager } from "@electron/packager";
const out = await packager({
  dir: ".", out: "release", name: "cadSlop", overwrite: true, platform: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64",
  appBundleId: "com.cadslop.app", appCategoryType: "public.app-category.graphics-design",
  // Lets Finder and the cadSlop menu-bar app hand cadSlop project folders and part files.
  extendInfo: { CFBundleDocumentTypes: [
    { CFBundleTypeName: "cadSlop project folder", CFBundleTypeRole: "Editor", LSHandlerRank: "Alternate", LSItemContentTypes: ["public.folder"] },
    { CFBundleTypeName: "cadSlop part", CFBundleTypeRole: "Editor", LSHandlerRank: "Alternate", LSItemContentTypes: ["public.json"], CFBundleTypeExtensions: ["json"] },
  ] },
  ignore: [/^\/(test|scripts|release|examples|menubar|\.scratch|\.claude)(\/|$)/, /^\/node_modules(\/|$)/, /^\/dist\/.*\.map$/],
  prune: true,
});
console.log("Built:", out.join("\n"));
