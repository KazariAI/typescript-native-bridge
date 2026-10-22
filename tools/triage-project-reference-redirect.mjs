#!/usr/bin/env node
/**
 * Issue #78: a program over a project with `references` must read the
 * referenced project's emitted declarations, not its sources. tsgo's project
 * service always asks for source-of-project-reference redirects; stock only
 * grants them to a host that opts in through useSourceOfProjectReferenceRedirect
 * (tsserver's Project) and an explicit disableSourceOfProjectReferenceRedirect
 * still wins there. On TNB every program loaded the upstream sources, so
 * `tsc -p` / `tsc -b` / `vue-tsc -b` re-checked the whole upstream tree.
 *
 * Mirrors the issue's lib/app fixture and diffs the app program's files
 * against stock for: the tsc CLI (--listFilesOnly), tsc -b (--listFiles over
 * both projects), createProgram with and without a host (stock then creates
 * its own CompilerHost), a language-service host without the opt-in,
 * one with it (tsserver's shape: sources), and one with it under an explicit
 * disableSourceOfProjectReferenceRedirect (declarations).
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

const relFiles = (dir, fileNames) => fileNames
	.filter(f => f.startsWith(dir))
	.map(f => path.relative(dir, f).replaceAll('\\', '/'))
	.sort();

// Child: build the app program through one API surface, print its files.
if (process.argv[2] === '--child') {
	const [, , , tsPath, dir, cell] = process.argv;
	const { createRequire } = await import('node:module');
	const ts = createRequire(import.meta.url)(tsPath);
	const parse = f => ts.getParsedCommandLineOfConfigFile(f, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
	const cfg = parse(path.join(dir, 'app', 'tsconfig.json'));
	let program;
	if (cell === 'createProgram') {
		program = ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options, host: ts.createCompilerHost(cfg.options), projectReferences: cfg.projectReferences });
	} else if (cell === 'createProgram (no host)') {
		program = ts.createProgram({ rootNames: cfg.fileNames, options: cfg.options, projectReferences: cfg.projectReferences });
	} else {
		const host = {
			getCompilationSettings: () => cfg.options,
			getScriptFileNames: () => cfg.fileNames,
			getProjectReferences: () => cfg.projectReferences,
			getParsedCommandLine: parse,
			getScriptVersion: () => '1',
			getScriptSnapshot: f => ts.sys.fileExists(f) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(f)) : undefined,
			getCurrentDirectory: () => dir,
			getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
		};
		if (cell !== 'ls-plain') host.useSourceOfProjectReferenceRedirect = () => true;
		program = ts.createLanguageService(host).getProgram();
	}
	console.log(JSON.stringify(relFiles(dir, program.getSourceFiles().map(f => f.fileName))));
	process.exit(0);
}

// cell → files of stock's app program (the fixture's contract with stock).
const cells = {
	'tsc -p': ['app/src/main.ts', 'dist/lib/greet.d.ts'],
	'tsc -b': ['app/src/main.ts', 'dist/lib/greet.d.ts', 'lib/src/greet.ts'],
	'createProgram': ['app/src/main.ts', 'dist/lib/greet.d.ts'],
	'createProgram (no host)': ['app/src/main.ts', 'dist/lib/greet.d.ts'],
	'ls-plain': ['app/src/main.ts', 'dist/lib/greet.d.ts'],
	'ls-redirect': ['app/src/main.ts', 'lib/src/greet.ts'],
	'ls-redirect-disabled': ['app/src/main.ts', 'dist/lib/greet.d.ts'],
};

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-project-reference-redirect-')));
function fixture(cell, side) {
	const dir = path.join(root, `${cell.replace(/\W+/g, '-')}-${side}`);
	const compilerOptions = name => ({
		composite: true, emitDeclarationOnly: true, outDir: `../dist/${name}`, tsBuildInfoFile: `../dist/${name}.tsbuildinfo`, rootDir: 'src',
		module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', strict: true, types: [],
	});
	const files = {
		'lib/tsconfig.json': { compilerOptions: compilerOptions('lib'), include: ['src'] },
		'lib/src/greet.ts': 'export function greet(name: string): string {\n\treturn `Hello, ${name}`;\n}\n',
		'app/tsconfig.json': {
			compilerOptions: { ...compilerOptions('app'), ...cell === 'ls-redirect-disabled' ? { disableSourceOfProjectReferenceRedirect: true } : {} },
			include: ['src'],
			references: [{ path: '../lib' }],
		},
		'app/src/main.ts': "import { greet } from '../../lib/src/greet';\n\nexport const message: string = greet('world');\n",
		// tsc -b emits it; every other cell reads the already-built upstream.
		...cell === 'tsc -b' ? {} : { 'dist/lib/greet.d.ts': 'export declare function greet(name: string): string;\n' },
	};
	for (const [rel, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content));
	}
	return dir;
}
function run(tsPath, cell, side) {
	const dir = fixture(cell, side);
	const env = { ...process.env, GODEBUG: 'asyncpreemptoff=1' };
	const tsc = path.join(path.dirname(tsPath), 'tsc.js');
	const r = cell === 'tsc -p'
		? spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'app', 'tsconfig.json'), '--listFilesOnly'], { encoding: 'utf8', env })
		: cell === 'tsc -b'
		? spawnSync(process.execPath, [tsc, '-b', path.join(dir, 'app', 'tsconfig.json'), '--listFiles'], { encoding: 'utf8', env })
		: spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', tsPath, dir, cell], { encoding: 'utf8', env });
	if (r.status !== 0) return `exit ${r.status ?? r.signal}: ${(r.stdout + r.stderr).slice(-500)}`;
	if (cell.startsWith('tsc')) return JSON.stringify(relFiles(dir, r.stdout.split('\n').map(l => l.trim())));
	return r.stdout.split('\n').find(l => l.startsWith('[')) ?? `no result: ${r.stdout.slice(-500)}`;
}

let failed = 0;
for (const [cell, want] of Object.entries(cells)) {
	const stock = run(stockTs, cell, 'stock');
	const fork = run(forkTs, cell, 'fork');
	if (stock !== JSON.stringify(want)) {
		console.error(`FAIL ${cell}: stock no longer lists ${JSON.stringify(want)} — fixture is stale.\n${stock}`);
		failed++;
	} else if (fork !== stock) {
		console.error(`FAIL ${cell}: fork program files diverge from stock.\n--- stock ---\n${stock}\n--- fork ---\n${fork}`);
		failed++;
	} else {
		console.log(`ok ${cell} ${stock}`);
	}
}
fs.rmSync(root, { recursive: true, force: true });
const total = Object.keys(cells).length;
if (failed) {
	console.error(`FAIL: ${failed}/${total} project-reference redirect cells diverged`);
	process.exit(1);
}
console.log(`PASS: all ${total} project-reference redirect cells match stock`);
