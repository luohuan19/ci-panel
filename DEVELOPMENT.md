## Setting Up Development Environment

This section is **for developers**. If you want to develop ci-panel or contribute code, please read this content carefully:

### Required Environment

- Node.js v16+

We use `Visual Studio Code` to develop ci-panel, we **highly recommend** these plugins:

- i18n Text Display Support (I18n Ally)
- Code Formatting (Prettier)
- Vue - Official
- ESLint

<br />

### Getting Started

#### 1. Download the Source Code

```bash
git clone https://github.com/pypto-tools/ci-panel.git
cd ci-panel
```

#### 2. Download Binary Dependency Files

You need to visit the [PTY](https://github.com/MCSManager/PTY/releases) and [Zip-Tools](https://github.com/MCSManager/Zip-Tools/releases) projects to download binary files compatible with your system, and place them in the `daemon/lib` directory (create it manually if it doesn't exist) to ensure the proper functioning of the `simulated terminal` and `file decompression`.

Download three dependency files, selecting them based on your system architecture. Check the Releases to find binary files suitable for your system and architecture.

For example:

```bash
# Manually create binary dependency library folder
mkdir lib && cd lib

# Simulated terminal dependency library
wget https://github.com/MCSManager/PTY/releases/download/latest/pty_linux_x64
# wget https://github.com/MCSManager/PTY/releases/download/latest/pty_darwin_arm64 # MacOS Arm architecture

# Decompression & compression file dependency library
wget https://github.com/MCSManager/Zip-Tools/releases/download/latest/file_zip_linux_x64

# 7z archive support (optional)
wget https://github.com/MCSManager/Zip-Tools/releases/download/latest/7z_linux_x64


# For other OS & CPU architectures, please download from here:
# PTY: https://github.com/MCSManager/PTY/releases
# Zip-Tools: https://github.com/MCSManager/Zip-Tools/releases
# 7z: https://github.com/MCSManager/Zip-Tools/releases

```

#### 3. Install Node.js Dependencies

```bash

# MacOS / Linux
./install-dependents.sh

# Windows
./install-dependents.bat
```

#### 4. Run ci-panel

```bash
npm run dev
```

`npm run dev` runs all three packages under `concurrently` in the foreground.

For a long-lived background dev instance — where the backend has to be rebuilt after
every edit, you want to reach it over a port, and the machine may also be a CI node —
use the one-shot script instead:

```bash
bash dev.sh              # preflight → deps → build if stale → start → health check → next steps
bash dev.sh --rebuild    # force a full rebuild
bash dev.sh --no-build   # just start the services
bash stop-cipanel.sh     # stop everything
```

How it differs from `npm run dev`:

- Missing `node_modules` and `daemon/lib` binaries are installed automatically
  (binaries are verified against `lib-checksums.txt` and deleted on mismatch)
- `panel/` and `daemon/` run the webpack bundle `production/app.js`, so the script
  rebuilds them when their sources change and **restarts only what it rebuilt**
  (the frontend is left to vite's HMR)
- **It confines the dev instance to its own scan root**, `.run/dev-runner-root`. On a
  host that is also a managed runner node, sharing one runner root between two daemons
  means a misclick in the dev panel stops a runner serving CI. Logs land in `.run/*.log`

Whenever the frontend runs under the vite dev server (`npm run dev` or `bash dev.sh`),
the browser tab title is prefixed with `[dev] ` so a dev tab is never mistaken for a
production one. Production builds (`vite build`) carry no prefix and need no
configuration — the check is `import.meta.env.DEV`, see `frontend/src/tools/devTitle.ts`.

<br />

### Internationalizing Your Code

Since the project supports multiple languages, all `strings` and `comments` in the code must be in English only. Do not hardcode non-English text directly in the code.

For example, if you write a new string that needs to support multiple languages:

```ts
import { $t } from "../i18n";

if (!checkName) {
  const errorMsg = "Hello，这是一个错误！"; // Don't do this!
  const errorMsg = $t("TXT_CODE_MY_ERROR"); // Correct approach
}

// Usage with parameters, only Web backend, Daemon Backend.
const errorMsgWithParams = $t("TXT_CODE_INSTANCE_ERROR", {
  uuid: instance.instanceUuid,
  err: err
});
```

languages/en_US.json

```json
{
  // All translation text Keys must be unique, so please use a longer name if possible! frontend only.
  "TXT_CODE_MY_ERROR": "Hello，这是一个错误！",
  // If parameters are needed, use double curly braces. only Web backend, Daemon Backend.
  "TXT_CODE_INSTANCE_ERROR": "Exception instance {{uuid}}: {{err}}"
}
```

```html
<script lang="ts" setup>
  import { t } from "@/lang/i18n";
  // ...
</script>

<template>
  <!-- ... -->
  <a-menu-item key="toNodesPage" @click="toNodesPage()">
    <FormOutlined />
    {{ t("TXT_CODE_NODE_INFO") }}

    <!-- If parameters are needed, frontend code uses single curly braces -->
    <div>{{ t("TXT_CODE_FILE_ERROR", { name: props.fileName }) }}</div>
  </a-menu-item>
</template>
```

languages/en_US.json

```json
{
  "TXT_CODE_NODE_INFO": "Jump to Node Page",
  // If parameters are needed, frontend code uses single curly braces
  "TXT_CODE_FILE_ERROR": "File {name} error!"
}
```

Please add this line to the language file, for example: `languages/en_US.json`

> All language texts are in `languages/*.json`, with all translations based on `en_US.json`. Therefore, if you modify any text or add any new files, `en_US.json` **must be modified and updated**, as it is the source text for all countries' languages. Other countries' languages can be automatically translated by us using AI.

If you have the `I18n Ally` plugin installed, your `$t("TXT_CODE_MY_ERROR")` should display the corresponding text.

<br />

### Building Production Version

```bash
./build.bat # Windows
./build.sh  # MacOS
```

After the build is complete, you will find the production code in the `production-code` directory.

<br />

### Finally

The binary helpers (`pty`, `file_zip`, `7z`) come from the upstream
[MCSManager](https://github.com/MCSManager/MCSManager) project; their release
pages are the authoritative source for new architectures.
