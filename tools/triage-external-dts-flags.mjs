#!/usr/bin/env node
/**
 * Issue #82: two SourceFile/Program answers vite-plugin-dts (and unplugin-dts)
 * filter on — `!sf.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sf)`
 * — diverged from stock. The light stub decided isDeclarationFile with
 * `endsWith(".d.ts")`, so `.d.mts` / `.d.cts` packages counted as sources, and
 * isSourceFileFromExternalLibrary was hard-wired false although tsgo records
 * the bit per file. The plugin then rooted its output at the directory that
 * holds node_modules and emitted nothing. The skeleton SourceFile behind
 * diagnostic locations hard-coded isDeclarationFile=false for every name.
 *
 * Mirrors the issue's repro (a node_modules package resolved through
 * `exports` types, a tsconfig-driven createProgram) for `.d.mts`, `.d.cts`
 * and `.d.ts` packages, and diffs both flags against stock for every file the
 * program holds, through getSourceFiles() and getSourceFile(), plus
 * isDeclarationFile on each diagnostic's file.
 *
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 * Exit: 0 = PASS, 1 = FAIL.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forkTs = path.join(repoRoot, 'lib', 'typescript.js');
const stockTs = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';
if (!fs.existsSync(stockTs)) {
	console.error(`stock typescript not found at ${stockTs} — set STOCK_TYPESCRIPT_PATH or STOCK_TSSERVER_PATH`);
	process.exit(1);
}

// Child: build the fixture's program with the given typescript.js, print the flags.
if (process.argv[2] === '--child') {
	const [, , , tsPath, dir] = process.argv;
	const { createRequire } = await import('node:module');
	const ts = createRequire(import.meta.url)(tsPath);
	const cfg = ts.getParsedCommandLineOfConfigFile(path.join(dir, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
	const program = ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options, host: ts.createCompilerHost(cfg.options) });
	const flags = sf => `isDeclarationFile=${sf.isDeclarationFile} isSourceFileFromExternalLibrary=${program.isSourceFileFromExternalLibrary(sf)}`;
	const out = {};
	for (const sf of program.getSourceFiles()) {
		if (!sf.fileName.startsWith(dir)) continue;
		const rel = path.relative(dir, sf.fileName).replaceAll('\\', '/');
		out[rel] = { getSourceFiles: flags(sf), getSourceFile: flags(program.getSourceFile(sf.fileName)) };
	}
	const diagnosticFiles = ts.getPreEmitDiagnostics(program).filter(d => d.file)
		.map(d => `${path.relative(dir, d.file.fileName).replaceAll('\\', '/')} isDeclarationFile=${d.file.isDeclarationFile}`);
	console.log(JSON.stringify({ files: Object.fromEntries(Object.entries(out).sort()), diagnosticFiles }));
	process.exit(0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-external-dts-flags-')));
function fixture(ext) {
	const dir = path.join(root, ext.replaceAll('.', ''));
	const js = ext === '.d.mts' ? 'index.mjs' : ext === '.d.cts' ? 'index.cjs' : 'index.js';
	const files = {
		'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', declaration: true, outDir: 'dist', types: [] }, include: ['src/**/*'] }),
		'src/index.ts': 'import { m } from "libm";\nexport const a: number = m;\n',
		'node_modules/libm/package.json': JSON.stringify({ name: 'libm', exports: { '.': { types: `./index${ext}`, default: `./${js}` } } }),
		// The unresolved type puts a diagnostic in the package file, so the
		// diagnostic's SourceFile (a skeleton on the fork) is compared too.
		[`node_modules/libm/index${ext}`]: 'export declare const m: number;\nexport declare const n: Missing;\n',
	};
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), text);
	}
	return dir;
}
function run(tsPath, dir) {
	const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', tsPath, dir], { encoding: 'utf8', env: { ...process.env, GODEBUG: 'asyncpreemptoff=1' } });
	if (r.status !== 0) return `exit ${r.status ?? r.signal}: ${r.stderr.slice(-500)}`;
	return r.stdout.split('\n').find(l => l.startsWith('{')) ?? `no result: ${r.stdout.slice(-500)}`;
}

let failed = 0;
const exts = ['.d.mts', '.d.cts', '.d.ts'];
for (const ext of exts) {
	const dir = fixture(ext);
	const stock = run(stockTs, dir);
	const fork = run(forkTs, dir);
	const lib = `"node_modules/libm/index${ext}":{"getSourceFiles":"isDeclarationFile=true isSourceFileFromExternalLibrary=true"`;
	if (!stock.includes(lib) || !stock.includes(`"node_modules/libm/index${ext} isDeclarationFile=true"`)) {
		console.error(`FAIL ${ext}: stock no longer reports libm as an external declaration file — fixture is stale.\n${stock}`);
		failed++;
	} else if (fork !== stock) {
		console.error(`FAIL ${ext}: fork flags diverge from stock.\n--- stock ---\n${stock}\n--- fork ---\n${fork}`);
		failed++;
	} else {
		console.log(`ok ${ext}`);
	}
}
fs.rmSync(root, { recursive: true, force: true });
if (failed) {
	console.error(`FAIL: ${failed}/${exts.length} external declaration-flag cells diverged`);
	process.exit(1);
}
console.log(`PASS: all ${exts.length} external declaration-flag cells match stock`);
