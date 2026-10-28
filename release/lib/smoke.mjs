// Runs an unpacked CLI archive as a user would: `erden doctor` must report both engines verified against their pins
// (installed platform packages, self-tests passed), `erden init` must create a project, and `erden check` and
// `erden pack` must pass on a copy of examples/erden-demo. Everything runs with a temporary home, so nothing is
// written into the archive tree or the user's directories.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function erden(root, args, home, cwd, name = 'erden') {
    const windows = process.platform === 'win32';
    const launcher = join(root, 'bin', windows ? `${name}.cmd` : name);
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') };
    delete env.ERDEN_REASONER_BIN;
    const child = windows
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${launcher}" ${args.join(' ')}`], {
              cwd,
              encoding: 'utf8',
              env,
              windowsHide: true,
          })
        : spawnSync(launcher, args, { cwd, encoding: 'utf8', env });
    if (child.status !== 0) {
        throw new Error(`erden ${args.join(' ')} failed (${String(child.status)}): ${child.stderr}${child.stdout}`);
    }
    return child.stdout;
}

/** The smoke run's summary; throws on the first failure. */
export function smokeTest(root, demo) {
    const temporary = mkdtempSync(join(tmpdir(), 'erden-release-smoke-'));
    try {
        const home = join(temporary, 'home');
        cpSync(demo, join(temporary, 'demo'), { recursive: true });
        const help = erden(root, ['help'], home, temporary);
        if (erden(root, ['help'], home, temporary, 'den') !== help) {
            throw new Error('den and erden did not execute the same CLI');
        }
        const doctor = JSON.parse(erden(root, ['doctor', '--json'], home, temporary));
        for (const [name, engine] of [
            ['reasoner', doctor.reasoner],
            ['SHACL engine', doctor.shaclEngine],
        ]) {
            if (
                engine?.availability !== 'available' ||
                engine.selfTest?.status !== 'passed' ||
                engine.actualPlatformPackage !== engine.expectedPlatformPackage ||
                engine.actualPlatformPackage === 'source-build'
            ) {
                throw new Error(`erden doctor did not verify the ${name}: ${JSON.stringify(engine)}`);
            }
        }
        if (doctor.outcome !== 'passed') {
            throw new Error(`erden doctor failed: ${JSON.stringify(doctor)}`);
        }
        erden(root, ['init', 'project', '--json'], home, temporary);
        erden(root, ['check', 'demo', '--json'], home, temporary);
        erden(root, ['pack', '0.0.1', 'demo', '--json'], home, temporary);
        return {
            doctor: 'passed',
            reasoner: { package: doctor.reasoner.actualPlatformPackage, digest: doctor.reasoner.digest },
            shaclEngine: { package: doctor.shaclEngine.actualPlatformPackage, digest: doctor.shaclEngine.digest },
            init: 'passed',
            check: 'passed',
            pack: 'passed',
        };
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}
