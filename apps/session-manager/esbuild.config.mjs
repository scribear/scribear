import { build } from 'esbuild';

// Two entry points, one image: the long-running server, and the one-shot schema
// migrator that `deployment/compose.yml`'s `db-migrate` service runs. Bundling
// the migrator here is what lets a deployment apply the schema from the same
// pinned artifact that queries it - see src/migrate.ts.
const ENTRIES = [
  { entryPoint: 'dist/src/index.js', outfile: 'dist/bundle.mjs' },
  { entryPoint: 'dist/src/migrate.js', outfile: 'dist/migrate.mjs' },
];

await Promise.all(
  ENTRIES.map(({ entryPoint, outfile }) =>
    build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
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
    }),
  ),
);
