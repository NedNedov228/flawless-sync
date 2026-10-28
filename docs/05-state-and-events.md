# State and Event Management

## 1. The Obsidian Event Bus

Obsidian provides a global EventBus through the `app.vault` object. Flawless Sync hooks into these events to provide immediate "Live Sync" functionality.

Supported events:
- `modify`: Triggered when a file's content changes.
- `create`: Triggered when a new file is made.
- `delete`: Triggered when a file is removed.
- `rename`: Triggered when a file is moved or renamed.

### Memory Leak Prevention
A critical aspect of writing a long-running Obsidian plugin is cleaning up EventBus listeners. When settings change (e.g., toggling Live Sync on/off), listeners must be de-registered.

Flawless Sync implements an idempotent event registration pattern:
```typescript
setupLiveSyncEvents(): void {
  // If events are already registered, we just update the debounce timer.
  // We avoid repeatedly un-registering and re-registering to prevent internal array growth.
  if (this.eventRefs.length === 0) {
    this.eventRefs.push(this.app.vault.on('modify', () => { if (this.settings.liveSync) this.liveSyncDebounce(); }));
    this.eventRefs.push(this.app.vault.on('create', () => { if (this.settings.liveSync) this.liveSyncDebounce(); }));
    // ...
    for (const ref of this.eventRefs) {
      this.registerEvent(ref);
    }
  }
}
```

## 2. Debouncing

When you type in Obsidian, the `modify` event can fire dozens of times per second (on every keystroke). Immediately invoking S3 syncs on every keystroke would quickly result in rate limiting and intense battery drain.

We use Obsidian's built-in `debounce` utility to wait for the user to pause typing before initiating the sync:

```typescript
// Trailing edge debounce (wait for typing/saving burst to finish)
this.liveSyncDebounce = debounce(() => {
  void this.runSync(false);
}, this.settings.liveSyncDebounceMs);
```

The same debounce pattern is applied to the settings UI (`settingsTab.ts`). To prevent the app from freezing or thrashing the disk with `saveData` JSON writes while the user types their S3 bucket name, the settings save is debounced by 1000ms.

## 3. Persistent State

The plugin uses Obsidian's `loadData()` and `saveData()` to persist:
1. **User Settings**: Credentials, region, polling MS, etc.
2. **File States (`StateManager`)**: The mapping of local paths to S3 ETags.

Because the plugin's internal data shape may change across versions, `main.ts` includes a `normalizePluginData` migration function. This ensures that users upgrading from older versions never lose their configuration.
