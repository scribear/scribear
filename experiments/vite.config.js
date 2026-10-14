import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default {
  server: {
    host: true,
    https: {
      key: fs.readFileSync(
        path.join(directory, "100.70.41.81-key.pem")
      ),
      cert: fs.readFileSync(
        path.join(directory, "100.70.41.81.pem")
      ),
    },
  },
};
