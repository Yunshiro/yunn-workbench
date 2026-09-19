# Yunn Workbench Desktop

Electron desktop shell for the existing React and Express application.

## Development

```bash
npm run install:all
npm run install:desktop
npm run desktop
```

The desktop build compiles the web client and server, copies both into `desktop/runtime`, starts the Express server on a random loopback port, and opens it in a sandboxed Electron window.

Application data is stored under Electron's per-user `userData/data` directory.

## Packaging

Run the packaging command on each target operating system:

```bash
npm run make:desktop
```

- macOS produces DMG and ZIP artifacts.
- Windows produces a Squirrel installer.

macOS and Windows releases must be built on their respective operating systems because Pi Agent includes platform-specific native modules. Production releases should also be code-signed and, on macOS, notarized.
