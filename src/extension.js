/* =============================================================================================================
	SyncthingIndicator 0.44
================================================================================================================

	GJS syncthing gnome-shell panel indicator signalling the Syncthing deamon status.

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
    Extension,
    gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";

import * as Syncthing from "./syncthing.js";
import * as PanelMenu from "./panelMenu.js";
import * as QuickSetting from "./quickSetting.js";
import * as Utils from "./utils.js";
import Config from "./config.js";

const SETTINGS_DELAY = 500;

// Syncthing indicator extension
export default class SyncthingIndicatorExtension extends Extension {
    // Syncthing indicator enabler
    enable() {
        this._settingTimer = new Utils.Timer(SETTINGS_DELAY);
        this.settings = this.getSettings();
        this.settings.connect("changed", () => {
            this._settingTimer.run(() => {
                this.indicator.close();
                this.disable();
                this.enable();
            });
        });
        this.manager = new Syncthing.Manager(
            new Config(this.settings, false),
            this.metadata.path
        );
        switch (this.settings.get_int("menu")) {
            case 0:
                this.indicator =
                    new QuickSetting.SyncthingIndicatorQuickSetting(this);
                Main.panel.statusArea.quickSettings.addExternalIndicator(
                    this.indicator
                );
                break;
            case 1:
                this.indicator = new PanelMenu.SyncthingIndicatorPanel(this);
                Main.panel.addToStatusArea(
                    "SyncthingIndicatorPanel",
                    this.indicator
                );
                break;
        }
        this.manager.attach();
    }

    // Syncthing indicator disabler
    disable() {
        this.settings = null;
        this.indicator.destroy();
        this.indicator = null;
        this.manager.destroy();
        this.manager = null;
    }
}
