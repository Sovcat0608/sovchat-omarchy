import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const standaloneDir = path.join(rootDir, ".next", "standalone");
const electronRendererDir = path.join(rootDir, "electron", "renderer");

function copyIntoStandalone(sourceRelativePath, destinationRelativePath = sourceRelativePath) {
  const sourcePath = path.join(rootDir, sourceRelativePath);
  const destinationPath = path.join(standaloneDir, destinationRelativePath);

  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
}

function copyIntoElectronRenderer(sourceRelativePath, destinationRelativePath = sourceRelativePath) {
  const sourcePath = path.join(rootDir, sourceRelativePath);
  const destinationPath = path.join(electronRendererDir, destinationRelativePath);

  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
}

function removeMatchingFiles(directoryPath, pattern) {
  if (!fs.existsSync(directoryPath)) {
    return;
  }

  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      removeMatchingFiles(entryPath, pattern);
      continue;
    }

    if (pattern.test(entry.name)) {
      fs.rmSync(entryPath, { force: true });
    }
  }
}

function pruneNextDevStatic(staticDir) {
  fs.rmSync(path.join(staticDir, "development"), { recursive: true, force: true });
  fs.rmSync(path.join(staticDir, "webpack"), { recursive: true, force: true });
  fs.rmSync(path.join(staticDir, "chunks", "webpack.js"), { force: true });
  fs.rmSync(path.join(staticDir, "chunks", "app", "layout.js"), { force: true });
  removeMatchingFiles(staticDir, /hot-update\.(js|json)$/u);
}

fs.rmSync(electronRendererDir, { recursive: true, force: true });
copyIntoStandalone("public");
copyIntoStandalone(path.join(".next", "static"));
pruneNextDevStatic(path.join(standaloneDir, ".next", "static"));
copyIntoStandalone(path.join(".next", "standalone", "node_modules"), "standalone_node_modules");

copyIntoElectronRenderer(path.join(".next", "server", "app", "desktop.html"), "desktop.html");
copyIntoElectronRenderer(
  path.join(".next", "server", "app", "desktop-popout.html"),
  "desktop-popout.html"
);
copyIntoElectronRenderer(path.join(".next", "static"), path.join("_next", "static"));
pruneNextDevStatic(path.join(electronRendererDir, "_next", "static"));
copyIntoElectronRenderer("public", "public");
