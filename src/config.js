/* =============================================================================================================
	SyncthingManager 0.42
================================================================================================================

	GJS syncthing config.

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

const LOG_PREFIX = "syncthing-indicator-config:";

// Synthing configuration
export default class Config {
    CONFIG_PATH_KEY = "Configuration file";

    constructor(settings, extensionPath = null) {
        this.settings = settings;
        this._extensionPath = extensionPath;
        this.clear();
    }

    destroy() {
        this.clear();
    }

    clear() {
        this.uri = null;
        this.apiKey = null;
        this.file = null;
        this._secure = false;
        this._exists = false;
    }

    load() {
        this._exists = false;
        this.file = Gio.File.new_for_path("");
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
            this.file = Gio.File.new_for_path(paths[this.CONFIG_PATH_KEY][0]);
        }
        // As alternative, extract syncthing configuration from the default user config file
        if (!this.file.query_exists(null)) {
            this.file = Gio.File.new_for_path(
                GLib.get_user_state_dir() + "/syncthing/config.xml"
            );
        }
        // As alternative, extract syncthing configuration from the deprecated user config file
        if (!this.file.query_exists(null)) {
            this.file = Gio.File.new_for_path(
                GLib.get_user_config_dir() + "/syncthing/config.xml"
            );
        }
        if (this.file.query_exists(null)) {
            let configInputStream = this.file.read(null);
            let configDataInputStream =
                Gio.DataInputStream.new(configInputStream);
            let config = configDataInputStream.read_until("", null).toString();
            configInputStream.close(null);
            let regExp = new GLib.Regex(
                '<gui.*?tls="(true|false)".*?>.*?<address>(.*?)</address>.*?<apiKey>(.*?)</apiKey>.*?</gui>',
                GLib.RegexCompileFlags.DOTALL,
                0
            );
            let reMatch = regExp.match(config, 0);
            console.error(LOG_PREFIX, config, reMatch);
            if (reMatch[0]) {
                let address = reMatch[1].fetch(2);
                this.apiKey = reMatch[1].fetch(3);
                this.uri =
                    "http" +
                    (reMatch[1].fetch(1) == "true" ? "s" : "") +
                    "://" +
                    address;
                this._exists = true;
                console.info(
                    LOG_PREFIX,
                    "found config",
                    address,
                    this.apiKey,
                    this.uri
                );
            } else {
                console.error(LOG_PREFIX, "can't find gui xml node in config");
            }
        } else {
            console.error(LOG_PREFIX, "can't find config file");
        }
    }
    // } else {
    //     if (
    //         this.settings
    //             .get_string("service-uri")
    //             .search("https?://[-a-zA-Z0-9.]{1,256}:[0-9]{2,5}") >= 0 &&
    //         this.settings.get_string("api-key").length >= 0
    //     ) {
    //         this.uri = this.settings.get_string("service-uri");
    //         this.apiKey = this.settings.get_string("api-key");
    //         this._exists = true;
    //     }
    // }

    setService(force = false) {
        // (Force) Copy systemd config file to systemd's configuration directory (if it doesn't exist)
        let systemDConfigPath = GLib.get_user_config_dir() + "/systemd/user";
        let systemDConfigFile = Service.NAME + ".service";
        let systemDConfigFileTo = Gio.File.new_for_path(
            systemDConfigPath + "/" + systemDConfigFile
        );
        if (
            this._extensionPath &&
            (force || !systemDConfigFileTo.query_exists(null))
        ) {
            let systemDConfigFileFrom = Gio.File.new_for_path(
                this._extensionPath + "/" + systemDConfigFile
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
        return this.apiKey;
    }

    getURI() {
        return this.uri;
    }
}
