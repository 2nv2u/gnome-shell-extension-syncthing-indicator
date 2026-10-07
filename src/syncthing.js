/* =============================================================================================================
	SyncthingManager
================================================================================================================

	GJS Syncthing manager - API calls, systemd service control, and event processing.

	Copyright (c) 2019-2026, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup";

import * as Utils from "./utils.js";

const LOG_PREFIX = "syncthing-indicator-manager:";
const CONNECTION_RETRY_DELAY = 1000;
const DEVICE_STATE_DELAY = 50;
const ITEM_STATE_DELAY = 50;
const REFRESH_INTERVAL = 10000;
const REFRESH_RETRY_DELAY = 1000;
const HTTP_ERROR_RETRIES = 3;
const SYSTEMD_COMMAND = "systemctl";
const SYSTEMD_RETRIES = 3;
const SYSTEMD_RETRY_DELAY = 2000;

// Error constants
export const Error = {
  LOGIN: "Login attempt failed",
  DAEMON: "Service failed to start",
  SERVICE: "Service reported error",
  STREAM: "Stream parsing error",
  CONNECTION: "Connection status error",
  CONFIG: "Config not found",
};

// Service constants
export const Service = {
  NAME: "syncthing",
};

// Signal constants
export const Signal = {
  LOGIN: "login",
  ADD: "add",
  DESTROY: "destroy",
  NAME_CHANGE: "nameChange",
  SERVICE_CHANGE: "serviceChange",
  HOST_ADD: "hostAdd",
  FOLDER_ADD: "folderAdd",
  DEVICE_ADD: "deviceAdd",
  STATE_CHANGE: "stateChange",
  ERROR: "error",
  PENDING_REQUEST: "pendingRequest",
};

// State constants
export const State = {
  UNKNOWN: "unknown",
  IDLE: "idle",
  SCANNING: "scanning",
  SYNCING: "syncing",
  PAUSED: "paused",
  ERRONEOUS: "erroneous",
  DISCONNECTED: "disconnected",
};

// Service state constants
export const ServiceState = {
  USER_ACTIVE: "userActive",
  USER_STOPPED: "userStopped",
  USER_ENABLED: "userEnabled",
  USER_DISABLED: "userDisabled",
  SYSTEM_ACTIVE: "systemActive",
  SYSTEM_STOPPED: "systemStopped",
  SYSTEM_ENABLED: "systemEnabled",
  SYSTEM_DISABLED: "systemDisabled",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ERROR: "error",
};

// Syncthing state to extension state mapping
const SYNCTHING_STATE_MAP = {
  idle: State.IDLE,
  syncing: State.SYNCING,
  scanning: State.SCANNING,
  paused: State.PAUSED,
  outofsync: State.ERRONEOUS,
  faileditems: State.ERRONEOUS,
  unshared: State.PAUSED,
  "sync-waiting": State.SYNCING,
  "clean-waiting": State.SYNCING,
};

// Map Syncthing folder state to extension state
function mapSyncthingState(state) {
  return SYNCTHING_STATE_MAP[state] || state;
}

// Signal constants
export const EventType = {
  CONFIG_SAVED: "ConfigSaved",
  DEVICE_CONNECTED: "DeviceConnected",
  DEVICE_DISCONNECTED: "DeviceDisconnected",
  DEVICE_DISCOVERED: "DeviceDiscovered",
  DEVICE_PAUSED: "DevicePaused",
  DEVICE_REJECTED: "DeviceRejected",
  DEVICE_RESUMED: "DeviceResumed",
  DOWNLOAD_PROGRESS: "DownloadProgress",
  FAILURE: "Failure",
  FOLDER_COMPLETION: "FolderCompletion",
  FOLDER_ERRORS: "FolderErrors",
  FOLDER_PAUSED: "FolderPaused",
  FOLDER_REJECTED: "FolderRejected",
  FOLDER_RESUMED: "FolderResumed",
  FOLDER_SCAN_PROGRESS: "FolderScanProgress",
  FOLDER_SUMMARY: "FolderSummary",
  FOLDER_WATCH_STATE_CHANGED: "FolderWatchStateChanged",
  ITEM_FINISHED: "ItemFinished",
  ITEM_STARTED: "ItemStarted",
  LISTEN_ADDRESSES_CHANGED: "ListenAddressesChanged",
  LOCAL_CHANGE_DETECTED: "LocalChangeDetected",
  LOCAL_INDEX_UPDATED: "LocalIndexUpdated",
  LOGIN_ATTEMPT: "LoginAttempt",
  PENDING_DEVICES_CHANGED: "PendingDevicesChanged",
  PENDING_FOLDERS_CHANGED: "PendingFoldersChanged",
  REMOTE_CHANGE_DETECTED: "RemoteChangeDetected",
  REMOTE_DOWNLOAD_PROGRESS: "RemoteDownloadProgress",
  REMOTE_INDEX_UPDATED: "RemoteIndexUpdated",
  STARTING: "Starting",
  STARTUP_COMPLETE: "StartupComplete",
  STATE_CHANGED: "StateChanged",
};

// Base item class for folders and devices
class Item extends Utils.Emitter {
  #name;
  #state;
  #stateEmitted = State.UNKNOWN;
  #stateTimer = new Utils.Timer(ITEM_STATE_DELAY);
  #destroyed = false;

  constructor(data, manager) {
    super();
    this.#state = State.UNKNOWN;
    this.id = data.id;
    this.#name = data.name;
    this._manager = manager;
  }

  isBusy() {
    return this.state === State.SYNCING || this.state === State.SCANNING;
  }

  set state(state) {
    if (state.length > 0 && this.#state !== state) {
      this.#stateTimer.cancel();
      console.info(LOG_PREFIX, "state change", this.#name, state);
      this.#state = state;
      this.#stateTimer.run(() => {
        if (this.#destroyed) return;
        if (this.#stateEmitted !== this.#state) {
          console.debug(
            LOG_PREFIX,
            "emit state change",
            this.#name,
            this.#state,
          );
          this.#stateEmitted = this.#state;
          this.emit(Signal.STATE_CHANGE, this.#state);
        }
      });
    }
  }

  get state() {
    return this.#state;
  }

  set name(name) {
    if (name.length > 0 && this.#name != name) {
      console.info(LOG_PREFIX, "emit name change", this.#name, name);
      this.#name = name;
      this.emit(Signal.NAME_CHANGE, this.#name);
    }
  }

  get name() {
    return this.#name;
  }

  destroy() {
    this.#destroyed = true;
    this.#stateTimer.destroy();
    this.emit(Signal.DESTROY);
  }
}

// Collection of items with add/remove functionality
class ItemCollection extends Utils.Emitter {
  #collection = {};

  constructor() {
    super();
  }

  add(item) {
    if (item instanceof Item) {
      console.info(LOG_PREFIX, "add", item.constructor.name, item.name);
      this.#collection[item.id] = item;
      item.connect(Signal.DESTROY, (_item) => {
        delete this.#collection[_item.id];
      });
      this.emit(Signal.ADD, item);
    }
  }

  get ids() {
    return Object.keys(this.#collection);
  }

  destroy(id) {
    if (id) {
      let item = this.#collection[id];
      delete this.#collection[id];
      item.destroy();
      this.emit(Signal.DESTROY, item);
    } else {
      this.foreach((_item) => {
        this.destroy(_item.id);
      });
    }
  }

  get(id) {
    return this.#collection[id];
  }

  exists(id) {
    return id in this.#collection;
  }

  foreach(handler) {
    Object.values(this.#collection).forEach(handler);
  }
}

// Remote device item
class Device extends Item {
  #determineTimer = new Utils.Timer(DEVICE_STATE_DELAY);
  #folderAddSignal;
  #folderStateSignals = new Map();

  constructor(data, manager) {
    super(data, manager);
    this.folders = new ItemCollection();
    this.#folderAddSignal = this.folders.connect(
      Signal.ADD,
      (collection, folder) => {
        this.#folderStateSignals.set(
          folder,
          folder.connect(
            Signal.STATE_CHANGE,
            this.determineStateDelayed.bind(this),
          ),
        );
      },
    );
  }

  isOnline() {
    return this.state != State.DISCONNECTED && this.state != State.PAUSED;
  }

  determineStateDelayed() {
    // Stop items from excessive state change calculations by only emitting 1 state per stateDelay
    this.#determineTimer.run(this.determineState.bind(this));
  }

  determineState() {
    if (this.isOnline()) {
      this.state = State.PAUSED;
      this.folders.foreach((folder) => {
        if (!this.isBusy()) {
          console.info(
            LOG_PREFIX,
            "determine device state",
            this.name,
            folder.name,
            folder.state,
          );
          this.state = folder.state;
        }
      });
    }
  }

  pause() {
    this._manager.pause(this);
  }

  resume() {
    this._manager.resume(this);
  }

  destroy() {
    for (const [folder, id] of this.#folderStateSignals) {
      folder.disconnect(id);
    }
    this.#folderStateSignals.clear();
    this.folders.disconnect(this.#folderAddSignal);
    this.#determineTimer.destroy();
    super.destroy();
  }
}

// Local host device
class HostDevice extends Device {
  #deviceAddSignal;
  #deviceStateSignals = new Map();

  constructor(data, manager) {
    super(data, manager);
    this.#deviceAddSignal = this._manager.connect(
      Signal.DEVICE_ADD,
      (manager, device) => {
        this.#deviceStateSignals.set(
          device,
          device.connect(
            Signal.STATE_CHANGE,
            this.determineStateDelayed.bind(this),
          ),
        );
      },
    );
    this._manager.devices.foreach((device) => {
      this.#deviceStateSignals.set(
        device,
        device.connect(
          Signal.STATE_CHANGE,
          this.determineStateDelayed.bind(this),
        ),
      );
    });
    this.determineState();
  }

  destroy() {
    for (const [device, id] of this.#deviceStateSignals) {
      device.disconnect(id);
    }
    this.#deviceStateSignals.clear();
    this._manager.disconnect(this.#deviceAddSignal);
    super.destroy();
  }

  determineState() {
    this.state = State.PAUSED;
    this._manager.devices.foreach((device) => {
      if (this != device && !this.isBusy() && device.isOnline()) {
        console.info(
          LOG_PREFIX,
          "determine host device state",
          this.name,
          device.name,
          device.state,
        );
        this.state = device.state;
      }
    });
    if (!this.isBusy()) {
      super.determineState();
    }
  }
}

// Sync folder item
class Folder extends Item {
  constructor(data, manager) {
    super(data, manager);
    this.path = data.path;
    this.devices = new ItemCollection();
  }

  rescan() {
    this._manager.rescan(this);
  }
}

// Folder completion proxy for per-device sync status
class FolderCompletionProxy extends Folder {
  #folder;
  #device;

  constructor(data) {
    super(data.folder);
    this.#folder = data.folder;
    this.#device = data.device;
  }

  setCompletion(percentage) {
    if (percentage < 100) {
      this.state = State.SYNCING;
    } else {
      this.state = State.IDLE;
    }
  }

  get name() {
    return this.#folder.name + " (" + this.#device.name + ")";
  }
}

// Main system manager
export class Manager extends Utils.Emitter {
  #httpSession = new Soup.Session();
  #httpAborting = false;
  #destroyed = false;
  #eventsGeneration = 0;
  #httpErrorCount = 0;
  #serviceRetries = 0;
  #serviceActive = false;
  #serviceEnabled = false;
  #serviceUserMode = true;
  #serviceConnected = false;
  #refreshTimer = null;
  #refreshing = false;
  #lastEventID = 1;
  #hostID = "";
  #lastErrorTime = Date.now();
  #lastPendingCount = 0;
  #pendingDevices = {};
  #pendingFolders = {};
  #extensionConfig;
  #extensionPath;

  constructor(extensionConfig, extensionPath) {
    super();
    this.folders = new ItemCollection();
    this.devices = new ItemCollection();
    this.folders.connect(Signal.ADD, (collection, folder) => {
      this.emit(Signal.FOLDER_ADD, folder);
    });
    this.devices.connect(Signal.ADD, (collection, device) => {
      if (device instanceof HostDevice) {
        this.host = device;
        this.emit(Signal.HOST_ADD, this.host);
      } else {
        this.emit(Signal.DEVICE_ADD, device);
      }
    });
    this.#extensionConfig = extensionConfig;
    this.#extensionPath = extensionPath;
    this.connect(Signal.SERVICE_CHANGE, async (manager, state) => {
      try {
        switch (state) {
          case ServiceState.USER_ACTIVE:
          case ServiceState.SYSTEM_ACTIVE:
            const status = await this.#serviceCall(
              "GET",
              "/rest/system/status",
            );
            this.#hostID = status.myID;
            await this.#callConfig();
            this.#callEvents("limit=1");
            this.#scheduleRefresh();
            await this.#checkPendingRequests();
            break;
          case ServiceState.USER_STOPPED:
          case ServiceState.SYSTEM_STOPPED:
            this.#reset();
            this.#lastEventID = 1;
            this.#httpErrorCount = 0;
            if (this.#serviceConnected) {
              this.#serviceConnected = false;
              this.emit(Signal.SERVICE_CHANGE, ServiceState.DISCONNECTED);
            }
            break;
        }
      } catch (error) {
        console.debug(LOG_PREFIX, "service change error", error);
      }
    });
  }

  async #callConfig() {
    const config = await this.#serviceCall("GET", "/rest/system/config");
    await this.#processConfig(config);
    return config;
  }

  #callEvents(options, generation = ++this.#eventsGeneration) {
    if (this.#destroyed || generation != this.#eventsGeneration) {
      console.debug(
        LOG_PREFIX,
        "retiring stale event chain",
        generation,
        this.#eventsGeneration,
      );
      return;
    }
    this.#openConnection(
      "GET",
      "/rest/events?" + options,
      (events) => {
        if (this.#destroyed || generation != this.#eventsGeneration) return;
        for (let i = 0; i < events.length; i++) {
          this.#processEvent({
            type: events[i].type,
            data: events[i].data,
            id: events[i].id,
          });
        }
        this.#callEvents("since=" + this.#lastEventID, generation);
      },
      (error) => {
        if (this.#destroyed || generation != this.#eventsGeneration) return;
        if (!this.#serviceActive) return;
        console.debug(
          LOG_PREFIX,
          "events request failed, retrying in 1s",
          error.message,
        );
        Utils.Timer.run(REFRESH_RETRY_DELAY, () => {
          this.#callEvents("limit=1", generation);
        });
      },
    );
  }

  async #processEvent(event) {
    console.debug(LOG_PREFIX, "processing event", event.type, event.data);
    try {
      switch (event.type) {
        case EventType.STARTUP_COMPLETE:
          await this.#callConfig();
          break;
        case EventType.CONFIG_SAVED:
          await this.#processConfig(event.data);
          await this.#checkConfigSync();
          break;
        case EventType.LOGIN_ATTEMPT:
          if (event.data.success) {
            this.emit(Signal.LOGIN, event.data.username);
          } else {
            this.emit(Error.LOGIN, event.data.username);
          }
          break;
        case EventType.FOLDER_ERRORS:
          if (this.folders.exists(event.data.folder)) {
            this.folders.get(event.data.folder).state = State.ERRONEOUS;
          }
          break;
        case EventType.FOLDER_COMPLETION:
          if (
            this.folders.exists(event.data.folder) &&
            this.devices.exists(event.data.device)
          ) {
            let device = this.devices.get(event.data.device);
            if (device.folders.exists(event.data.folder)) {
              if (device.isOnline()) {
                device.state =
                  event.data.completion < 100 ? State.SYNCING : State.IDLE;
              }
              device.folders
                .get(event.data.folder)
                .setCompletion(event.data.completion);
            }
          }
          break;
        case EventType.FOLDER_SUMMARY:
          if (this.folders.exists(event.data.folder)) {
            this.folders.get(event.data.folder).state = mapSyncthingState(
              event.data.summary.state,
            );
          }
          break;
        case EventType.FOLDER_PAUSED:
          if (this.folders.exists(event.data.id)) {
            this.folders.get(event.data.id).state = State.PAUSED;
          }
          break;
        case EventType.FOLDER_RESUMED:
          if (this.folders.exists(event.data.id)) {
            this.folders.get(event.data.id).state = State.IDLE;
          }
          break;
        case EventType.FOLDER_WATCH_STATE_CHANGED:
          if (this.folders.exists(event.data.folder)) {
            const folder = this.folders.get(event.data.folder);
            if (event.data.error) {
              folder.state = State.ERRONEOUS;
            } else if (folder.state === State.ERRONEOUS) {
              this.#scheduleRefresh();
            }
          }
          break;
        case EventType.FOLDER_SCAN_PROGRESS:
          if (this.folders.exists(event.data.folder)) {
            this.folders.get(event.data.folder).state = State.SCANNING;
          }
          break;
        case EventType.STATE_CHANGED:
          if (this.folders.exists(event.data.folder)) {
            this.folders.get(event.data.folder).state = mapSyncthingState(
              event.data.to,
            );
          }
          if (
            event.data.from === "scanning" &&
            mapSyncthingState(event.data.to) === State.IDLE
          ) {
            this.#scheduleRefresh();
          }
          break;
        case EventType.LOCAL_INDEX_UPDATED:
          this.#scheduleRefresh();
          break;
        case EventType.DEVICE_RESUMED:
          if (this.devices.exists(event.data.device)) {
            this.devices.get(event.data.device).state = State.DISCONNECTED;
          }
          break;
        case EventType.DEVICE_PAUSED:
          if (this.devices.exists(event.data.device)) {
            this.devices.get(event.data.device).state = State.PAUSED;
          }
          break;
        case EventType.DEVICE_CONNECTED:
          if (this.devices.exists(event.data.id)) {
            this.devices.get(event.data.id).state = State.IDLE;
          }
          this.#scheduleRefresh();
          break;
        case EventType.DEVICE_DISCONNECTED:
          if (this.devices.exists(event.data.id)) {
            this.devices.get(event.data.id).state = State.DISCONNECTED;
          }
          this.#scheduleRefresh();
          break;
        case EventType.FAILURE:
          console.error(
            LOG_PREFIX,
            Error.SERVICE,
            event.data.error,
            event.data.when,
          );
          this.emit(Signal.ERROR, {
            type: Error.SERVICE,
            message: event.data.error,
          });
          break;
        case EventType.PENDING_DEVICES_CHANGED:
          if (event.data.added || event.data.removed) {
            this.#processPendingDevices(event.data);
          } else {
            this.devices.destroy();
            await this.#callConfig();
            await this.#checkPendingRequests();
          }
          break;
        case EventType.PENDING_FOLDERS_CHANGED:
          if (event.data.added || event.data.removed) {
            this.#processPendingFolders(event.data);
          } else {
            this.folders.destroy();
            await this.#callConfig();
            await this.#checkPendingRequests();
          }
          break;
      }
      if (event.id) {
        this.#lastEventID = event.id;
      }
    } catch (error) {
      console.debug(LOG_PREFIX, "event processing failed", error.message);
    }
  }

  #processPendingDevices(data) {
    if (!this.#pendingDevices) this.#pendingDevices = {};
    if (data.added) {
      for (const device of data.added) {
        this.#pendingDevices[device.deviceID] = {
          time: new Date(device.time),
          name: device.name,
          address: device.address,
        };
        console.debug(LOG_PREFIX, "pending device added", device.deviceID);
      }
    }
    if (data.removed) {
      for (const dev of data.removed) {
        delete this.#pendingDevices[dev.deviceID];
        console.debug(LOG_PREFIX, "pending device removed", dev.deviceID);
      }
    }
  }

  #processPendingFolders(data) {
    if (!this.#pendingFolders) this.#pendingFolders = {};
    if (data.added) {
      for (const folder of data.added) {
        if (!this.#pendingFolders[folder.folderID]) {
          this.#pendingFolders[folder.folderID] = { offeredBy: {} };
        }
        this.#pendingFolders[folder.folderID].offeredBy[folder.deviceID] = {
          time: new Date(folder.time),
          label: folder.folderLabel,
          receiveEncrypted: folder.receiveEncrypted,
        };
        console.debug(
          LOG_PREFIX,
          "pending folder added",
          folder.folderID,
          "from",
          folder.deviceID,
        );
      }
    }
    if (data.removed) {
      for (const folderDev of data.removed) {
        if (folderDev.deviceID === undefined) {
          delete this.#pendingFolders[folderDev.folderID];
        } else if (this.#pendingFolders[folderDev.folderID]) {
          delete this.#pendingFolders[folderDev.folderID].offeredBy[
            folderDev.deviceID
          ];
        }
      }
    }
  }

  async #checkConfigSync() {
    try {
      const data = await this.#serviceCall("GET", "/rest/config/insync");
      console.debug(LOG_PREFIX, "config in sync:", data.configInSync);
    } catch (error) {
      console.debug(LOG_PREFIX, "config sync check failed", error.message);
    }
  }

  #scheduleRefresh() {
    if (this.#refreshTimer) {
      this.#refreshTimer.cancel();
    }
    this.#refreshTimer = new Utils.Timer(REFRESH_INTERVAL, true);
    this.#refreshTimer.run(this.#performRefresh.bind(this));
  }

  async #performRefresh() {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      await Promise.all([
        this.#refreshSystem(),
        this.#refreshConnectionStats(),
        this.#refreshDiscoveryCache(),
        this.#refreshErrors(),
      ]);
    } catch (error) {
      console.debug(LOG_PREFIX, "refresh error", error.message);
    }
    this.#refreshing = false;
  }

  async #refreshSystem() {
    const data = await this.#serviceCall("GET", "/rest/system/status");
    this.#hostID = data.myID;
    const connectionServiceStatus = data.connectionServiceStatus || {};
    const discoveryStatus = data.discoveryStatus || {};
    console.debug(
      LOG_PREFIX,
      "system status",
      data.myID,
      Object.keys(connectionServiceStatus).length,
      "listeners",
    );
  }

  async #refreshConnectionStats() {
    const data = await this.#serviceCall("GET", "/rest/system/connections");
    const devices = data.connections;
    for (const deviceID in devices) {
      if (this.devices.exists(deviceID) && deviceID != this.#hostID) {
        if (devices[deviceID].connected) {
          this.devices.get(deviceID).state = State.IDLE;
        } else if (devices[deviceID].paused) {
          this.devices.get(deviceID).state = State.PAUSED;
        } else {
          this.devices.get(deviceID).state = State.DISCONNECTED;
        }
      }
    }
  }

  async #refreshDiscoveryCache() {
    const data = await this.#serviceCall("GET", "/rest/system/discovery");
    for (const device in data) {
      for (let i = 0; i < data[device].addresses.length; i++) {
        data[device].addresses[i] = data[device].addresses[i].replace(
          /\/\?.*/,
          "",
        );
      }
    }
    console.debug(LOG_PREFIX, "discovery cache refreshed");
  }

  async #refreshErrors() {
    const data = await this.#serviceCall("GET", "/rest/system/error");
    const errors = data.errors;
    if (errors) {
      for (let i = 0; i < errors.length; i++) {
        const errorTime = new Date(errors[i].when);
        if (errorTime > this.#lastErrorTime) {
          this.#lastErrorTime = errorTime;
          console.debug(LOG_PREFIX, Error.SERVICE, errors[i]);
          this.emit(Signal.ERROR, {
            type: Error.SERVICE,
            message: errors[i].message,
          });
        }
      }
    }
  }

  async #checkPendingRequests() {
    try {
      const devices = await this.#serviceCall(
        "GET",
        "/rest/cluster/pending/devices",
      );
      const folders = await this.#serviceCall(
        "GET",
        "/rest/cluster/pending/folders",
      );
      const deviceCount = Object.keys(devices || {}).length;
      const folderCount = Object.keys(folders || {}).length;
      const totalPending = deviceCount + folderCount;
      if (totalPending > 0 && totalPending > this.#lastPendingCount) {
        const messages = [];
        if (deviceCount > 0) {
          const deviceLabel = deviceCount === 1 ? "device" : "devices";
          messages.push(`${deviceCount} ${deviceLabel}`);
        }
        if (folderCount > 0) {
          const folderLabel = folderCount === 1 ? "folder" : "folders";
          messages.push(`${folderCount} ${folderLabel}`);
        }
        this.emit(Signal.PENDING_REQUEST, {
          devices: devices,
          folders: folders,
          message: messages.join(", "),
        });
      }
      this.#lastPendingCount = totalPending;
    } catch (error) {
      console.debug(
        LOG_PREFIX,
        "failed to check pending requests",
        error.message,
      );
    }
  }

  async #processConfig(config) {
    // Track existing items to remove old ones
    const existingFolderIDs = new Set(this.folders.ids);
    const existingDeviceIDs = new Set(this.devices.ids);
    const configFolderIDs = new Set();
    const configDeviceIDs = new Set();
    // Only include devices which shares folders with this host
    const usedDevices = {};
    for (let i = 0; i < config.folders.length; i++) {
      const folderID = config.folders[i].id;
      configFolderIDs.add(folderID);
      existingFolderIDs.delete(folderID);

      let name = config.folders[i].label;
      if (name.length == 0) name = folderID;
      if (!this.folders.exists(folderID)) {
        const folder = new Folder(
          {
            id: folderID,
            name: name,
            path: config.folders[i].path,
          },
          this,
        );
        this.folders.add(folder);
      } else {
        this.folders.get(folderID).name = name;
      }
      if (config.folders[i].paused) {
        this.folders.get(folderID).state = State.PAUSED;
      } else {
        Utils.Timer.run(i * 25, () => {
          const folder = this.folders.get(folderID);
          if (folder) {
            this.#openConnection(
              "GET",
              "/rest/db/status?folder=" + folderID,
              (data) => {
                folder.state = mapSyncthingState(data.state);
              },
            );
          }
        });
      }
      for (let j = 0; j < config.folders[i].devices.length; j++) {
        let deviceID = config.folders[i].devices[j].deviceID;
        if (!(deviceID in usedDevices)) {
          usedDevices[deviceID] = [];
        }
        usedDevices[deviceID].push(this.folders.get(folderID));
      }
    }

    // Remove old folders
    for (const folderID of existingFolderIDs) {
      this.folders.destroy(folderID);
    }

    for (let i = 0; i < config.devices.length; i++) {
      let deviceID = config.devices[i].deviceID;
      configDeviceIDs.add(deviceID);
      existingDeviceIDs.delete(deviceID);

      if (deviceID in usedDevices) {
        let device;
        if (!this.devices.exists(config.devices[i].deviceID)) {
          if (this.#hostID == config.devices[i].deviceID) {
            device = new HostDevice(
              {
                id: config.devices[i].deviceID,
                name: config.devices[i].name,
              },
              this,
            );
          } else {
            device = new Device(
              {
                id: config.devices[i].deviceID,
                name: config.devices[i].name,
              },
              this,
            );
          }
          this.devices.add(device);
          for (
            let j = 0;
            j < usedDevices[config.devices[i].deviceID].length;
            j++
          ) {
            let folder = usedDevices[config.devices[i].deviceID][j];
            if (device != this.host) {
              const proxy = new FolderCompletionProxy({
                folder: folder,
                device: device,
              });
              folder = proxy;
            }
            device.folders.add(folder);
          }
        } else {
          device = this.devices.get(config.devices[i].deviceID);
          device.name = config.devices[i].name;
        }
      }
    }

    // Remove old devices
    for (const deviceID of existingDeviceIDs) {
      this.devices.destroy(deviceID);
    }

    await this.#refreshConnectionStats();
  }

  // Resolve the Syncthing binary path so the generated unit works where the
  // binary is not at /usr/bin/syncthing (e.g. NixOS, which uses
  // /run/current-system/sw/bin or /nix/store/... locations).
  async #resolveSyncthingBinary() {
    // Ask `which` first: it honours the user's PATH, which is what #64 needs
    // on NixOS.
    try {
      let proc = Gio.Subprocess.new(
        ["which", "syncthing"],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
      );
      const [stdout] = await proc.communicate_utf8_async(null, null);
      const path = (stdout || "").trim();
      if (path.length > 0) return path;
    } catch (error) {
      console.debug(LOG_PREFIX, "which syncthing failed", error.message);
    }
    const candidates = [
      GLib.get_bin_dir() + "/syncthing",
      "/usr/bin/syncthing",
      "/run/current-system/sw/bin/syncthing",
    ];
    for (const candidate of candidates) {
      if (new Gio.File.new_for_path(candidate).query_exists(null)) {
        return candidate;
      }
    }
    return "/usr/bin/syncthing";
  }

  async #setService(force = false) {
    // Write the systemd unit with the resolved Syncthing binary path (the
    // shipped template hard-codes /usr/bin/syncthing, which breaks on NixOS).
    const syncthingBinary = await this.#resolveSyncthingBinary();
    let systemDConfigPath = GLib.get_user_config_dir() + "/systemd/user";
    let systemDConfigFile = Service.NAME + ".service";
    let systemDConfigFileTo = Gio.File.new_for_path(
      systemDConfigPath + "/" + systemDConfigFile,
    );
    if (force || !systemDConfigFileTo.query_exists(null)) {
      let systemDConfigFileFrom = Gio.File.new_for_path(
        this.#extensionPath + "/" + systemDConfigFile,
      );
      let systemdConfigDirectory = Gio.File.new_for_path(systemDConfigPath);
      if (!systemdConfigDirectory.query_exists(null)) {
        systemdConfigDirectory.make_directory_with_parents(null);
      }
      try {
        let [, template] = await new Promise((resolve, reject) => {
          systemDConfigFileFrom.load_contents_async(null, (file, result) => {
            try {
              resolve(file.load_contents_finish(result));
            } catch (error) {
              reject(error);
            }
          });
        });
        let content = new TextDecoder().decode(template);
        content = content.replace(
          /^ExecStart=.*$/m,
          "ExecStart=" +
            syncthingBinary +
            " serve --no-browser --no-restart --logflags=0",
        );
        let written = systemDConfigFileTo.replace_data(
          null,
          new TextEncoder().encode(content),
          Gio.FileCreateFlags.NONE,
          null,
          null,
        );
        if (written) {
          console.info(
            LOG_PREFIX,
            "systemd configuration file written to " +
              systemDConfigFileTo +
              " (ExecStart " +
              syncthingBinary +
              ")",
          );
        } else {
          console.debug(
            LOG_PREFIX,
            "couldn't write systemd configuration file to " +
              systemDConfigFileTo,
          );
        }
      } catch (error) {
        console.warn(
          LOG_PREFIX,
          "couldn't write systemd configuration file to " + systemDConfigFileTo,
          error.message,
        );
      }
    }
  }

  async #isServiceActive() {
    let active = false,
      error = false,
      command = "api";
    if (this.#extensionConfig.useSystemD) {
      const command = await this.#serviceCommand(
        "is-active",
        this.#serviceUserMode,
      );
      active = command == "active";
      error = command == "failed" || command == "error";
      if (error) {
        console.info(
          LOG_PREFIX,
          "systemd call failed, switching to API only mode",
        );
        this.#extensionConfig.useSystemD = !error;
      }
    }
    if (!this.#extensionConfig.useSystemD) {
      const result = await this.#serviceCall("GET", "/rest/system/ping");
      active = result["ping"] == "pong" ? "ping" in result : false;
      error = !active ? active : error;
    }
    if (error) {
      console.error(LOG_PREFIX, Error.DAEMON, Service.NAME);
      this.emit(Signal.ERROR, { type: Error.DAEMON });
    }
    console.info(
      LOG_PREFIX,
      "service active",
      command,
      this.#serviceUserMode,
      this.#serviceActive,
    );
    if (active != this.#serviceActive) {
      this.#serviceActive = active;
      if (this.#serviceUserMode) {
        this.emit(
          Signal.SERVICE_CHANGE,
          active ? ServiceState.USER_ACTIVE : ServiceState.USER_STOPPED,
        );
      } else {
        this.emit(
          Signal.SERVICE_CHANGE,
          active ? ServiceState.SYSTEM_ACTIVE : ServiceState.SYSTEM_STOPPED,
        );
      }
      if (this.host) this.host.state = active ? State.IDLE : State.DISCONNECTED;
    }
    return active;
  }

  async #isServiceEnabled(user = true) {
    if (!this.#extensionConfig.useSystemD)
      return (this.#serviceUserMode = this.#serviceEnabled = false);
    let command = await this.#serviceCommand("is-enabled", user),
      enabled = command == "enabled";
    if (!enabled && user) {
      return await this.#isServiceEnabled(false);
    }
    console.debug(
      LOG_PREFIX,
      "service enabled",
      command,
      user,
      this.#serviceUserMode,
      this.#serviceEnabled,
    );
    if (enabled != this.#serviceEnabled) {
      this.#serviceUserMode = user;
      this.#serviceEnabled = enabled;
      if (this.#serviceUserMode) {
        this.emit(
          Signal.SERVICE_CHANGE,
          enabled ? ServiceState.USER_ENABLED : ServiceState.USER_DISABLED,
        );
      } else {
        this.emit(
          Signal.SERVICE_CHANGE,
          enabled ? ServiceState.SYSTEM_ENABLED : ServiceState.SYSTEM_DISABLED,
        );
      }
    }
    return enabled;
  }

  async #serviceCommand(command, user = true) {
    let args = [SYSTEMD_COMMAND, command];
    if (user) {
      args.push(Service.NAME);
      args.push("--user");
    } else {
      args.push(Service.NAME + "@" + GLib.get_user_name());
    }
    let result;
    for (let i = 1; i <= SYSTEMD_RETRIES; i++) {
      console.debug(LOG_PREFIX, "calling systemd", user, args.toString());
      try {
        let proc = Gio.Subprocess.new(
          args,
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
        );
        const [stdout] = await proc.communicate_utf8_async(null, null);
        result = (stdout || "").trim();
        break;
      } catch (error) {
        result = "error";
        await Utils.sleep(SYSTEMD_RETRY_DELAY);
      }
    }
    return result;
  }

  async #serviceCall(method, path) {
    return new Promise((resolve, reject) => {
      this.#openConnection(method, path, resolve, reject);
    });
  }

  async #openConnection(method, path, callback, errorCallback) {
    if (this.#destroyed) {
      if (errorCallback)
        errorCallback(new globalThis.Error("manager destroyed"));
      return;
    }
    try {
      if (await this.#extensionConfig.exists()) {
        let msg = Soup.Message.new(method, this.#extensionConfig.URI + path);
        // Accept self signed certificates (for now)
        msg.connect("accept-certificate", () => {
          return true;
        });
        msg.request_headers.append("X-API-Key", this.#extensionConfig.APIKey);
        this.#openConnectionMessage(msg, callback, errorCallback);
      } else if (errorCallback) {
        errorCallback(new globalThis.Error(Error.CONFIG));
      }
    } catch (error) {
      if (errorCallback) errorCallback(error);
      else console.debug(LOG_PREFIX, "open connection error", error);
    }
  }

  async #openConnectionMessage(msg, callback, errorCallback) {
    try {
      // if ((await this.#extensionConfig.exists()) && this.#serviceActive) {
      if (await this.#extensionConfig.exists()) {
        console.debug(
          LOG_PREFIX,
          "opening connection",
          msg.method + ":" + msg.uri.get_path(),
        );
        this.#httpSession.send_and_read_async(
          msg,
          GLib.PRIORITY_DEFAULT,
          null,
          (session, result) => {
            let connected = false;
            let errorReported = false;
            if (msg.status_code == Soup.Status.OK) {
              connected = true;
              // Track consecutive failures only; a success clears the count
              this.#httpErrorCount = 0;
              let response;
              try {
                response = new TextDecoder("utf-8").decode(
                  session.send_and_read_finish(result).get_data(),
                );
              } catch (error) {
                if (error.code == Gio.IOErrorEnum.TIMED_OUT) {
                  console.info(
                    LOG_PREFIX,
                    error.message,
                    "will retry",
                    msg.method + ":" + msg.uri.get_path(),
                  );
                  // Retry this connection attempt
                  Utils.Timer.run(CONNECTION_RETRY_DELAY, () => {
                    this.#openConnectionMessage(msg, callback, errorCallback);
                  });
                  return;
                }
                if (errorCallback) {
                  errorCallback(error);
                  errorReported = true;
                }
              }
              try {
                if (response && response.length > 0) {
                  console.debug(
                    LOG_PREFIX,
                    "callback",
                    msg.method + ":" + msg.uri.get_path(),
                    response,
                  );
                  const parsed = JSON.parse(response);
                  if (callback) callback(parsed);
                } else if (errorCallback && !errorReported) {
                  errorCallback(new globalThis.Error("empty response"));
                  errorReported = true;
                }
              } catch (error) {
                console.debug(
                  LOG_PREFIX,
                  Error.STREAM,
                  msg.method + ":" + msg.uri.get_path(),
                  error.message,
                  response,
                );
                this.emit(Signal.ERROR, {
                  type: Error.STREAM,
                  message: msg.method + ":" + msg.uri.get_path(),
                });
                if (errorCallback && !errorReported) {
                  errorCallback(error);
                  errorReported = true;
                }
              }
            } else if (!this.#httpAborting) {
              this.#httpErrorCount++;
              if (this.#httpErrorCount >= HTTP_ERROR_RETRIES) {
                this.#httpErrorCount = 0;
                connected = false;
                this.emit(Signal.SERVICE_CHANGE, ServiceState.ERROR);
                // Re-check service state so a stopped service retires the loop instead of error spam
                this.#isServiceActive();
              }
              console.error(
                LOG_PREFIX,
                Error.CONNECTION,
                msg.reason_phrase,
                msg.method + ":" + msg.get_uri().get_path(),
                msg.status_code,
                this.#httpErrorCount,
              );
              this.emit(Signal.ERROR, {
                type: Error.CONNECTION,
                message:
                  msg.reason_phrase +
                  " - " +
                  msg.method +
                  ":" +
                  msg.get_uri().get_path(),
              });
              if (errorCallback) {
                errorCallback(
                  new globalThis.Error(
                    Error.CONNECTION +
                      " " +
                      msg.status_code +
                      " " +
                      msg.method +
                      ":" +
                      msg.get_uri().get_path(),
                  ),
                );
                errorReported = true;
              }
            } else if (this.#httpAborting && errorCallback) {
              errorCallback(new globalThis.Error("aborted"));
              errorReported = true;
            }
            if (!this.#httpAborting && connected != this.#serviceConnected) {
              this.#serviceConnected = connected;
              this.emit(
                Signal.SERVICE_CHANGE,
                connected ? ServiceState.CONNECTED : ServiceState.DISCONNECTED,
              );
            }
          },
        );
      } else if (errorCallback) {
        errorCallback(new globalThis.Error(Error.CONFIG));
      }
    } catch (error) {
      if (errorCallback) errorCallback(error);
      else console.debug(LOG_PREFIX, "open connection message error", error);
    }
  }

  async #attach() {
    if (!(await this.#extensionConfig.exists())) {
      console.error(LOG_PREFIX, Error.CONFIG);
      this.emit(Signal.SERVICE_CHANGE, ServiceState.ERROR);
      this.emit(Signal.ERROR, { type: Error.CONFIG });
    } else {
      console.info(
        LOG_PREFIX,
        "attach manager",
        await this.#isServiceEnabled(),
        await this.#isServiceActive(),
      );
    }
  }

  // Service stopped: drop state and stop loops, but stay usable for a later
  // restart (does not abort in-flight requests or mark the manager destroyed)
  #reset() {
    if (this.#refreshTimer) this.#refreshTimer.cancel();
    this.#eventsGeneration++;
    this.#extensionConfig.destroy();
    this.folders.destroy();
    this.devices.destroy();
  }

  // Release all resources. Abort in-flight requests and retire the event
  // chain, otherwise the /rest/events long-poll outlives disable()
  destroy() {
    this.#destroyed = true;
    this.#reset();
    if (this.#refreshTimer) this.#refreshTimer.destroy();
    this.#httpAborting = true;
    this.#httpSession.abort();
  }

  // Attach to Syncthing service
  attach() {
    this.#attach().catch((error) => {
      console.debug(LOG_PREFIX, "attach manager error", error);
    });
  }

  // Enable Syncthing service
  async enableService() {
    await this.#setService(true);
    await this.#serviceCommand("enable");
    this.#isServiceEnabled();
  }

  // Disable Syncthing service
  async disableService() {
    await this.#serviceCommand("disable");
    this.#isServiceEnabled();
  }

  // Start Syncthing service
  async startService() {
    await this.#setService();
    await this.#serviceCommand("start");
    await Utils.sleep(CONNECTION_RETRY_DELAY);
    this.#isServiceActive();
  }

  // Stop Syncthing service
  async stopService() {
    this.#httpAborting = true;
    // Retire the event chain so the aborted request does not retry against a stopped service
    this.#eventsGeneration++;
    this.#httpSession.abort();
    await this.#serviceCommand("stop");
    this.#isServiceActive();
    this.#httpAborting = false;
  }

  get serviceURI() {
    return this.#extensionConfig.URI;
  }

  rescan(folder) {
    if (folder) {
      this.#openConnection("POST", "/rest/db/scan?folder=" + folder.id);
    } else {
      this.#openConnection("POST", "/rest/db/scan");
    }
  }

  resume(device) {
    if (device) {
      this.#openConnection("POST", "/rest/system/resume?device=" + device.id);
    }
  }

  pause(device) {
    if (device) {
      this.#openConnection("POST", "/rest/system/pause?device=" + device.id);
    }
  }
}
