/* =============================================================================================================
	SyncthingManager 0.50
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
const POLL_TIME = 20000;
const POLL_DELAY_TIME = 2000;
const POLL_CONNECTION_HOOK_COUNT = 6; // Poll time * count =  every 2 minutes
const POLL_CONFIG_HOOK_COUNT = 45; // Poll time * count =  every 15 minutes
const CONNECTION_RETRY_DELAY = 1000;
const DEVICE_STATE_DELAY = 600;
const ITEM_STATE_DELAY = 200;
const RESCHEDULE_EVENT_DELAY = 50;
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

  constructor(data, manager) {
    super(data, manager);
    this.folders = new ItemCollection();
    this.folders.connect(Signal.ADD, (collection, folder) => {
      folder.connect(
        Signal.STATE_CHANGE,
        this.determineStateDelayed.bind(this),
      );
    });
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
    this.#determineTimer.destroy();
    super.destroy();
  }
}

// Local host device
class HostDevice extends Device {
  constructor(data, manager) {
    super(data, manager);
    this._manager.connect(Signal.DEVICE_ADD, (manager, device) => {
      device.connect(
        Signal.STATE_CHANGE,
        this.determineStateDelayed.bind(this),
      );
    });
    this._manager.devices.foreach((device) => {
      device.connect(
        Signal.STATE_CHANGE,
        this.determineStateDelayed.bind(this),
      );
    });
    this.determineState();
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
  #httpErrorCount = 0;
  #serviceRetries = 0;
  #serviceActive = false;
  #serviceEnabled = false;
  #serviceUserMode = true;
  #serviceConnected = false;
  #pollTimer = new Utils.Timer(POLL_TIME, true);
  #pollCount = 1; // Start at 1 to stop from cycling the hooks at init
  #lastEventID = 1;
  #hostID = "";
  #lastErrorTime = Date.now();
  #lastPendingCount = 0;
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
            this.#pollTimer.run(this.#pollState.bind(this));
            await this.#checkPendingRequests();
            break;
          case ServiceState.USER_STOPPED:
          case ServiceState.SYSTEM_STOPPED:
            this.destroy();
            this.#lastEventID = 1;
            this.#httpErrorCount = 0;
            if (this.#serviceConnected) {
              this.#serviceConnected = false;
              this.emit(Signal.SERVICE_CHANGE, ServiceState.DISCONNECTED);
            }
            break;
        }
      } catch (error) {
        console.error(LOG_PREFIX, "service change error", error);
      }
    });
  }

  async #callConfig() {
    const config = await this.#serviceCall("GET", "/rest/system/config");
    await this.#processConfig(config);
    return config;
  }

  #callEvents(options) {
    this.#openConnection("GET", "/rest/events?" + options, (events) => {
      for (let i = 0; i < events.length; i++) {
        this.#processEvent({
          type: events[i].type,
          data: events[i].data,
          id: events[i].id,
        });
      }
      // Reschedule this event stream
      Utils.Timer.run(RESCHEDULE_EVENT_DELAY, () => {
        this.#callEvents("since=" + this.#lastEventID);
      });
    });
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
              if (device.isOnline()) device.state = State.SCANNING;
              device.folders
                .get(event.data.folder)
                .setCompletion(event.data.completion);
            }
          }
          break;
        case EventType.FOLDER_SUMMARY:
          if (this.folders.exists(event.data.folder)) {
            this.folders.get(event.data.folder).state =
              event.data.summary.state;
          }
          break;
        case EventType.FOLDER_PAUSED:
          if (this.folders.exists(event.data.id)) {
            this.folders.get(event.data.id).state = State.PAUSED;
          }
          break;
        case EventType.STATE_CHANGED:
          if (this.folders.exists(event.data.folder)) {
            this.folders.get(event.data.folder).state = event.data.to;
          }
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
          break;
        case EventType.DEVICE_DISCONNECTED:
          if (this.devices.exists(event.data.id)) {
            this.devices.get(event.data.id).state = State.DISCONNECTED;
          }
          break;
        case EventType.PENDING_DEVICES_CHANGED:
          this.devices.destroy();
          await this.#callConfig();
          await this.#checkPendingRequests();
          break;
        case EventType.PENDING_FOLDERS_CHANGED:
          this.folders.destroy();
          await this.#callConfig();
          await this.#checkPendingRequests();
          break;
      }
      if (event.id) {
        this.#lastEventID = event.id;
      }
    } catch (error) {
      console.warn(LOG_PREFIX, "event processing failed", error.message);
    }
  }

  async #callConnections() {
    const data = await this.#serviceCall("GET", "/rest/system/connections");
    const devices = data.connections;
    for (let deviceID in devices) {
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
      console.warn(
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
        this.folders.get(folderID).setName(name);
      }
      if (config.folders[i].paused) {
        this.folders.get(folderID).state = State.PAUSED;
      } else {
        const folder = this.folders.get(folderID);
        this.#openConnection(
          "GET",
          "/rest/db/status?folder=" + folderID,
          (data) => {
            folder.state = data.state;
          },
        );
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
              if (folder.state != State.PAUSED) {
                this.#openConnection(
                  "GET",
                  "/rest/db/completion?folder=" +
                    proxy.id +
                    "&device=" +
                    device.id,
                  (data) => {
                    proxy.setCompletion(data.completion);
                  },
                );
              }
              folder = proxy;
            }
            device.folders.add(folder);
          }
        } else {
          device = this.devices.get(config.devices[i].deviceID);
          device.setName(config.devices[i].name);
        }
      }
    }

    // Remove old devices
    for (const deviceID of existingDeviceIDs) {
      this.devices.destroy(deviceID);
    }

    await this.#callConnections();
  }

  async #pollState() {
    console.debug(
      LOG_PREFIX,
      "poll state",
      this.#pollCount,
      this.#pollCount % POLL_CONFIG_HOOK_COUNT,
      this.#pollCount % POLL_CONNECTION_HOOK_COUNT,
    );
    if (
      (await this.#extensionConfig.exists()) &&
      (await this.#isServiceActive())
    ) {
      if (this.#pollCount % POLL_CONFIG_HOOK_COUNT == 0) {
        await this.#callConfig();
        await this.#checkPendingRequests();
      }
      if (this.#pollCount % POLL_CONNECTION_HOOK_COUNT == 0) {
        await this.#isServiceEnabled();
        await this.#callConnections();
      }
      this.#openConnection("GET", "/rest/system/error", (data) => {
        let errorTime;
        const errors = data.errors;
        if (errors != null) {
          for (let i = 0; i < errors.length; i++) {
            errorTime = new Date(errors[i].when);
            if (errorTime > this.#lastErrorTime) {
              this.#lastErrorTime = errorTime;
              console.error(LOG_PREFIX, Error.SERVICE, errors[i]);
              this.emit(Signal.ERROR, {
                type: Error.SERVICE,
                message: errors[i].message,
              });
            }
          }
        }
      });
    } else {
      await this.#isServiceEnabled();
    }
    this.#pollCount++;
  }

  #setService(force = false) {
    // (Force) Copy systemd config file to systemd's configuration directory (if it doesn't exist)
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
      let copyFlag = Gio.FileCopyFlags.NONE;
      if (force) copyFlag = Gio.FileCopyFlags.OVERWRITE;
      if (
        systemDConfigFileFrom.copy(systemDConfigFileTo, copyFlag, null, null)
      ) {
        console.info(
          LOG_PREFIX,
          "systemd configuration file copied to " + systemDConfigFileTo,
        );
      } else {
        console.warn(
          LOG_PREFIX,
          "couldn't copy systemd configuration file to " + systemDConfigFileTo,
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
        console.warn(
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
        let proc = Gio.Subprocess.new(args, Gio.SubprocessFlags.STDOUT_PIPE);
        result = (await proc.communicate_utf8_async(null, null))
          .toString()
          .replace(/[^a-z].?/, "");
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
      try {
        this.#openConnection(method, path, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  async #openConnection(method, path, callback) {
    if (await this.#extensionConfig.exists()) {
      let msg = Soup.Message.new(method, this.#extensionConfig.URI + path);
      // Accept self signed certificates (for now)
      msg.connect("accept-certificate", () => {
        return true;
      });
      msg.request_headers.append("X-API-Key", this.#extensionConfig.APIKey);
      this.#openConnectionMessage(msg, callback);
    }
  }

  async #openConnectionMessage(msg, callback) {
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
          if (msg.status_code == Soup.Status.OK) {
            connected = true;
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
                  this.#openConnectionMessage(msg, callback);
                });
              }
            }
            try {
              if (callback && response && response.length > 0) {
                console.debug(
                  LOG_PREFIX,
                  "callback",
                  msg.method + ":" + msg.uri.get_path(),
                  response,
                );
                callback(JSON.parse(response));
              }
            } catch (error) {
              console.error(
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
            }
          } else if (!this.#httpAborting) {
            this.#httpErrorCount++;
            if (this.#httpErrorCount >= HTTP_ERROR_RETRIES) {
              this.#pollTimer.cancel();
              this.#httpErrorCount = 0;
              connected = false;
              this.emit(Signal.SERVICE_CHANGE, ServiceState.ERROR);
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

  // Release all resources
  destroy() {
    this.#pollTimer.destroy();
    this.#extensionConfig.destroy();
    this.folders.destroy();
    this.devices.destroy();
  }

  // Attach to Syncthing service
  attach() {
    this.#attach().catch((error) => {
      console.error(LOG_PREFIX, "attach manager error", error);
    });
  }

  // Enable Syncthing service
  async enableService() {
    this.#setService(true);
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
    this.#setService();
    await this.#serviceCommand("start");
    await Utils.sleep(POLL_DELAY_TIME);
    this.#isServiceActive();
  }

  // Stop Syncthing service
  async stopService() {
    this.#httpAborting = true;
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
