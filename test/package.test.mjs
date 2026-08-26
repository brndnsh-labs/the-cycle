import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync,
    symlinkSync, writeFileSync,
} from 'node:fs';
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
        const setupSkill = readFileSync(join(packageRoot, 'skills', 'cycle-setup', 'SKILL.md'), 'utf8');
        assert.match(setupSkill, /run every non-empty command/i, 'setup omits configured gate execution');
        assert.match(setupSkill, /gh repo view --json nameWithOwner,url/, 'setup omits repository access proof');
        assert.match(setupSkill, /gh issue list --state all --limit 1 --json number/, 'setup omits tracker access proof');
        assert.match(setupSkill, /gh label list --limit 1000 --json name/, 'setup omits required-label proof');
        assert.match(
            setupSkill,
            /fresh explicit approval[\s\S]*gh label create "<exact name>"/,
            'setup permits label creation without a fresh exact approval',
        );
        assert.doesNotMatch(setupSkill, /gh label create[^\n]*--force/, 'setup can overwrite an existing label');
        assert.match(setupSkill, /READY is allowed only when every surface is PASS/);
        assert.match(setupSkill, /Any FAIL or UNVERIFIED makes the headline\s+NOT READY/);
        assert.match(setupSkill, /git status --short -- \.cycle <each configured harness root>/);
        assert.match(setupSkill, /First use after that commit: \/next/);
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
        execFileSync('bash', [join(packageRoot, 'install.sh')], {
            encoding: 'utf8', env: { ...process.env, HOME: home },
        });
        assert.ok(existsSync(join(home, '.local', 'bin', 'cycle')));
        assert.ok(existsSync(join(home, '.claude', 'skills', 'cycle-setup', 'SKILL.md')));
        assert.ok(existsSync(join(home, '.agents', 'skills', 'cycle-setup', 'SKILL.md')));
        for (const projectOnlyRoot of ['.github', '.opencode', '.pi']) {
            assert.equal(
                existsSync(join(home, projectOnlyRoot)),
                false,
                `installer created project-only root ${projectOnlyRoot} under HOME`,
            );
        }

        const collisionHome = join(work, 'collision-home');
        mkdirSync(join(collisionHome, '.agents', 'skills', 'cycle-setup'), { recursive: true });
        const collision = spawnSync('bash', [join(packageRoot, 'install.sh')], {
            encoding: 'utf8', env: { ...process.env, HOME: collisionHome },
        });
        assert.notEqual(collision.status, 0, 'installer silently accepted a real-directory collision');
        assert.match(collision.stderr, /refusing to replace existing directory or file/);
        assert.equal(existsSync(join(collisionHome, '.local', 'bin', 'cycle')), false, 'CLI linked before skill preflight failed');
        assert.equal(
            existsSync(join(collisionHome, '.claude', 'skills', 'cycle-setup')),
            false,
            'Claude skill linked before agent-skill preflight failed',
        );

        const cliCollisionHome = join(work, 'cli-collision-home');
        mkdirSync(join(cliCollisionHome, '.local', 'bin'), { recursive: true });
        writeFileSync(join(cliCollisionHome, '.local', 'bin', 'cycle'), 'owned by another install\n');
        const cliCollision = spawnSync('bash', [join(packageRoot, 'install.sh')], {
            encoding: 'utf8', env: { ...process.env, HOME: cliCollisionHome },
        });
        assert.notEqual(cliCollision.status, 0, 'installer silently replaced a real CLI file');
        assert.match(cliCollision.stderr, /refusing to replace existing directory or file/);
        assert.equal(
            readFileSync(join(cliCollisionHome, '.local', 'bin', 'cycle'), 'utf8'),
            'owned by another install\n',
            'installer changed the colliding CLI file before refusing it',
        );
        assert.equal(
            existsSync(join(cliCollisionHome, '.claude', 'skills', 'cycle-setup')),
            false,
            'skill linked before CLI preflight failed',
        );

        const directoryLinkHome = join(work, 'directory-link-home');
        const unexpectedDirectory = join(directoryLinkHome, 'unexpected-directory');
        mkdirSync(join(directoryLinkHome, '.local', 'bin'), { recursive: true });
        mkdirSync(unexpectedDirectory);
        symlinkSync(unexpectedDirectory, join(directoryLinkHome, '.local', 'bin', 'cycle'), 'dir');
        execFileSync('bash', [join(packageRoot, 'install.sh')], {
            encoding: 'utf8', env: { ...process.env, HOME: directoryLinkHome },
        });
        assert.equal(
            readlinkSync(join(directoryLinkHome, '.local', 'bin', 'cycle')),
            join(packageRoot, 'bin', 'cycle.mjs'),
            'installer followed a directory symlink instead of replacing it',
        );
        assert.deepEqual(readdirSync(unexpectedDirectory), [], 'installer wrote through a directory symlink');

        const repo = join(work, 'consumer');
        mkdirSync(repo);
        execFileSync('git', ['init', '-q', '.'], { cwd: repo });
        writeFileSync(join(repo, 'package.json'), '{"name":"packed-smoke"}\n');
        execFileSync(process.execPath, [
            join(packageRoot, 'bin', 'cycle.mjs'),
            'install', '-y', '--set', 'harnesses=["claude"]',
        ], {
            cwd: repo, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
        });
        assert.ok(existsSync(join(repo, '.claude', 'skills', 'DOCTRINE.md')));
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
});
