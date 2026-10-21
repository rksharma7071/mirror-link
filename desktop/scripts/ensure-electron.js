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

  const binaryCheckPath = platform === 'darwin'
    ? path.join(
        electronPkgPath,
        'dist',
        'Electron.app',
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
        'Electron Framework'
      )
    : path.join(electronPkgPath, 'dist', defaultRelPath);

  if (!fs.existsSync(binaryCheckPath)) {
    console.log('Electron binary is missing or incomplete. Locating cache to re-extract...');
    let cacheDir = null;
    if (platform === 'darwin') {
      cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'electron');
    } else if (platform === 'win32') {
      cacheDir = path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache');
    } else {
      cacheDir = path.join(os.homedir(), '.cache', 'electron');
    }

    let zipPath = null;
    if (cacheDir && fs.existsSync(cacheDir)) {
      const findZip = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findZip(fullPath);
            if (found) return found;
          } else if (entry.name.includes(`electron-v${version}-${platform}-${arch}.zip`) ||
                     entry.name === `electron-v${version}-${platform}-${arch}.zip`) {
            return fullPath;
          }
        }
        return null;
      };
      zipPath = findZip(cacheDir);
    }

    if (!zipPath) {
      try {
        let getModule;
        try {
          getModule = require('@electron/get');
        } catch {
          getModule = require(path.join(electronPkgPath, 'node_modules', '@electron/get'));
        }
        zipPath = await getModule.downloadArtifact({
          version,
          artifactName: 'electron',
          platform,
          arch
        });
      } catch (e) {
        console.warn('downloadArtifact failed:', e.message);
      }
    }

    if (zipPath) {
      console.log(`Extracting ${zipPath}...`);
      const distDir = path.join(electronPkgPath, 'dist');
      fs.rmSync(distDir, { recursive: true, force: true });
      fs.mkdirSync(distDir, { recursive: true });

      try {
        execSync(`tar -xf "${zipPath}" -C "${distDir}"`);
      } catch {
        if (platform === 'win32') {
          execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${distDir}' -Force"`);
        } else {
          execSync(`unzip -q -o "${zipPath}" -d "${distDir}"`);
        }
      }

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

ensureElectron().catch(err => {
  console.error('ensure-electron error:', err.message);
});
