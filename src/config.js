/* =============================================================================================================
	SyncthingManager 0.49
================================================================================================================

	GJS syncthing config.

	Copyright (c) 2019-2026, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import Gio from "gi://Gio";
// Temporary promise fix Gio.Subprocess, it fails in prefs.js
Gio._promisify(Gio.Subprocess.prototype, "communicate_utf8_async");

import GLib from "gi://GLib";

import * as Utils from "./utils.js";

const LOG_PREFIX = "syncthing-indicator-config:";
const SYNCTHING_COMMAND = "syncthing";
const LOAD_RETRY_COUNT = 5;
const LOAD_RETRY_DELAY = 500;

class File {
  #paths = [];
  #index = 0;

  addPath(path) {
    this.#paths.push(path);
  }

  exists() {
    if (this.#paths.length === 0) return false;
    while (this.#index < this.#paths.length) {
      const gioFile = Gio.File.new_for_path(this.#paths[this.#index]);
      if (gioFile.query_exists(null)) {
        return true;
      }
      this.#index++;
    }
    return false;
  }

  get path() {
    if (this.#index < this.#paths.length) {
      return this.#paths[this.#index];
    }
    return null;
  }

  read() {
    const gioFile = Gio.File.new_for_path(this.#paths[this.#index]);
    return gioFile.read(null);
  }
}

// Synthing configuration
export default class Config {
  #parseAll;
  #extensionPath;
  #autoConfig = true;
  #exists = false;

  CONFIG_PATH_KEY = "Configuration file";

  constructor(settings, parseAll, extensionPath = null) {
    this.settings = settings;
    this.#parseAll = parseAll;
    this.#extensionPath = extensionPath;
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
    this.#autoConfig = true;
    this.#exists = false;
  }

  async load() {
    this.clear();
    this.#autoConfig = this.settings.get_boolean("auto-config");
    console.debug(LOG_PREFIX, "loading config, auto-config:", this.#autoConfig);
    if (this.#parseAll || this.#autoConfig) {
      await this.loadFromConfigFile();
    }
    if (this.#parseAll || !this.#autoConfig) {
      this.loadFromPreferences();
    }
    console.debug(LOG_PREFIX, "config loaded, exists:", this.#exists);
  }

  async loadFromConfigFile() {
    this.filePath = new File();
    try {
      const proc = Gio.Subprocess.new(
        [SYNCTHING_COMMAND, "paths"],
        Gio.SubprocessFlags.STDOUT_PIPE,
      );
      const pathArray = (await proc.communicate_utf8_async(null, null))
        .toString()
        .split("\n\n");
      const cmdPaths = {};
      for (let i = 0; i < pathArray.length; i++) {
        const items = pathArray[i].split(":\n\t");
        if (items.length == 2) cmdPaths[items[0]] = items[1].split("\n\t");
      }
      if (this.CONFIG_PATH_KEY in cmdPaths) {
        this.filePath.addPath(cmdPaths[this.CONFIG_PATH_KEY][0]);
      }
    } catch (error) {
      console.warn(
        LOG_PREFIX,
        "executing syncthing binary failed",
        error.message,
      );
    }

    this.filePath.addPath(GLib.get_user_config_dir() + "/syncthing/config.xml");
    this.filePath.addPath(GLib.get_user_state_dir() + "/syncthing/config.xml");

    if (this.filePath.exists()) {
      console.info(LOG_PREFIX, "found config file", this.filePath.path);
      const configInputStream = this.filePath.read();
      const configDataInputStream = Gio.DataInputStream.new(configInputStream);
      const config = configDataInputStream.read_until("", null).toString();
      configInputStream.close(null);

      const gui = new Utils.XMLParser().parse(config)?.configuration?.gui;
      const tls = gui?.tls;
      const address = gui?.address;
      const apiKey = gui?.apikey;
      if (address && apiKey) {
        this.fileApiKey = apiKey;
        this.fileURI = "http" + (tls === "true" ? "s" : "") + "://" + address;
        this.#exists = true;
        console.info(
          LOG_PREFIX,
          "found config from file",
          this.fileURI,
          this.fileApiKey.substr(0, 5) + "...",
          filePath.path,
        );
      } else {
        console.error(
          LOG_PREFIX,
          "no valid config found in file",
          filePath.path,
        );
      }
    }
  }

  loadFromPreferences() {
    const apiKey = this.settings.get_string("api-key");
    const serviceUri = this.settings.get_string("service-uri");
    if (
      apiKey.length > 0 &&
      serviceUri.search("https?://[-a-zA-Z0-9.]{1,256}:[0-9]{2,5}") >= 0
    ) {
      this.prefApiKey = apiKey;
      this.prefURI = serviceUri;
      this.#exists = true;
      console.info(
        LOG_PREFIX,
        "found config from preferences",
        this.prefURI,
        this.prefApiKey.substr(0, 5) + "...",
      );
    } else if (apiKey.length > 0) {
      console.error(
        LOG_PREFIX,
        "can't find valid custom config URI",
        this.prefURI,
      );
    } else {
      console.error(LOG_PREFIX, "can't find valid custom config");
    }
  }

  async exists() {
    if (!this.#exists) {
      await this.load();
      let retries = 0;
      while (!this.#exists && retries < LOAD_RETRY_COUNT) {
        console.warn(LOG_PREFIX, "config not found, retrying...", retries + 1);
        await new Promise((resolve) => {
          new Utils.Timer(LOAD_RETRY_DELAY).run(resolve);
        });
        await this.load();
        retries++;
      }
    }
    return this.#exists;
  }

  get APIKey() {
    if (this.#autoConfig) {
      return this.fileApiKey;
    } else {
      return this.prefApiKey;
    }
  }

  get URI() {
    if (this.#autoConfig) {
      return this.fileURI;
    } else {
      return this.prefURI;
    }
  }

  set useSystemD(value) {
    return this.settings.set_boolean("use-systemd", value);
  }

  get useSystemD() {
    return this.settings.get_boolean("use-systemd");
  }
}
