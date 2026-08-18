import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the packed artifact contains only the supported product surface and can render', () => {
    const work = mkdtempSync(join(tmpdir(), 'cycle-package-'));
    try {
        const raw = execFileSync('npm', [
            'pack', '--json', '--pack-destination', work, '--cache', join(work, 'npm-cache'),
        ], { cwd: ROOT, encoding: 'utf8' });
        const parsed = JSON.parse(raw);
        const metadata = Array.isArray(parsed) ? parsed[0] : parsed['@brndnsh/the-cycle'];
        assert.equal(metadata.name, '@brndnsh/the-cycle');

        const files = metadata.files.map((entry) => entry.path);
        for (const expected of [
            'bin/cycle.mjs', 'templates/DOCTRINE.md.tmpl', 'backends/github.jsonc',
            'harnesses/codex.jsonc', 'profiles/lean.jsonc', 'skills/cycle-setup/SKILL.md',
            'docs/RELEASING.md',
        ]) {
            assert.ok(files.includes(expected), `packed artifact omitted ${expected}`);
        }
        for (const excluded of [
            '.cycle/', '.claude/', '.agents/', '.github/', 'test/', 'AGENTS.md', 'CLAUDE.md',
        ]) {
            assert.ok(!files.some((path) => path.startsWith(excluded)), `packed artifact leaked ${excluded}`);
        }

        const unpacked = join(work, 'unpacked');
        mkdirSync(unpacked);
        execFileSync('tar', ['-xzf', join(work, metadata.filename), '-C', unpacked]);
        const packageRoot = join(unpacked, 'package');
        assert.equal(
            execFileSync(process.execPath, [join(packageRoot, 'bin', 'cycle.mjs'), '--version'], {
                encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
            }).trim(),
            'v0.1.0',
        );

        const home = join(work, 'home');
        mkdirSync(home);
        execFileSync('bash', [join(packageRoot, 'install.sh')], {
            encoding: 'utf8', env: { ...process.env, HOME: home },
        });
        assert.ok(existsSync(join(home, '.local', 'bin', 'cycle')));
        assert.ok(existsSync(join(home, '.claude', 'skills', 'cycle-setup', 'SKILL.md')));
        assert.ok(existsSync(join(home, '.agents', 'skills', 'cycle-setup', 'SKILL.md')));

        const collisionHome = join(work, 'collision-home');
        mkdirSync(join(collisionHome, '.agents', 'skills', 'cycle-setup'), { recursive: true });
        const collision = spawnSync('bash', [join(packageRoot, 'install.sh')], {
            encoding: 'utf8', env: { ...process.env, HOME: collisionHome },
        });
        assert.notEqual(collision.status, 0, 'installer silently accepted a real-directory collision');
        assert.match(collision.stderr, /refusing to replace existing directory or file/);
        assert.ok(!existsSync(join(collisionHome, '.agents', 'skills', 'cycle-setup', 'cycle-setup')));

        const repo = join(work, 'consumer');
        mkdirSync(repo);
        execFileSync('git', ['init', '-q', '.'], { cwd: repo });
        writeFileSync(join(repo, 'package.json'), '{"name":"packed-smoke"}\n');
        execFileSync(process.execPath, [join(packageRoot, 'bin', 'cycle.mjs'), 'install', '-y'], {
            cwd: repo, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
        });
        assert.ok(existsSync(join(repo, '.claude', 'skills', 'DOCTRINE.md')));
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
});
