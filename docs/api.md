# JavaScript API


The package is ESM. Import policy decisions from `seisin`; the same functions
back the CLI. TypeScript declarations ship with the package. Install it in the project that
imports it — a global install puts the CLI on your PATH, not the package where `import` looks:

```bash
npm install seisin
```

```js
import { loadConfig, explain, ownersOf } from "seisin";

const config = loadConfig("seisin.toml");
console.log(ownersOf(config, "src/api/server.js"));
console.log(explain(config, "frontend", "write", "src/api/server.js"));
```

The stable surface covers policy loading (`findConfig`, `loadConfig`,
`parseToml`) and where it lives (`CONFIG_NAME`, `STATE_DIR`, `LOG_NAME`), ownership and
explanations (`covers`, `ownersOf`, `keyHolders`, `explain`, `explainFileRead`, `readTarget`),
resolved sandbox settings (`settingsFor`), key references (`parseKey`, `defaultName`,
`entriesOf`, `MODES`), inspection and scanning (`inspect`, `sharedPaths`, `scan`), activity
and requests (`readLog`, `logPath`, `observed`, `pendingRequests`, `requestQueue`,
`requestsPath`, `grantFor`, `generalise`), handoffs (`decideHandoff`, `MAX_DEPTH`,
`recordHandoff`), walls (`walls`, `wasted`), and hook decisions (`targetsOf`, `decide`).
Granting is not in it: a grant is a person's, through the CLI or the console.
Sandbox tuning constants, environment construction and output masking remain
internal; they may change without an API compatibility promise.

