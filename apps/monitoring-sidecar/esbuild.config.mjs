import { build } from 'esbuild';

await build({
  entryPoints: ['dist/src/index.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/bundle.mjs',
  plugins: [
    {
      name: 'externalize-non-scribear',
      setup(build) {
        // Externalize all imports that aren't relative, subpath (#), or @scribear workspace libs
        build.onResolve({ filter: /^[^./#]/ }, ({ path }) => {
          if (path.startsWith('@scribear/')) return null;
          return { path, external: true };
        });
      },
    },
  ],
});
