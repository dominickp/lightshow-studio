import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { projectJsonSchema } from '@dmxsim/show-model';

const schemaPath = fileURLToPath(
  new URL('../../../docs/agent_docs/project-file.schema.json', import.meta.url),
);
writeFileSync(schemaPath, `${JSON.stringify(projectJsonSchema(), null, 2)}\n`);
console.log(`wrote ${schemaPath}`);
