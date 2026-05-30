// @ts-check
const esbuild = require('esbuild');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');
const repoRoot = path.resolve(__dirname, '../..');
const serverOutputDir = path.join(repoRoot, 'out/bin/Debug/LanguageServer');
const serverTargetDir = path.join(__dirname, '.server');

/** Build the .NET Language Server and copy it to .server/ */
function buildLanguageServer() {
  console.log('Building GSharp Language Server...');
  execSync('dotnet build src/LanguageServer -nologo -clp:NoSummary', {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  // Copy server output to .server/ for the extension to find.
  // Recreate the directory from scratch so stale artifacts (e.g. from a previous
  // OmniSharp-based build) are not left behind.
  if (fs.existsSync(serverTargetDir)) {
    fs.rmSync(serverTargetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(serverTargetDir, { recursive: true });

  const files = fs.readdirSync(serverOutputDir);
  for (const file of files) {
    const srcPath = path.join(serverOutputDir, file);
    const stat = fs.statSync(srcPath);
    // Only copy regular files (skip sockets, directories, etc.)
    if (!stat.isFile()) continue;
    fs.copyFileSync(srcPath, path.join(serverTargetDir, file));
  }
  console.log(`Language server copied to ${serverTargetDir}`);
}

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
};

async function main() {
  // Build the language server first
  buildLanguageServer();

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('Build complete.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
