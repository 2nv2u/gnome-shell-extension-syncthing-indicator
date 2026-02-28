/* =============================================================================================================
	SyncthingManager 0.48
================================================================================================================

	GJS syncthing (systemd) manager.

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
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

// Abstract item used for folders and devices
class Item extends Utils.Emitter {
  constructor(data, manager) {
    super();
    this._state = State.UNKNOWN;
    this._stateEmitted = State.UNKNOWN;
    this._stateTimer = new Utils.Timer(ITEM_STATE_DELAY);
    this._destroyed = false;
    this.id = data.id;
    this._name = data.name;
    this._manager = manager;
  }

  isBusy() {
    return (
      this.getState() == State.SYNCING || this.getState() == State.SCANNING
    );
  }

  setState(state) {
    if (state.length > 0 && this._state !== state) {
      this._stateTimer.cancel();
      console.info(LOG_PREFIX, "state change", this._name, state);
      this._state = state;
      this._stateTimer.run(() => {
        if (this._destroyed) return;
        if (this._stateEmitted !== this._state) {
          console.debug(
            LOG_PREFIX,
            "emit state change",
            this._name,
            this._state,
          );
          this._stateEmitted = this._state;
          this.emit(Signal.STATE_CHANGE, this._state);
        }
      });
    }
  }

  getState() {
    return this._state;
  }

  setName(name) {
    if (name.length > 0 && this._name != name) {
      console.info(LOG_PREFIX, "emit name change", this._name, name);
      this._name = name;
      this.emit(Signal.NAME_CHANGE, this._name);
    }
  }

  getName() {
    return this._name;
  }

  destroy() {
    this._destroyed = true;
    this._stateTimer.destroy();
    this.emit(Signal.DESTROY);
  }
}

// Abstract item collection used for folders and devices
class ItemCollection extends Utils.Emitter {
  constructor() {
    super();
    this._collection = {};
  }

  add(item) {
    if (item instanceof Item) {
      console.info(LOG_PREFIX, "add", item.constructor.name, item.getName());
      this._collection[item.id] = item;
      item.connect(Signal.DESTROY, (_item) => {
        delete this._collection[_item.id];
      });
      this.emit(Signal.ADD, item);
    }
  }

  destroy(id) {
    if (id) {
      let item = this._collection[id];
      delete this._collection[id];
      item.destroy();
      this.emit(Signal.DESTROY, item);
    } else {
      this.foreach((_item) => {
        this.destroy(_item.id);
      });
    }
  }

  get(id) {
    return this._collection[id];
  }

  exists(id) {
    return id in this._collection;
  }

  foreach(handler) {
    for (let itemID in this._collection) {
      handler(this._collection[itemID]);
    }
  }
}

// Device
class Device extends Item {
  constructor(data, manager) {
    super(data, manager);
    this._determineTimer = new Utils.Timer(DEVICE_STATE_DELAY);
    this.folders = new ItemCollection();
    this.folders.connect(Signal.ADD, (collection, folder) => {
      folder.connect(
        Signal.STATE_CHANGE,
        this.determineStateDelayed.bind(this),
      );
    });
  }

  isOnline() {
    return (
      this.getState() != State.DISCONNECTED && this.getState() != State.PAUSED
    );
  }

  determineStateDelayed() {
    // Stop items from excessive state change calculations by only emitting 1 state per stateDelay
    this._determineTimer.run(this.determineState.bind(this));
  }

  determineState() {
    if (this.isOnline()) {
      this.setState(State.PAUSED);
      this.folders.foreach((folder) => {
        if (!this.isBusy()) {
          console.info(
            LOG_PREFIX,
            "determine device state",
            this.getName(),
            folder.getName(),
            folder.getState(),
          );
          this.setState(folder.getState());
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
    this._determineTimer.destroy();
    super.destroy();
  }
}

// Device host
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
    this.setState(State.PAUSED);
    this._manager.devices.foreach((device) => {
      if (this != device && !this.isBusy() && device.isOnline()) {
        console.info(
          LOG_PREFIX,
          "determine host device state",
          this.getName(),
          device.getName(),
          device.getState(),
        );
        this.setState(device.getState());
      }
    });
    if (!this.isBusy()) {
      super.determineState();
    }
  }
}

// Folder
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

// Folder completion proxy per device
class FolderCompletionProxy extends Folder {
  constructor(data) {
    super(data.folder);
    this._name = data.folder.getName() + " (" + data.device.getName() + ")";
    this._folder = data.folder;
    this._device = data.device;
  }

  setCompletion(percentage) {
    if (percentage < 100) {
      this.setState(State.SYNCING);
    } else {
      this.setState(State.IDLE);
    }
  }
}

// Main system manager
export class Manager extends Utils.Emitter {
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
    this._httpSession = new Soup.Session();
    this._httpAborting = false;
    this._httpErrorCount = 0;
    this._extensionConfig = extensionConfig;
    this._serviceRetries = 0;
    this._serviceActive = false;
    this._serviceEnabled = false;
    this._serviceUserMode = true;
    this._pollTimer = new Utils.Timer(POLL_TIME, true);
    this._pollCount = 1; // Start at 1 to stop from cycling the hooks at init
    this._lastEventID = 1;
    this._hostID = "";
    this._lastErrorTime = Date.now();
    this._lastPendingCount = 0;
    this.connect(Signal.SERVICE_CHANGE, (manager, state) => {
      switch (state) {
        case ServiceState.USER_ACTIVE:
        case ServiceState.SYSTEM_ACTIVE:
          this._openConnection("GET", "/rest/system/status", (status) => {
            this._hostID = status.myID;
            this._callConfig((config) => {
              this._callEvents("limit=1");
              this._pollTimer.run(this._pollState.bind(this));
              this._checkPendingRequests();
            });
          });
          break;
        case ServiceState.USER_STOPPED:
        case ServiceState.SYSTEM_STOPPED:
          this.destroy();
          this._lastEventID = 1;
          this._httpErrorCount = 0;
          if (this._serviceConnected) {
            this._serviceConnected = false;
            this.emit(Signal.SERVICE_CHANGE, ServiceState.DISCONNECTED);
          }
          break;
      }
    });
  }

  _callConfig(handler) {
    this._openConnection("GET", "/rest/system/config", (config) => {
      this._processConfig(config);
      if (handler) handler(config);
    });
  }

  _callEvents(options) {
    this._openConnection("GET", "/rest/events?" + options, (events) => {
      for (let i = 0; i < events.length; i++) {
        console.debug(
          LOG_PREFIX,
          "processing event",
          events[i].type,
          events[i].data,
        );
        try {
          switch (events[i].type) {
            case EventType.STARTUP_COMPLETE:
              this._callConfig();
              break;
            case EventType.CONFIG_SAVED:
              this._processConfig(events[i].data);
              break;
            case EventType.LOGIN_ATTEMPT:
              if (events[i].data.success) {
                this.emit(Signal.LOGIN, events[i].data.username);
              } else {
                this.emit(Error.LOGIN, events[i].data.username);
              }
              break;
            case EventType.FOLDER_ERRORS:
              if (this.folders.exists(events[i].data.folder)) {
                this.folders
                  .get(events[i].data.folder)
                  .setState(State.ERRONEOUS);
              }
              break;
            case EventType.FOLDER_COMPLETION:
              if (
                this.folders.exists(events[i].data.folder) &&
                this.devices.exists(events[i].data.device)
              ) {
                let device = this.devices.get(events[i].data.device);
                if (device.folders.exists(events[i].data.folder)) {
                  if (device.isOnline()) device.setState(State.SCANNING);
                  device.folders
                    .get(events[i].data.folder)
                    .setCompletion(events[i].data.completion);
                }
              }
              break;
            case EventType.FOLDER_SUMMARY:
              if (this.folders.exists(events[i].data.folder)) {
                this.folders
                  .get(events[i].data.folder)
                  .setState(events[i].data.summary.state);
              }
              break;
            case EventType.FOLDER_PAUSED:
              if (this.folders.exists(events[i].data.id)) {
                this.folders.get(events[i].data.id).setState(State.PAUSED);
              }
              break;
            case EventType.PENDING_FOLDERS_CHANGED:
              this.folders.destroy();
              this._callConfig();
              break;
            case EventType.STATE_CHANGED:
              if (this.folders.exists(events[i].data.folder)) {
                this.folders
                  .get(events[i].data.folder)
                  .setState(events[i].data.to);
              }
              break;
            case EventType.DEVICE_RESUMED:
              if (this.devices.exists(events[i].data.device)) {
                this.devices
                  .get(events[i].data.device)
                  .setState(State.DISCONNECTED);
              }
              break;
            case EventType.DEVICE_PAUSED:
              if (this.devices.exists(events[i].data.device)) {
                this.devices.get(events[i].data.device).setState(State.PAUSED);
              }
              break;
            case EventType.DEVICE_CONNECTED:
              if (this.devices.exists(events[i].data.id)) {
                this.devices.get(events[i].data.id).setState(State.IDLE);
              }
              break;
            case EventType.DEVICE_DISCONNECTED:
              if (this.devices.exists(events[i].data.id)) {
                this.devices
                  .get(events[i].data.id)
                  .setState(State.DISCONNECTED);
              }
              break;
            case EventType.PENDING_DEVICES_CHANGED:
              this.devices.destroy();
              this._callConfig();
              this._checkPendingRequests();
              break;
            case EventType.PENDING_FOLDERS_CHANGED:
              this.folders.destroy();
              this._callConfig();
              this._checkPendingRequests();
              break;
          }
          this._lastEventID = events[i].id;
        } catch (error) {
          console.warn(LOG_PREFIX, "event processing failed", error.message);
        }
      }
      // Reschedule this event stream
      Utils.Timer.run(RESCHEDULE_EVENT_DELAY, () => {
        this._callEvents("since=" + this._lastEventID);
      });
    });
  }

  _callConnections() {
    this._openConnection("GET", "/rest/system/connections", (data) => {
      let devices = data.connections;
      for (let deviceID in devices) {
        if (this.devices.exists(deviceID) && deviceID != this._hostID) {
          if (devices[deviceID].connected) {
            this.devices.get(deviceID).setState(State.IDLE);
          } else if (devices[deviceID].paused) {
            this.devices.get(deviceID).setState(State.PAUSED);
          } else {
            this.devices.get(deviceID).setState(State.DISCONNECTED);
          }
        }
      }
    });
  }

  _checkPendingRequests() {
    let fetchPending = (path) => {
      return new Promise((resolve) => {
        this._openConnection("GET", path, resolve);
      });
    };
    Promise.all([
      fetchPending("/rest/cluster/pending/devices"),
      fetchPending("/rest/cluster/pending/folders"),
    ])
      .then(([devices, folders]) => {
        let deviceCount = Object.keys(devices || {}).length;
        let folderCount = Object.keys(folders || {}).length;
        let totalPending = deviceCount + folderCount;
        if (totalPending > 0 && totalPending > this._lastPendingCount) {
          let messages = [];
          if (deviceCount > 0) {
            let deviceLabel = deviceCount === 1 ? "device" : "devices";
            messages.push(`${deviceCount} ${deviceLabel}`);
          }
          if (folderCount > 0) {
            let folderLabel = folderCount === 1 ? "folder" : "folders";
            messages.push(`${folderCount} ${folderLabel}`);
          }
          this.emit(Signal.PENDING_REQUEST, {
            devices: devices,
            folders: folders,
            message: messages.join(", "),
          });
        }
        this._lastPendingCount = totalPending;
      })
      .catch((error) => {
        console.warn(LOG_PREFIX, "failed to check pending requests", error.message);
      });
  }

  _processConfig(config) {
    // Only include devices which shares folders with this host
    let usedDevices = {};
    for (let i = 0; i < config.folders.length; i++) {
      let name = config.folders[i].label;
      if (name.length == 0) name = config.folders[i].id;
      if (!this.folders.exists(config.folders[i].id)) {
        let folder = new Folder(
          {
            id: config.folders[i].id,
            name: name,
            path: config.folders[i].path,
          },
          this,
        );
        this.folders.add(folder);
      } else {
        this.folders.get(config.folders[i].id).setName(name);
      }
      if (config.folders[i].paused) {
        this.folders.get(config.folders[i].id).setState(State.PAUSED);
      } else {
        this._openConnection(
          "GET",
          "/rest/db/status?folder=" + config.folders[i].id,
          (function (folder) {
            return (data) => {
              folder.setState(data.state);
            };
          })(this.folders.get(config.folders[i].id)),
        );
      }
      for (let j = 0; j < config.folders[i].devices.length; j++) {
        if (!(config.folders[i].devices[j].deviceID in usedDevices)) {
          usedDevices[config.folders[i].devices[j].deviceID] = [];
        }
        usedDevices[config.folders[i].devices[j].deviceID].push(
          this.folders.get(config.folders[i].id),
        );
      }
    }
    // TODO: remove / update old devices & folders, current destroy is way to invasive
    for (let i = 0; i < config.devices.length; i++) {
      if (config.devices[i].deviceID in usedDevices) {
        let device;
        if (!this.devices.exists(config.devices[i].deviceID)) {
          if (this._hostID == config.devices[i].deviceID) {
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
              let proxy = new FolderCompletionProxy({
                folder: folder,
                device: device,
              });
              if (folder.getState() != State.PAUSED) {
                this._openConnection(
                  "GET",
                  "/rest/db/completion?folder=" +
                    proxy.id +
                    "&device=" +
                    device.id,
                  (function (proxy) {
                    return (data) => {
                      proxy.setCompletion(data.completion);
                    };
                  })(proxy),
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
    this._callConnections();
  }

  async _pollState() {
    console.debug(
      LOG_PREFIX,
      "poll state",
      this._pollCount,
      this._pollCount % POLL_CONFIG_HOOK_COUNT,
      this._pollCount % POLL_CONNECTION_HOOK_COUNT,
    );
    if (
      (await this._extensionConfig.exists()) &&
      (await this._isServiceActive())
    ) {
      if (this._pollCount % POLL_CONFIG_HOOK_COUNT == 0) {
        // TODO: this should not be necessary, we should remove old items
        this.folders.destroy();
        this.devices.destroy();
        this._callConfig();
        this._checkPendingRequests();
      }
      if (this._pollCount % POLL_CONNECTION_HOOK_COUNT == 0) {
        await this._isServiceEnabled();
        this._callConnections();
      }
      this._openConnection("GET", "/rest/system/error", (data) => {
        let errorTime;
        let errors = data.errors;
        if (errors != null) {
          for (let i = 0; i < errors.length; i++) {
            errorTime = new Date(errors[i].when);
            if (errorTime > this._lastErrorTime) {
              this._lastErrorTime = errorTime;
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
      await this._isServiceEnabled();
    }
    this._pollCount++;
  }

  _setService(force = false) {
    // (Force) Copy systemd config file to systemd's configuration directory (if it doesn't exist)
    let systemDConfigPath = GLib.get_user_config_dir() + "/systemd/user";
    let systemDConfigFile = Service.NAME + ".service";
    let systemDConfigFileTo = Gio.File.new_for_path(
      systemDConfigPath + "/" + systemDConfigFile,
    );
    if (force || !systemDConfigFileTo.query_exists(null)) {
      let systemDConfigFileFrom = Gio.File.new_for_path(
        this._extensionPath + "/" + systemDConfigFile,
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

  async _isServiceActive() {
    let active = false,
      error = false,
      command = "api";
    if (this._extensionConfig.useSystemD) {
      let command = await this._serviceCommand(
        "is-active",
        this._serviceUserMode,
      );
      active = command == "active";
      error = command == "failed" || command == "error";
      if (error) {
        console.warn(
          LOG_PREFIX,
          "systemd call failed, switching to API only mode",
        );
        this._extensionConfig.useSystemD = !error;
      }
    }
    if (!this._extensionConfig.useSystemD) {
      let result = await this._serviceCall("GET", "/rest/system/ping");
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
      this._serviceUserMode,
      this._serviceActive,
    );
    if (active != this._serviceActive) {
      this._serviceActive = active;
      if (this._serviceUserMode) {
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
      if (this.host)
        this.host.setState(active ? State.IDLE : State.DISCONNECTED);
    }
    return active;
  }

  async _isServiceEnabled(user = true) {
    if (!this._extensionConfig.useSystemD)
      return (this._serviceUserMode = this._serviceEnabled = false);
    let command = await this._serviceCommand("is-enabled", user),
      enabled = command == "enabled";
    if (!enabled && user) {
      return await this._isServiceEnabled(false);
    }
    console.debug(
      LOG_PREFIX,
      "service enabled",
      command,
      user,
      this._serviceUserMode,
      this._serviceEnabled,
    );
    if (enabled != this._serviceEnabled) {
      this._serviceUserMode = user;
      this._serviceEnabled = enabled;
      if (this._serviceUserMode) {
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

  async _serviceCommand(command, user = true) {
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

  async _serviceCall(method, path) {
    return new Promise((resolve, reject) => {
      try {
        this._openConnection(method, path, resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  async _openConnection(method, path, callback) {
    if (await this._extensionConfig.exists()) {
      let msg = Soup.Message.new(method, this._extensionConfig.URI + path);
      // Accept self signed certificates (for now)
      msg.connect("accept-certificate", () => {
        return true;
      });
      msg.request_headers.append("X-API-Key", this._extensionConfig.APIKey);
      this._openConnectionMessage(msg, callback);
    }
  }

  async _openConnectionMessage(msg, callback) {
    // if ((await this._extensionConfig.exists()) && this._serviceActive) {
    if (await this._extensionConfig.exists()) {
      console.debug(
        LOG_PREFIX,
        "opening connection",
        msg.method + ":" + msg.uri.get_path(),
      );
      this._httpSession.send_and_read_async(
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
                  this._openConnectionMessage(msg, callback);
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
          } else if (!this._httpAborting) {
            this._httpErrorCount++;
            if (this._httpErrorCount >= HTTP_ERROR_RETRIES) {
              this._pollTimer.cancel();
              this._httpErrorCount = 0;
              connected = false;
              this.emit(Signal.SERVICE_CHANGE, ServiceState.ERROR);
            }
            console.error(
              LOG_PREFIX,
              Error.CONNECTION,
              msg.reason_phrase,
              msg.method + ":" + msg.get_uri().get_path(),
              msg.status_code,
              this._httpErrorCount,
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
          if (!this._httpAborting && connected != this._serviceConnected) {
            this._serviceConnected = connected;
            this.emit(
              Signal.SERVICE_CHANGE,
              connected ? ServiceState.CONNECTED : ServiceState.DISCONNECTED,
            );
          }
        },
      );
    }
  }

  async _attach() {
    if (!(await this._extensionConfig.exists())) {
      console.error(LOG_PREFIX, Error.CONFIG);
      this.emit(Signal.SERVICE_CHANGE, ServiceState.ERROR);
      this.emit(Signal.ERROR, { type: Error.CONFIG });
    } else {
      console.info(
        LOG_PREFIX,
        "attach manager",
        await this._isServiceEnabled(),
        await this._isServiceActive(),
      );
    }
  }

  destroy() {
    this._pollTimer.destroy();
    this._extensionConfig.destroy();
    this.folders.destroy();
    this.devices.destroy();
  }

  attach() {
    this._attach().catch((error) => {
      console.error(LOG_PREFIX, "attach manager error", error);
    });
  }

  async enableService() {
    this._setService(true);
    await this._serviceCommand("enable");
    this._isServiceEnabled();
  }

  async disableService() {
    await this._serviceCommand("disable");
    this._isServiceEnabled();
  }

  async startService() {
    this._setService();
    await this._serviceCommand("start");
    await Utils.sleep(POLL_DELAY_TIME);
    this._isServiceActive();
  }

  async stopService() {
    this._httpAborting = true;
    this._httpSession.abort();
    await this._serviceCommand("stop");
    this._isServiceActive();
    this._httpAborting = false;
  }

  getServiceURI() {
    return this._extensionConfig.URI;
  }

  rescan(folder) {
    if (folder) {
      this._openConnection("POST", "/rest/db/scan?folder=" + folder.id);
    } else {
      this._openConnection("POST", "/rest/db/scan");
    }
  }

  resume(device) {
    if (device) {
      this._openConnection("POST", "/rest/system/resume?device=" + device.id);
    }
  }

  pause(device) {
    if (device) {
      this._openConnection("POST", "/rest/system/pause?device=" + device.id);
    }
  }
}
