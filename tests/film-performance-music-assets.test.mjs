import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// CI provides Python3; Windows can explicitly select its bundled interpreter.
// Do not invoke the Windows Store execution alias as an optional runtime probe.
const python = process.env.PYTHON_PATH || 'python3';
test('music asset verification accepts stripped unrelated docs but rejects changed or unbound font/license files',
  { skip: process.platform === 'win32' && !process.env.PYTHON_PATH ? 'Set PYTHON_PATH to run the actual Python asset verifier on Windows.' : false }, () => {
  const code = String.raw`
import hashlib,importlib.util,json,pathlib,sys,tempfile
spec=importlib.util.spec_from_file_location('performance_music',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='lineage-music-assets-test-') as directory:
    root=pathlib.Path(directory)
    font=root/'usr/share/sounds/sf2/FluidR3_GM.sf2'
    license=root/'usr/share/doc/fluid-soundfont-gm/copyright'
    manifest=root/'var/lib/dpkg/info/fluid-soundfont-gm.md5sums'
    for path in (font,license,manifest):path.parent.mkdir(parents=True,exist_ok=True)
    font_bytes=b'fictional soundfont asset fixture only'
    license_bytes=b'fictional package copyright fixture only'
    def reset():
        font.write_bytes(font_bytes);license.write_bytes(license_bytes)
        lines=[hashlib.md5(data).hexdigest()+'  '+str(path.relative_to(root)).replace('\\','/')
               for path,data in ((font,font_bytes),(license,license_bytes))]
        lines+=['0'*32+'  usr/share/doc/fluid-soundfont-gm/README',
                '0'*32+'  usr/share/doc/fluid-soundfont-gm/README.Debian',
                '0'*32+'  usr/share/doc/fluid-soundfont-gm/changelog.Debian.gz']
        manifest.write_text('\n'.join(lines)+'\n')
    reset();module.verify_package_assets(font.resolve(),root)
    cases=0
    mutations=[lambda:font.write_bytes(b'changed font asset fixture value'),
               lambda:license.unlink(),lambda:license.write_bytes(b'changed license fixture value'),
               lambda:manifest.write_text('\n'.join(manifest.read_text().splitlines()[1:])+'\n'),
               lambda:manifest.write_text(manifest.read_text()+manifest.read_text().splitlines()[0]+'\n'),
               lambda:manifest.write_text('not-a-checksum'+manifest.read_text()[32:])]
    for mutate in mutations:
        reset();mutate()
        try:module.verify_package_assets(font.resolve(),root)
        except (ValueError,FileNotFoundError):cases+=1
        else:raise AssertionError('changed or unbound asset was accepted')
    assert cases==6
    print(json.dumps({'validStrippedDocsAccepted':True,'invalidCasesRejected':cases,'modelCalls':0}))
`;
  const result = spawnSync(python, ['-B', '-c', code, fileURLToPath(new URL('../scripts/film-performance-music.py', import.meta.url))],
    { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 100000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { validStrippedDocsAccepted: true, invalidCasesRejected: 6, modelCalls: 0 });
});
