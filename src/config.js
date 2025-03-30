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

    constructor(settings, parseAll, extensionPath = null) {
        this.settings = settings;
        this._parseAll = parseAll;
        this._extensionPath = extensionPath;
        this.clear();
    }

    destroy() {
        this.clear();
    }

    clear() {
        this.filePath = null;
        this.fileURI = null;
        this.fileApiKey = null;
        this.prefURI = null;
        this.prefApiKey = null;
        this._autoConfig = true;
        this._exists = false;
    }

    load() {
        this.clear();
        this._autoConfig = this.settings.get_boolean("auto-config");
        if (this._parseAll || this._autoConfig) {
            this.loadFromConfigFile();
        }
        if (this._parseAll || !this._autoConfig) {
            this.loadFromPreferences();
        }
    }

    loadFromConfigFile() {
        this.filePath = Gio.File.new_for_path("");
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
            this.filePath = Gio.File.new_for_path(
                paths[this.CONFIG_PATH_KEY][0]
            );
        }
        // As alternative, extract syncthing configuration from the default user config file
        if (!this.filePath.query_exists(null)) {
            this.filePath = Gio.File.new_for_path(
                GLib.get_user_state_dir() + "/syncthing/config.xml"
            );
        }
        // As alternative, extract syncthing configuration from the deprecated user config file
        if (!this.filePath.query_exists(null)) {
            this.filePath = Gio.File.new_for_path(
                GLib.get_user_config_dir() + "/syncthing/config.xml"
            );
        }
        if (this.filePath.query_exists(null)) {
            let configInputStream = this.filePath.read(null);
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
                let address = reMatch[1].fetch(2);
                this.fileApiKey = reMatch[1].fetch(3);
                this.fileURI =
                    "http" +
                    (reMatch[1].fetch(1) == "true" ? "s" : "") +
                    "://" +
                    address;
                this._exists = true;
                console.info(
                    LOG_PREFIX,
                    "found config from file",
                    this.fileURI,
                    this.fileApiKey,
                    this.filePath.get_path()
                );
            } else {
                console.error(LOG_PREFIX, "can't find gui xml node in config");
            }
        } else {
            console.error(LOG_PREFIX, "can't find config file");
        }
    }

    loadFromPreferences() {
        if (
            this.settings.get_string("api-key").length >= 0 &&
            this.settings
                .get_string("service-uri")
                .search("https?://[-a-zA-Z0-9.]{1,256}:[0-9]{2,5}") >= 0
        ) {
            this.prefApiKey = this.settings.get_string("api-key");
            this.prefURI = this.settings.get_string("service-uri");
            this._exists = true;
            console.info(
                LOG_PREFIX,
                "found config from preferences",
                this.prefURI,
                this.prefApiKey
            );
        } else {
            console.error(LOG_PREFIX, "can't find valid custom config");
        }
    }

    exists() {
        if (!this._exists) this.load();
        return this._exists;
    }

    getAPIKey() {
        if (this._autoConfig) {
            return this.fileApiKey;
        } else {
            return this.prefApiKey;
        }
    }

    getURI() {
        if (this._autoConfig) {
            return this.fileURI;
        } else {
            return this.prefURI;
        }
    }
}
