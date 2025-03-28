/* =============================================================================================================
	SyncthingManager 0.41
================================================================================================================

	GJS syncthing systemd manager

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup";

import * as Signals from "resource:///org/gnome/shell/misc/signals.js";

const LOG_PREFIX = "syncthing-indicator-manager:";
const POLL_TIME = 5000;
const CONNECTION_RETRY_DELAY = 1000;
const DEVICE_STATE_DELAY = 600;
const ITEM_STATE_DELAY = 200;
const RESCHEDULE_EVENT_DELAY = 50;

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

class Timer {
    constructor(timeout, recurring = false, priority = GLib.PRIORITY_DEFAULT) {
        this._timeout = timeout;
        this._recurring = recurring;
        this._priority = priority;
    }

    run(
        callback,
        timeout = this._timeout,
        recurring = this._recurring,
        priority = this._priority
    ) {
        this.cancel();
        this._run(callback, timeout, recurring, priority);
    }

    _run(callback, timeout, recurring, priority) {
        if (!this._source || recurring) {
            this._source = GLib.timeout_source_new(timeout);
            this._source.set_priority(priority);
            this._source.set_callback(() => {
                callback();
                if (recurring) {
                    this._run(callback, timeout, recurring, priority);
                } else {
                    return GLib.SOURCE_REMOVE;
                }
            });
        }
        this._source.attach(null);
    }

    cancel() {
        if (this._source) {
            this._source.destroy();
            this._source = null;
        }
    }

    static run(
        timeout,
        callback,
        recurring = false,
        priority = GLib.PRIORITY_DEFAULT
    ) {
        return new Timer(timeout, recurring, priority).run(callback);
    }
}

// Abstract item used for folders and devices
class Item extends Signals.EventEmitter {
    constructor(data, manager) {
        super();
        this._state = State.UNKNOWN;
        this._stateEmitted = State.UNKNOWN;
        this._stateTimer = new Timer(ITEM_STATE_DELAY);
        this.id = data.id;
        this._name = data.name;
        this._manager = manager;
    }

    isBusy() {
        return (
            this.getState() == State.SYNCING ||
            this.getState() == State.SCANNING
        );
    }

    setState(state) {
        if (state.length > 0 && this._state != state) {
            this._stateTimer.cancel();
            console.info(LOG_PREFIX, "state change", this._name, state);
            this._state = state;
            // Stop items from excessive state changes by only emitting 1 state per stateDelay
            this._stateTimer.run(() => {
                if (this._stateEmitted != this._state) {
                    console.debug(
                        LOG_PREFIX,
                        "emit state change",
                        this._name,
                        this._state
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
        this._stateTimer.cancel();
        this.emit(Signal.DESTROY);
    }
}

// Abstract item collection used for folders and devices
class ItemCollection extends Signals.EventEmitter {
    constructor() {
        super();
        this._collection = {};
    }

    add(item) {
        if (item instanceof Item) {
            console.info(
                LOG_PREFIX,
                "add",
                item.constructor.name,
                item.getName()
            );
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
        this._determineTimer = new Timer(DEVICE_STATE_DELAY);
        this.folders = new ItemCollection();
        this.folders.connect(Signal.ADD, (collection, folder) => {
            folder.connect(
                Signal.STATE_CHANGE,
                this.determineStateDelayed.bind(this)
            );
        });
    }

    isOnline() {
        return (
            this.getState() != State.DISCONNECTED &&
            this.getState() != State.PAUSED
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
                        folder.getState()
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
        this._determineTimer.cancel();
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
                this.determineStateDelayed.bind(this)
            );
        });
        this._manager.devices.foreach((device) => {
            device.connect(
                Signal.STATE_CHANGE,
                this.determineStateDelayed.bind(this)
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
                    device.getState()
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

// Synthing configuration
class Config {
    CONFIG_PATH_KEY = "Configuration file";

    constructor(serviceFilePath) {
        this.serviceFilePath = serviceFilePath;
        this.clear();
    }

    destroy() {
        this.clear();
    }

    clear() {
        this._uri = "";
        this._address = "";
        this._apikey = "";
        this._secure = false;
        this._exists = false;
    }

    load() {
        this._exists = false;
        let configFile = Gio.File.new_for_path("");
        // Extract syncthing config file location from the synthing path command
        let result = GLib.spawn_sync(
            null,
            ["syncthing", "--paths"],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        )[1];
        let paths = {},
            pathArray = new TextDecoder().decode(result).split("\n\n");
        for (let i = 0; i < pathArray.length; i++) {
            let items = pathArray[i].split(":\n\t");
            if (items.length == 2) paths[items[0]] = items[1].split("\n\t");
        }
        if (this.CONFIG_PATH_KEY in paths) {
            configFile = Gio.File.new_for_path(paths[this.CONFIG_PATH_KEY][0]);
        }
        // As alternative, extract syncthing configuration from the default user config file
        if (!configFile.query_exists(null)) {
            configFile = Gio.File.new_for_path(
                GLib.get_user_state_dir() + "/syncthing/config.xml"
            );
        }
        // As alternative, extract syncthing configuration from the deprecated user config file
        if (!configFile.query_exists(null)) {
            configFile = Gio.File.new_for_path(
                GLib.get_user_config_dir() + "/syncthing/config.xml"
            );
        }
        if (configFile.query_exists(null)) {
            let configInputStream = configFile.read(null);
            let configDataInputStream =
                Gio.DataInputStream.new(configInputStream);
            let config = configDataInputStream.read_until("", null).toString();
            configInputStream.close(null);
            let regExp = new GLib.Regex(
                '<gui.*?tls="(true|false)".*?>.*?<address>(.*?)</address>.*?<apikey>(.*?)</apikey>.*?</gui>',
                GLib.RegexCompileFlags.DOTALL,
                0
            );
            let reMatch = regExp.match(config, 0);
            if (reMatch[0]) {
                this._address = reMatch[1].fetch(2);
                this._apikey = reMatch[1].fetch(3);
                this._uri =
                    "http" +
                    (reMatch[1].fetch(1) == "true" ? "s" : "") +
                    "://" +
                    this._address;
                this._exists = true;
                console.info(
                    LOG_PREFIX,
                    "found config",
                    this._address,
                    this._apikey,
                    this._uri
                );
            } else {
                console.error(LOG_PREFIX, "can't find gui xml node in config");
            }
        }
    }

    setService(force = false) {
        // (Force) Copy systemd config file to systemd's configuration directory (if it doesn't exist)
        let systemDConfigPath = GLib.get_user_config_dir() + "/systemd/user";
        let systemDConfigFile = Service.NAME + ".service";
        let systemDConfigFileTo = Gio.File.new_for_path(
            systemDConfigPath + "/" + systemDConfigFile
        );
        if (force || !systemDConfigFileTo.query_exists(null)) {
            let systemDConfigFileFrom = Gio.File.new_for_path(
                this.serviceFilePath + "/" + systemDConfigFile
            );
            let systemdConfigDirectory =
                Gio.File.new_for_path(systemDConfigPath);
            if (!systemdConfigDirectory.query_exists(null)) {
                systemdConfigDirectory.make_directory_with_parents(null);
            }
            let copyFlag = Gio.FileCopyFlags.NONE;
            if (force) copyFlag = Gio.FileCopyFlags.OVERWRITE;
            if (
                systemDConfigFileFrom.copy(
                    systemDConfigFileTo,
                    copyFlag,
                    null,
                    null
                )
            ) {
                console.info(
                    LOG_PREFIX,
                    "systemd configuration file copied to " +
                        systemDConfigFileTo
                );
            } else {
                console.warn(
                    LOG_PREFIX,
                    "couldn't copy systemd configuration file to " +
                        systemDConfigFileTo
                );
            }
        }
    }

    exists() {
        if (!this._exists) this.load();
        return this._exists;
    }

    getAPIKey() {
        return this._apikey;
    }

    getURI() {
        return this._uri;
    }
}

// Main system manager
export const Manager = class Manager extends Signals.EventEmitter {
    constructor(serviceFilePath) {
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
        this.config = new Config(serviceFilePath);
        this._httpSession = new Soup.Session();
        this._httpSession.ssl_strict = false; // Accept self signed certificates for now
        this._httpAborting = false;
        this._serviceFailed = false;
        this._serviceActive = false;
        this._serviceEnabled = false;
        this._pollTimer = new Timer(POLL_TIME, true);
        this._pollCount = 1; // Start at 1 to stop from recycling the hooks
        this._pollConnectionHook = 6; // Every 2 minutes
        this._pollConfigHook = 45; // Every 15 minutes
        this._lastEventID = 1;
        this._hostID = "";
        this._lastErrorTime = Date.now();
        this.connect(Signal.SERVICE_CHANGE, (manager, state) => {
            switch (state) {
                case ServiceState.USER_ACTIVE:
                case ServiceState.SYSTEM_ACTIVE:
                    this.openConnection(
                        "GET",
                        "/rest/system/status",
                        (status) => {
                            this._hostID = status.myID;
                            this._callConfig((config) => {
                                this._callEvents("limit=1");
                            });
                        }
                    );
                    this._pollTimer.run(this._pollState.bind(this));
                    break;
                case ServiceState.USER_STOPPED:
                case ServiceState.SYSTEM_STOPPED:
                    this.destroy();
                    this._lastEventID = 1;
                    break;
            }
        });
    }

    _callConfig(handler) {
        this.openConnection("GET", "/rest/system/config", (config) => {
            this._processConfig(config);
            if (handler) handler(config);
        });
    }

    _callEvents(options) {
        this.openConnection("GET", "/rest/events?" + options, (events) => {
            for (let i = 0; i < events.length; i++) {
                console.debug(
                    LOG_PREFIX,
                    "processing event",
                    events[i].type,
                    events[i].data
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
                                this.emit(
                                    Signal.LOGIN,
                                    events[i].data.username
                                );
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
                                let device = this.devices.get(
                                    events[i].data.device
                                );
                                if (
                                    device.folders.exists(events[i].data.folder)
                                ) {
                                    if (device.isOnline())
                                        device.setState(State.SCANNING);
                                    device.folders
                                        .get(events[i].data.folder)
                                        .setCompletion(
                                            events[i].data.completion
                                        );
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
                                this.folders
                                    .get(events[i].data.id)
                                    .setState(State.PAUSED);
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
                                this.devices
                                    .get(events[i].data.device)
                                    .setState(State.PAUSED);
                            }
                            break;
                        case EventType.DEVICE_CONNECTED:
                            if (this.devices.exists(events[i].data.id)) {
                                this.devices
                                    .get(events[i].data.id)
                                    .setState(State.IDLE);
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
                            break;
                    }
                    this._lastEventID = events[i].id;
                } catch (error) {
                    console.warn(
                        LOG_PREFIX,
                        "event processing failed",
                        error.message
                    );
                }
            }
            // Reschedule this event stream
            Timer.run(RESCHEDULE_EVENT_DELAY, () => {
                this._callEvents("since=" + this._lastEventID);
            });
        });
    }

    _callConnections() {
        this.openConnection("GET", "/rest/system/connections", (data) => {
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
                    this
                );
                this.folders.add(folder);
            } else {
                this.folders.get(config.folders[i].id).setName(name);
            }
            if (config.folders[i].paused) {
                this.folders.get(config.folders[i].id).setState(State.PAUSED);
            } else {
                this.openConnection(
                    "GET",
                    "/rest/db/status?folder=" + config.folders[i].id,
                    (function (folder) {
                        return (data) => {
                            folder.setState(data.state);
                        };
                    })(this.folders.get(config.folders[i].id))
                );
            }
            for (let j = 0; j < config.folders[i].devices.length; j++) {
                if (!(config.folders[i].devices[j].deviceID in usedDevices)) {
                    usedDevices[config.folders[i].devices[j].deviceID] = [];
                }
                usedDevices[config.folders[i].devices[j].deviceID].push(
                    this.folders.get(config.folders[i].id)
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
                            this
                        );
                    } else {
                        device = new Device(
                            {
                                id: config.devices[i].deviceID,
                                name: config.devices[i].name,
                            },
                            this
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
                                this.openConnection(
                                    "GET",
                                    "/rest/db/completion?folder=" +
                                        proxy.id +
                                        "&device=" +
                                        device.id,
                                    (function (proxy) {
                                        return (data) => {
                                            proxy.setCompletion(
                                                data.completion
                                            );
                                        };
                                    })(proxy)
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

    _pollState() {
        console.debug(
            LOG_PREFIX,
            "poll state",
            this._pollCount,
            this._pollCount % this._pollConfigHook,
            this._pollCount % this._pollConnectionHook
        );
        if (this._isServiceActive() && this.config.exists()) {
            if (this._pollCount % this._pollConfigHook == 0) {
                // TODO: this should not be necessary, we should remove old items
                this.folders.destroy();
                this.devices.destroy();
                this._callConfig();
            }
            if (this._pollCount % this._pollConnectionHook == 0) {
                this._isServiceEnabled();
                this._callConnections();
            }
            this.openConnection("GET", "/rest/system/error", (data) => {
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
            this._isServiceEnabled();
        }
        this._pollCount++;
    }

    _serviceState(user = false) {
        let command = this._serviceCommand("is-enabled", user),
            enabled = command == "enabled",
            disabled = command == "disabled";
        if (!enabled && !user) {
            return this._serviceState(true);
        }
        return {
            user: user,
            enabled: enabled,
            disabled: disabled,
        };
    }

    _isServiceActive() {
        let state = this._serviceState();
        if (state.enabled || state.disabled) {
            let command = this._serviceCommand("is-active", state.user),
                active = command == "active",
                failed = command == "failed";
            if (failed != this._serviceFailed) {
                this._serviceActive = failed;
                if (failed) {
                    console.error(LOG_PREFIX, Error.DAEMON, Service.NAME);
                    this.emit(Signal.ERROR, { type: Error.DAEMON });
                }
            }
            console.info(
                LOG_PREFIX,
                "service active",
                state.user,
                active,
                this._serviceActive
            );
            if (active != this._serviceActive) {
                this._serviceActive = active;
                if (state.user) {
                    this.emit(
                        Signal.SERVICE_CHANGE,
                        active
                            ? ServiceState.USER_ACTIVE
                            : ServiceState.USER_STOPPED
                    );
                } else {
                    this.emit(
                        Signal.SERVICE_CHANGE,
                        active
                            ? ServiceState.SYSTEM_ACTIVE
                            : ServiceState.SYSTEM_STOPPED
                    );
                }
                if (this.host)
                    this.host.setState(
                        active ? State.IDLE : State.DISCONNECTED
                    );
            }
            return active;
        }
    }

    _isServiceEnabled() {
        let state = this._serviceState();
        console.info(
            LOG_PREFIX,
            "service enabled",
            state.user,
            state.enabled,
            this._serviceEnabled
        );
        if (
            (state.enabled || state.disabled) &&
            state.enabled != this._serviceEnabled
        ) {
            this._serviceEnabled = state.enabled;
            if (state.user) {
                this.emit(
                    Signal.SERVICE_CHANGE,
                    state.enabled
                        ? ServiceState.USER_ENABLED
                        : ServiceState.USER_DISABLED
                );
            } else {
                this.emit(
                    Signal.SERVICE_CHANGE,
                    state.enabled
                        ? ServiceState.SYSTEM_ENABLED
                        : ServiceState.SYSTEM_DISABLED
                );
            }
        }
        return state.enabled;
    }

    _serviceCommand(command, user = true) {
        let args = ["systemctl", command];
        if (user) {
            args.push(Service.NAME);
            args.push("--user");
        } else {
            args.push(Service.NAME + "@" + GLib.get_user_name());
        }
        let result = new TextDecoder()
            .decode(
                GLib.spawn_sync(
                    null,
                    args,
                    null,
                    GLib.SpawnFlags.SEARCH_PATH,
                    null
                )[1]
            )
            .trim();
        console.debug(
            LOG_PREFIX,
            "calling systemd",
            command,
            user,
            args.toString(),
            result
        );
        return result;
    }

    abortConnections() {
        this._httpAborting = true;
        this._httpSession.abort();
    }

    openConnection(method, uri, callback) {
        if (this.config.exists()) {
            let msg = Soup.Message.new(method, this.config.getURI() + uri);
            msg.request_headers.append("X-API-Key", this.config.getAPIKey());
            this.openConnectionMessage(msg, callback);
        }
    }

    openConnectionMessage(msg, callback) {
        if (this._serviceActive && this.config.exists()) {
            console.debug(
                LOG_PREFIX,
                "opening connection",
                msg.method + ":" + msg.uri.get_path()
            );
            this._httpAborting = false;
            this._httpSession.send_and_read_async(
                msg,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    if (msg.status_code == Soup.Status.OK) {
                        let response;
                        try {
                            let bytes = session.send_and_read_finish(result);
                            let decoder = new TextDecoder("utf-8");
                            response = decoder.decode(bytes.get_data());
                        } catch (error) {
                            if (error.code == Gio.IOErrorEnum.TIMED_OUT) {
                                console.info(
                                    LOG_PREFIX,
                                    error.message,
                                    "will retry",
                                    msg.method + ":" + msg.uri.get_path()
                                );
                                // Retry this connection attempt
                                Timer.run(CONNECTION_RETRY_DELAY, () => {
                                    this.openConnectionMessage(msg, callback);
                                });
                            }
                        }
                        try {
                            if (callback && response && response.length > 0) {
                                console.debug(
                                    LOG_PREFIX,
                                    "callback",
                                    msg.method + ":" + msg.uri.get_path(),
                                    response
                                );
                                callback(JSON.parse(response));
                            }
                        } catch (error) {
                            console.error(
                                LOG_PREFIX,
                                Error.STREAM,
                                msg.method + ":" + msg.uri.get_path(),
                                error.message,
                                response
                            );
                            this.emit(Signal.ERROR, {
                                type: Error.STREAM,
                                message: msg.method + ":" + msg.uri.get_path(),
                            });
                        }
                    } else if (!this._httpAborting) {
                        console.error(
                            LOG_PREFIX,
                            Error.CONNECTION,
                            msg.reason_phrase,
                            msg.method + ":" + msg.get_uri().get_path(),
                            msg.status_code
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
                }
            );
        }
    }

    destroy() {
        this._pollTimer.cancel();
        this.folders.destroy();
        this.devices.destroy();
        this.config.destroy();
    }

    attach() {
        if (!this.config.exists()) {
            console.error(LOG_PREFIX, Error.CONFIG);
            this.emit(Signal.SERVICE_CHANGE, ServiceState.ERROR);
            this.emit(Signal.ERROR, { type: Error.CONFIG });
        } else {
            console.info(
                "attach manager",
                this._isServiceActive(),
                this._isServiceEnabled()
            );
        }
    }

    enableService() {
        this.config.setService(true);
        this._serviceCommand("enable");
        this._isServiceEnabled();
    }

    disableService() {
        this._serviceCommand("disable");
        this._isServiceEnabled();
    }

    startService() {
        this.config.setService();
        this._serviceCommand("start");
        this._serviceFailed = false;
    }

    stopService() {
        this.abortConnections();
        this._serviceCommand("stop");
    }

    rescan(folder) {
        if (folder) {
            this.openConnection("POST", "/rest/db/scan?folder=" + folder.id);
        } else {
            this.openConnection("POST", "/rest/db/scan");
        }
    }

    resume(device) {
        if (device) {
            this.openConnection(
                "POST",
                "/rest/system/resume?device=" + device.id
            );
        }
    }

    pause(device) {
        if (device) {
            this.openConnection(
                "POST",
                "/rest/system/pause?device=" + device.id
            );
        }
    }
};
