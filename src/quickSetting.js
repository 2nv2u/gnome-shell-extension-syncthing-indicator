/* =============================================================================================================
	SyncthingIndicator 0.40
================================================================================================================

	GJS syncthing gnome-shell quick setting indicator signalling the Syncthing deamon status.

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import GObject from "gi://GObject";
import Clutter from "gi://Clutter";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import * as Components from "./components.js";
import * as Syncthing from "./syncthing.js";

const LOG_PREFIX = "syncthing-indicator-quick-setting:";

// Syncthing indicator controller toggle
export const SyncthingIndicatorToggle = GObject.registerClass(
    class SyncthingIndicatorToggle extends QuickSettings.QuickMenuToggle {
        _init(indicator, extension) {
            super._init({
                title: _("syncthing"),
                toggleMode: true,
            });

            this.extension = extension;
            let manager = extension.manager;

            indicator.icon.addActor(this);

            this.menu.box.add_style_class_name("syncthing-indicator");
            this.menu.box.add_style_class_name("toggle");
            this.menu.setHeader(null, _("syncthing"));
            indicator.icon.addActor(this.menu._headerIcon);

            // Header action bar section
            // This is too instrusive in the implementation of the QuickToggleMenu
            // Find another way to control the header
            // TODO: Revisit
            const actionLayout = new Clutter.GridLayout();
            const actionBar = new St.Widget({
                layout_manager: actionLayout,
            });
            this.menu._headerSpacer.x_align = Clutter.ActorAlign.END;
            this.menu._headerSpacer.add_child(actionBar);

            const rescanButton = new Components.RescanButton(extension);
            actionLayout.attach(rescanButton, 0, 0, 1, 1);

            const advancedButton = new Components.AdvancedButton(extension);
            actionLayout.attach_next_to(
                advancedButton,
                rescanButton,
                Clutter.GridPosition.RIGHT,
                1,
                1
            );
            if (extension.settings.get_boolean("settings-button")) {
                const settingsButton = new Components.SettingsButton(extension);
                actionLayout.attach_next_to(
                    settingsButton,
                    advancedButton,
                    Clutter.GridPosition.RIGHT,
                    1,
                    1
                );
            }

            // Toggle action
            this.connect("clicked", () => {
                if (this.reactive) {
                    this.reactive = false;
                    if (this.checked) {
                        this.extension.manager.startService();
                    } else {
                        this.extension.manager.stopService();
                    }
                }
            });

            manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    switch (state) {
                        case Syncthing.ServiceState.USER_ACTIVE:
                            this.set({ reactive: true, checked: true });
                            break;
                        case Syncthing.ServiceState.SYSTEM_ACTIVE:
                            this.set({ reactive: false, checked: true });
                            break;
                        case Syncthing.ServiceState.USER_STOPPED:
                            this.set({ reactive: true, checked: false });
                            break;
                        case Syncthing.ServiceState.SYSTEM_STOPPED:
                            this.set({ reactive: false });
                        case Syncthing.ServiceState.ERROR:
                            this.set({ checked: false });
                            break;
                    }
                }
            );

            manager.connect(Syncthing.Signal.ERROR, (manager, error) => {
                switch (error.type) {
                    case Syncthing.Error.DAEMON:
                        this.set({ reactive: true, checked: false });
                        break;
                }
            });

            this._deviceMenu = new Components.DeviceMenu(extension);
            this._deviceMenu.showAutostartSwitch(true);
            this.menu.addMenuItem(this._deviceMenu);
            this._deviceMenu.menu.connect(
                "open-state-changed",
                (menu, open) => {
                    if (this.menu.isOpen && !open)
                        this._folderMenu.menu.open(true);
                }
            );

            this._folderMenu = new Components.FolderMenu(extension);
            this.menu.addMenuItem(this._folderMenu);
            this._folderMenu.menu.connect(
                "open-state-changed",
                (menu, open) => {
                    if (this.menu.isOpen && !open)
                        this._deviceMenu.menu.open(true);
                }
            );

            this.menu.connect("open-state-changed", (menu, open) => {
                if (open) this.open(false);
            });

            manager.connect(Syncthing.Signal.ERROR, (manager, error) => {
                let errorType = "unknown-error";
                switch (error.type) {
                    case Syncthing.Error.DAEMON:
                        errorType = "daemon-error";
                        break;
                    case Syncthing.Error.SERVICE:
                        errorType = "service-error";
                        break;
                    case Syncthing.Error.STREAM:
                        errorType = "decoding-error";
                        break;
                    case Syncthing.Error.CONNECTION:
                        errorType = "connection-error";
                        break;
                    case Syncthing.Error.CONFIG:
                        errorType = "config-error";
                        break;
                }
                console.error(LOG_PREFIX, errorType, error);
                Main.notifyError("Syncthing Indicator", _(errorType));
            });

            manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    switch (state) {
                        case Syncthing.ServiceState.USER_STOPPED:
                        case Syncthing.ServiceState.SYSTEM_STOPPED:
                            this._folderMenu.setSensitive(false);
                            break;
                    }
                }
            );

            manager.connect(Syncthing.Signal.FOLDER_ADD, (manager, folder) => {
                this._folderMenu.setSensitive(true);
                let folderMenuItem = new Components.FolderMenuItem(folder);
                this._folderMenu.addSectionItem(folderMenuItem);
                // Close quick settigns on opening folder
                folderMenuItem.connect("activate", () => {
                    Main.panel.statusArea.quickSettings.menu.close();
                });
            });

            manager.connect(Syncthing.Signal.DEVICE_ADD, (manager, device) => {
                this._deviceMenu.addSectionItem(
                    new Components.DeviceMenuItem(device)
                );
            });

            manager.connect(Syncthing.Signal.HOST_ADD, (manager, device) => {
                this._deviceMenu.setHost(device);
                this.subtitle = device.getName();
            });
        }

        open(animate) {
            if (this._folderMenu.getSensitive()) {
                this._folderMenu.menu.open(animate);
            } else {
                this._deviceMenu.menu.open(animate);
            }
        }

        close() {
            this.menu.close();
            Main.panel.statusArea.quickSettings.menu.close();
        }
    }
);

export const SyncthingIndicatorQuickSetting = GObject.registerClass(
    class SyncthingIndicatorQuickSetting extends QuickSettings.SystemIndicator {
        _init(extension) {
            super._init();

            this.icon = new Components.SyncthingPanelIcon(extension);
            this.icon.addActor(this._addIndicator());

            this.menu = new SyncthingIndicatorToggle(this, extension);
            this.quickSettingsItems.push(this.menu);

            extension.manager.connect(
                Syncthing.Signal.HOST_ADD,
                (manager, device) => {
                    device.connect(
                        Syncthing.Signal.STATE_CHANGE,
                        (device, state) => {
                            this.icon.setState(state);
                        }
                    );
                }
            );
        }

        destroy() {
            this.quickSettingsItems.forEach((item) => item.destroy());
            super.destroy();
        }

        open(animate) {
            this.menu.open(animate);
        }

        close() {
            this.menu.close();
        }
    }
);
