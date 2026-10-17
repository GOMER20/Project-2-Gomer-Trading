// electron-builder hook, run after the app bundle is assembled and before it is signed.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  // Electron's built-in placeholder app is copied along with the runtime; Gomer never uses it.
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
};
