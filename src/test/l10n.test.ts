import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Compiled to out/test/, so the repo root is two levels up.
const repoRoot = path.join(__dirname, '..', '..');

function readJson(relative: string): Record<string, string> {
	return JSON.parse(fs.readFileSync(path.join(repoRoot, relative), 'utf8')) as Record<string, string>;
}

/** Every string literal passed as the first argument to `vscode.l10n.t(...)`. */
function l10nKeys(): string[] {
	const keys = new Set<string>();
	for (const file of fs.readdirSync(path.join(repoRoot, 'src'))) {
		if (!file.endsWith('.ts')) {
			continue;
		}
		const source = fs.readFileSync(path.join(repoRoot, 'src', file), 'utf8');
		const call = /\bl10n\.t\(\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
		for (const match of source.matchAll(call)) {
			// Decode the escape sequences (`\'`, `\u2019`) so the key matches the translation file.
			keys.add(JSON.parse(`"${match[1].slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`));
		}
	}
	return [...keys];
}

suite('localized strings', () => {
	test('every l10n.t() key has a Russian translation', () => {
		const keys = l10nKeys();
		assert.ok(keys.length > 20, `expected the source scan to find the UI strings, found ${keys.length}`);
		const translated = readJson('l10n/bundle.l10n.ru.json');
		const missing = keys.filter((key) => !(key in translated));
		assert.deepStrictEqual(missing, [], `missing in l10n/bundle.l10n.ru.json: ${missing.join(' | ')}`);
	});

	test('every %key% referenced by package.json is translated', () => {
		const manifest = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
		const referenced = new Set([...manifest.matchAll(/"%([^"%]+)%"/g)].map((m) => m[1]));
		assert.ok(referenced.size > 0, 'expected package.json to use %key% references');
		const english = readJson('package.nls.json');
		const russian = readJson('package.nls.ru.json');
		assert.deepStrictEqual([...referenced].filter((k) => !(k in english)), []);
		assert.deepStrictEqual([...referenced].filter((k) => !(k in russian)), []);
	});
});
