import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import DatabaseConfig from './config.js';

const execAsync = promisify(exec);

async function generateTypes() {
  const config = new DatabaseConfig();

  const databaseUrl = `postgresql://${config.user}:${config.password}@${config.host}:${config.port.toString()}/${config.database}`;

  console.log(
    `Generating types from database: ${config.host}:${config.port.toString()}/${config.database}`,
  );

  try {
    const { stdout, stderr } = await execAsync(
      `kysely-codegen --dialect postgres --out-file src/database.types.ts`,
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
        },
      },
    );

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    console.log('Types generated successfully');
  } catch (error) {
    console.error('Failed to generate types:', error);
  }
}

void generateTypes();
