# AGENTS.md - Syncthing Indicator GNOME Shell Extension

## Project Overview

GNOME Shell extension (GJS) for monitoring and controlling Syncthing. Supports GNOME Shell 45-50.

## Build Commands

### Generate Extension Package

```bash
./make.sh
```

Generates translations, compiles schemas, creates zip for distribution.

### Manual Installation

```bash
./install.sh
```

### Debugging

```bash
clear && export G_MESSAGES_DEBUG=all && dbus-run-session -- gnome-shell --devkit --wayland | grep syncthing-indicator
```

### Testing

No test framework exists. Manual testing by building, installing, restarting GNOME Shell, and checking logs.

## Code Style Guidelines

### General

- **Language**: GJS (GNOME JavaScript), ES6+
- **Indentation**: 4 spaces (no tabs)
- **Line length**: ~120 characters max
- **No trailing whitespace**

### Imports

```javascript
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Syncthing from "./syncthing.js";
import Config from "./config.js";
```

### Naming

- **Classes**: PascalCase (e.g., `SyncthingIndicatorExtension`)
- **Methods/Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- **Private fields**: `#field` (hash prefix)
- **Files**: kebab-case

### Private Fields

```javascript
class Manager extends Utils.Emitter {
  #httpSession = new Soup.Session();
  #serviceActive = false;
}
```

### GObject Classes

```javascript
export const SyncthingPanelIcon = GObject.registerClass(
  class SyncthingPanelIcon extends St.Icon {
    _init(extension) {
      super._init({ icon_size: 18 });
    }
  },
);
```

### Events/Signals

```javascript
manager.connect(Signal.STATE_CHANGE, (manager, state) => {
  // handle
});
```

### Logging

```javascript
const LOG_PREFIX = "syncthing-indicator-manager:";
console.debug(LOG_PREFIX, "message");
console.info(LOG_PREFIX, "message");
console.warn(LOG_PREFIX, "message");
console.error(LOG_PREFIX, "message");
```

### Error Handling

```javascript
try {
  const data = await this.#serviceCall("GET", "/rest/system/config");
} catch (error) {
  console.error(LOG_PREFIX, "error", error);
}
```

### Constants Pattern

```javascript
export const Signal = {
  LOGIN: "login",
  ADD: "add",
  STATE_CHANGE: "stateChange",
};

export const State = {
  IDLE: "idle",
  SYNCING: "syncing",
};
```

### File Header

```javascript
/* =============================================================================================================
   <filename> 0.50
===============================================================================================================
    <Description>
    Copyright (c) 2019-2026, 2nv2u <info@2nv2u.com>
    This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================== */
```

### Code Organization

1. Imports (GI, GNOME Shell, local)
2. Constants (LOG_PREFIX, config)
3. Exported objects (Signal, State, Error)
4. Classes (base first, then derived)
5. Helper functions

### Key Patterns

**Timer:**

```javascript
const timer = new Utils.Timer(1000);
timer.run(() => {
  /* delayed action */
});
```

**Async sleep:**

```javascript
await Utils.sleep(2000);
```

**Promise wrapper:**

```javascript
async #serviceCall(method, path) {
  return new Promise((resolve, reject) => {
    try {
      this.#openConnection(method, path, resolve);
    } catch (error) { reject(error); }
  });
}
```

### What NOT to Do

- NO `var` - use `const`/`let`
- NO CommonJS require - use ES6 import
- NO `function()` - use arrow functions
- NO `this` for private - use `#privateField`
- NO logging sensitive data (API keys)
- NO external npm packages - only GJS/GI

### Dependencies Used

- `gi://Gio` - File I/O, subprocesses
- `gi://GLib` - Timers, utilities
- `gi://Soup` - HTTP client
- `gi://St` - Shell Toolkit UI
- `gi://Adw` - libadwaita (preferences)
- `gi://GObject` - GObject bindings

### File Structure

```
src/
├── extension.js    # Entry point
├── prefs.js        # Preferences window
├── syncthing.js    # Manager/API logic
├── config.js       # Configuration handling
├── utils.js        # Timer, Emitter, I18N
├── components.js   # UI components
├── quickSetting.js # Quick Settings indicator
├── stylesheet.css  # Styles
├── metadata.json   # Extension metadata
└── schemas/       # GSettings schemas
```

### Troubleshooting

- Check `metadata.json` shell-version compatibility
- JavaScript errors: `journalctl /usr/bin/gnome-shell`
- Verify schema compiled: `glib-compile-schemas src/schemas/`
- Ensure `./make.sh` run after locale changes

### Issues

- Bug reports and feature requests: https://github.com/2nv2u/gnome-shell-extension-syncthing-indicator
