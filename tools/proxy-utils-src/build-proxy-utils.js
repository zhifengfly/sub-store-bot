#!/usr/bin/env node
const fs = require('fs'), path = require('path'), peggy = require('peggy');
const ROOT = __dirname, SRC = path.join(ROOT, 'src');
const BUILD = path.join(ROOT, '.build'), OUTPUT = path.join(ROOT, '..', '..', 'proxy-utils.esm.js');
const PG = path.join(BUILD, 'src/core/proxy-utils/parsers/peggy');
const GD = path.join(PG, 'generated');
function md(p) { fs.mkdirSync(p, { recursive: true }); }
function clean() {
  fs.rmSync(BUILD, { recursive: true, force: true }); md(BUILD);
  fs.cpSync(SRC, path.join(BUILD, 'src'), { recursive: true });
}
function compilePeg() {
  md(GD);
  const files = fs.readdirSync(PG).filter(f => f.endsWith('.js') && fs.readFileSync(path.join(PG, f), 'utf8').includes('String.raw`'));
  for (const fn of files) {
    const s = fs.readFileSync(path.join(PG, fn), 'utf8');
    const m = s.match(/String\.raw`([\s\S]*?)`;/);
    if (!m) { console.log('skip', fn); continue; }
    const g = require('peggy').generate(m[1], { output: 'source', format: 'es' });
    const o = path.join(GD, fn.replace('.js','')+'.js');
    fs.writeFileSync(o, '// auto-gen\n' + g + '\nlet cp=null;export default function gf(){if(!cp)cp=peg$parse;gf.parse=peg$parse;return cp;}\n');
  }
  let idx = fs.readFileSync(path.join(BUILD, 'src/core/proxy-utils/parsers/index.js'), 'utf8');
  for (const fn of files) idx = idx.replaceAll('./peggy/'+fn.replace('.js',''), './peggy/generated/'+fn.replace('.js',''));
  fs.writeFileSync(path.join(BUILD, 'src/core/proxy-utils/parsers/index.js'), idx);
}
async function bundle() {
  let esb;
  try { esb = require('esbuild'); } catch {}
  if (esb && typeof esb.build === 'function') {
    console.log('Using esbuild');
    const r = await esb.build({
      entryPoints: [path.join(BUILD, 'src/core/proxy-utils/index.js')],
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
      minify: true, treeShaking: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      alias: { '@': path.join(BUILD, 'src') },
      external: ['buffer'],
    });
    let c = r.outputFiles[0].text;
    if (!c.includes('const process'))
      c = 'const process={env:{NODE_ENV:"production"},nextTick:cb=>cb(),platform:"",version:""};\n' + c;
    fs.writeFileSync(OUTPUT, c);
    console.log('Output:', OUTPUT, 'size:', (fs.statSync(OUTPUT).size/1024).toFixed(1)+'KB');
  } else {
    console.log('esbuild unavailable, using rollup');
    const rollup = (await import('rollup')).rollup;
    const {nodeResolve} = await import('@rollup/plugin-node-resolve');
    const commonjs = await import('@rollup/plugin-commonjs');
    const json = await import('@rollup/plugin-json');
    const b = await rollup({
      input: path.join(BUILD, 'src/core/proxy-utils/index.js'),
      plugins: [
        { name: 'a', resolveId(src) {
          if (!src.startsWith('@/')) return;
          const b2 = path.join(BUILD, 'src', src.slice(2));
          if (fs.existsSync(b2) && fs.statSync(b2).isDirectory()) return path.join(b2, 'index.js');
          const j = b2.endsWith('.js')?b2:b2+'.js';
          if (fs.existsSync(j)) return j;
        }},
        json.default(), commonjs.default({ ignoreTryCatch: true }),
        nodeResolve({ preferBuiltins: false, browser: true }),
      ],
    });
    const {output} = await b.generate({ format: 'esm', exports: 'named' });
    let c = '/* proxy-utils */\nconst process={env:{NODE_ENV:"production"},nextTick:cb=>cb(),platform:"",version:""};\n' + output[0].code;
    fs.writeFileSync(OUTPUT, c);
    console.log('Output:', OUTPUT, 'size:', (fs.statSync(OUTPUT).size/1024).toFixed(1)+'KB');
  }
}
(async()=>{clean();compilePeg();await bundle();})().catch(e=>{console.error(e);process.exit(1);});