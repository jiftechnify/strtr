# strtr
Minimal Nostr relay implementation, for daily Nostr development.

## How to Use

Launch with `npx`:

```bash
npx strtr
```

Launch with a script:

```ts
import { launchRelay } from "strtr";

// launchRelay() returns a function that shutdown the relay server
const shutdown = launchRelay();

// work with the relay...

// after use, gracefully shutdown it
shutdown();
```

By default, the relay listen on `127.0.0.1:5454`. You can change it with options.

## Options

You can specify relay options by:

- Command line options
  + 
- Environment variables
  + Uppercased option names, prefixed with `STRTR_`
- Passing `RelayOptions` to `launchRelay()`

| Name | Short Name| Default | Description |
| -- | -- | -- | -- |
| `host` | `h` | `127.0.0.1`| Host to listen on |
| `port` | `p` | `5454` | Port to listen on |

### Example: Command Line Options

```bash
# long name
npx strtr --host 0.0.0.0 --port 9999

# short name
npx strtr -h 0.0.0.0 -p 9999
```

### Example: Environment variables

```bash
export STRTR_HOST=0.0.0.0
export STRTR_PORT=9999
npx strtr
```

### Example: `RelayOptions`

```ts
import { launchRelay, type RelayOptions } from "strtr";

// launchRelay() returns a function that shutdown the relay server
const shutdown = launchRelay({ host: "0.0.0.0", port: 9999 });
```

## Supported NIPs

- [x] NIP-01: Basic Protocol Flow
- [x] NIP-09: Event Deletion
