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
        _init(extension) {
            super._init({
                title: _("syncthing"),
                toggleMode: true,
            });

            this.extension = extension;

            this.menu.box.add_style_class_name("syncthing-indicator");
            this.menu.box.add_style_class_name("toggle");
            this.menu.setHeader(null, _("syncthing"));

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

            extension.manager.connect(
                Syncthing.Signal.HOST_ADD,
                (manager, device) => {
                    this.subtitle = device.getName();
                }
            );

            extension.manager.connect(
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

            extension.manager.connect(
                Syncthing.Signal.ERROR,
                (manager, error) => {
                    switch (error.type) {
                        case Syncthing.Error.DAEMON:
                            this.set({ reactive: true, checked: false });
                            break;
                    }
                }
            );
        }
    }
);

export const SyncthingIndicatorQuickSetting = GObject.registerClass(
    class SyncthingIndicatorQuickSetting extends QuickSettings.SystemIndicator {
        _init(extension) {
            super._init();

            this.toggle = new SyncthingIndicatorToggle(extension);
            this.quickSettingsItems.push(this.toggle);

            this.panel = new Components.SyncthingPanel(
                extension,
                this.toggle.menu
            );
            this.panel.icon.addActor(this._addIndicator());
            this.panel.icon.addActor(this.toggle);
            this.panel.icon.addActor(this.toggle.menu._headerIcon);

            this.panel.menu.connect("open-state-changed", (menu, open) => {
                if (!open) Main.panel.statusArea.quickSettings.menu.close();
            });
        }

        destroy() {
            this.quickSettingsItems.forEach((item) => item.destroy());
            super.destroy();
        }

        // open(animate) {
        //     this.toggle.menu.open(animate);
        // }

        // close() {
        //     this.toggle.menu.close();
        // }

        open(animate) {
            this.panel.open(animate);
        }

        close() {
            this.panel.close();
        }
    }
);
