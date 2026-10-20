const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

async function ensureElectron() {
  const electronPkgPath = path.join(__dirname, '..', 'node_modules', 'electron');
  if (!fs.existsSync(electronPkgPath)) {
    return;
  }

  const pkg = require(path.join(electronPkgPath, 'package.json'));
  const version = pkg.version;
  const platform = process.platform;
  const arch = process.arch;

  const defaultRelPath = platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : platform === 'win32'
    ? 'electron.exe'
    : 'electron';

  const pathTxt = path.join(electronPkgPath, 'path.txt');
  if (!fs.existsSync(pathTxt) || !fs.readFileSync(pathTxt, 'utf-8').trim()) {
    fs.writeFileSync(pathTxt, defaultRelPath);
  }

  if (platform === 'darwin') {
    const frameworkPath = path.join(
      electronPkgPath,
      'dist',
      'Electron.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework'
    );

    if (!fs.existsSync(frameworkPath)) {
      console.log('Electron Framework is missing or incomplete. Locating cache to re-extract...');
      const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'electron');
      let zipPath = null;

      if (fs.existsSync(cacheDir)) {
        const subdirs = fs.readdirSync(cacheDir);
        for (const dir of subdirs) {
          const candidate = path.join(cacheDir, dir, `electron-v${version}-darwin-${arch}.zip`);
          if (fs.existsSync(candidate)) {
            zipPath = candidate;
            break;
          }
        }
      }

      if (!zipPath) {
        try {
          const { downloadArtifact } = require(path.join(electronPkgPath, 'node_modules', '@electron/get'));
          zipPath = await downloadArtifact({
            version,
            artifactName: 'electron',
            platform,
            arch
          });
        } catch {
          // ignore
        }
      }

      if (zipPath) {
        console.log(`Extracting ${zipPath} using system unzip...`);
        const distDir = path.join(electronPkgPath, 'dist');
        fs.rmSync(distDir, { recursive: true, force: true });
        fs.mkdirSync(distDir, { recursive: true });
        execSync(`unzip -q -o "${zipPath}" -d "${distDir}"`);

        fs.writeFileSync(pathTxt, defaultRelPath);

        // Move electron.d.ts if present
        const srcTypeDef = path.join(distDir, 'electron.d.ts');
        const targetTypeDef = path.join(electronPkgPath, 'electron.d.ts');
        if (fs.existsSync(srcTypeDef) && !fs.existsSync(targetTypeDef)) {
          fs.renameSync(srcTypeDef, targetTypeDef);
        }

        console.log('Successfully repaired Electron binary installation.');
      } else {
        console.warn('Could not find cached Electron zip file to auto-extract.');
      }
    }
  }
}

ensureElectron().catch(err => {
  console.error('ensure-electron error:', err.message);
});
