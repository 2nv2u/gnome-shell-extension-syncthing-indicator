/* =============================================================================================================
	SyncthingIndicator 0.42
================================================================================================================

	GJS syncthing gnome-shell panel indicator components.

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import Gio from "gi://Gio";
import GObject from "gi://GObject";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import * as Syncthing from "./syncthing.js";

const LOG_PREFIX = "syncthing-indicator-components:";

// Syncthing indicator panel icon
export const SyncthingPanelIcon = GObject.registerClass(
    class SyncthingPanelIcon extends St.Icon {
        _init(extension) {
            super._init({
                icon_size: 18,
            });

            let iconPath = extension.metadata.path + "/icons/";
            this._showState = extension.settings.get_boolean("icon-state");

            this._actors = [this];
            this._idleGIcon = Gio.icon_new_for_string(
                iconPath + "syncthing-idle.svg"
            );
            if (this._showState) {
                this._workingGIcon = Gio.icon_new_for_string(
                    iconPath + "syncthing-working.svg"
                );
                this._pausedGIcon = Gio.icon_new_for_string(
                    iconPath + "syncthing-paused.svg"
                );
                this._disconnectedGIcon = Gio.icon_new_for_string(
                    iconPath + "syncthing-disconnected.svg"
                );
                this.setGIcon(this._disconnectedGIcon);
            } else {
                this.setGIcon(this._idleGIcon);
            }

            extension.manager.connect(
                Syncthing.Signal.HOST_ADD,
                (manager, device) => {
                    device.connect(
                        Syncthing.Signal.STATE_CHANGE,
                        (device, state) => {
                            this.setState(state);
                        }
                    );
                }
            );
        }

        setState(state) {
            if (!this._showState) return;
            switch (state) {
                case Syncthing.State.SYNCING:
                case Syncthing.State.SCANNING:
                    this.setGIcon(this._workingGIcon);
                    break;
                case Syncthing.State.PAUSED:
                    this.setGIcon(this._pausedGIcon);
                    break;
                case Syncthing.State.UNKNOWN:
                case Syncthing.State.DISCONNECTED:
                    this.setGIcon(this._disconnectedGIcon);
                    break;
                default:
                    this.setGIcon(this._idleGIcon);
                    break;
            }
        }

        addActor(actor) {
            actor.gicon = this._activeIcon;
            this._actors.push(actor);
        }

        setGIcon(gicon) {
            this._activeIcon = gicon;
            for (let i = 0; i < this._actors.length; i++) {
                this._actors[i].gicon = gicon;
            }
        }
    }
);

// Syncthing indicator menu
export class SyncthingPanel {
    constructor(extension, menu) {
        this.menu = menu;
        this.icon = new SyncthingPanelIcon(extension);

        // No config item
        this._notConnectedItem = new NotConnectedItem(extension);
        this.menu.addMenuItem(this._notConnectedItem);

        // Device & folder section
        this._deviceMenu = new DeviceMenu(extension);
        this.menu.addMenuItem(this._deviceMenu);
        this._deviceMenu.menu.connect("open-state-changed", (menu, open) => {
            if (this.menu.isOpen && !open) this._folderMenu.menu.open(true);
        });

        this._folderMenu = new FolderMenu(extension);
        this.menu.addMenuItem(this._folderMenu);
        this._folderMenu.menu.connect("open-state-changed", (menu, open) => {
            if (this.menu.isOpen && !open) this._deviceMenu.menu.open(true);
        });

        this.menu.connect("open-state-changed", (menu, open) => {
            if (open) this.open(false);
        });

        extension.manager.connect(Syncthing.Signal.ERROR, (manager, error) => {
            // Use line based gettext function to be able to generate right text pot output
            let errorText = _("unknown-error");
            switch (error.type) {
                case Syncthing.Error.DAEMON:
                    errorText = _("daemon-error");
                    break;
                case Syncthing.Error.SERVICE:
                    errorText = _("service-error");
                    break;
                case Syncthing.Error.STREAM:
                    errorText = _("decoding-error");
                    break;
                case Syncthing.Error.CONNECTION:
                    errorText = _("connection-error");
                    break;
                case Syncthing.Error.CONFIG:
                    errorText = _("config-error");
                    break;
            }
            console.error(LOG_PREFIX, errorText, error);
            Main.notifyError(_("syncthing-indicator"), errorText);
        });
    }

    showServiceSwitch(toggle) {
        this._deviceMenu.showServiceSwitch(toggle);
    }

    showAutostartSwitch(toggle) {
        this._deviceMenu.showAutostartSwitch(toggle);
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
    }
}

// Syncthing suspendable switch menu item
export const SwitchMenuItem = GObject.registerClass(
    class SwitchMenuItem extends PopupMenu.PopupSwitchMenuItem {
        activate(event) {
            if (this._switch.mapped) this.toggle();
        }

        _attachSwitchSignal() {
            this._switchSignalID = this.connect(
                "toggled",
                this._process.bind(this)
            );
        }

        _detachSwitchSignal() {
            this.disconnect(this._switchSignalID);
        }

        _process(event, state) {
            // Process action when toggle signal is attached
        }
    }
);

// Syncthing indicator section menu
export const SectionMenu = GObject.registerClass(
    class SectionMenu extends PopupMenu.PopupSubMenuMenuItem {
        _init(title, icon) {
            super._init(title, true);
            this.icon.icon_name = icon;
            this.section = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this.section);
        }

        addSectionItem(item) {
            this.section.addMenuItem(item);
        }

        removeSectionItems() {
            this.section.removeAll();
        }

        destroy() {
            this.section.destroy();
            super.destroy();
        }
    }
);

// Syncthing indicator fodler menu
export const FolderMenu = GObject.registerClass(
    class FolderMenu extends SectionMenu {
        _init(extension) {
            super._init(_("folders"), "system-file-manager-symbolic");
            this.setSensitive(false);
            this.visible = false;

            extension.manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    switch (state) {
                        case Syncthing.ServiceState.CONNECTED:
                            this.setSensitive(true);
                            this.visible = true;
                            break;
                        case Syncthing.ServiceState.DISCONNECTED:
                            this.removeSectionItems();
                            this.setSensitive(false);
                            this.visible = false;
                            break;
                    }
                }
            );

            extension.manager.connect(
                Syncthing.Signal.FOLDER_ADD,
                (manager, folder) => {
                    this.addSectionItem(new FolderMenuItem(folder));
                }
            );
        }
    }
);

// Syncthing indicator fodler menu item
export const FolderMenuItem = GObject.registerClass(
    class FolderMenuItem extends PopupMenu.PopupBaseMenuItem {
        _init(folder) {
            super._init();
            this._folder = folder;
            let gicon;
            // Remove ~ from folders, resolving this doesn not work
            this.file = Gio.File.new_for_path(
                this._folder.path.replace("~/", "")
            );
            try {
                gicon = this.file
                    .query_info("standard::symbolic-icon", 0, null)
                    .get_symbolic_icon();
            } catch (e) {
                if (e instanceof Gio.IOErrorEnum) {
                    if (!this.file.is_native()) {
                        icon = new Gio.ThemedIcon({
                            name: "folder-remote-symbolic",
                        });
                    } else {
                        icon = new Gio.ThemedIcon({ name: "folder-symbolic" });
                    }
                } else {
                    throw e;
                }
            }

            this.icon = new St.Icon({
                gicon: gicon,
                style_class: "popup-menu-icon syncthing-state-icon",
            });
            this.actor.add_child(this.icon);

            this.label = new St.Label({
                text: folder.getName(),
                style_class: "syncthing-state-label",
            });
            this.actor.add_child(this.label);
            this.actor.label_actor = this.label;

            this._folder.connect(
                Syncthing.Signal.STATE_CHANGE,
                (folder, state) => {
                    this.icon.style_class =
                        "popup-menu-icon syncthing-state-icon " + state;
                }
            );

            this._folder.connect(
                Syncthing.Signal.NAME_CHANGE,
                (folder, name) => {
                    this.label.text = name;
                }
            );

            this._folder.connect(Syncthing.Signal.DESTROY, (folder) => {
                this.destroy();
            });
        }

        activate(event) {
            Gio.AppInfo.launch_default_for_uri(this.file.get_uri(), null);
            super.activate(event);
        }
    }
);

// Syncthing indicator device menu
export const DeviceMenu = GObject.registerClass(
    class DeviceMenu extends SectionMenu {
        _init(extension) {
            super._init(_("this-device"), "computer-symbolic");
            this.label.style_class = "syncthing-state-label";

            // TODO: hide on no devices
            this._deviceSeparator = new DevicesMenuSeparator();
            this.menu.addMenuItem(this._deviceSeparator, 0);

            this._autoSwitch = new AutoSwitchMenuItem(extension);
            this.menu.addMenuItem(this._autoSwitch, 0);

            this._serviceSwitch = new ServiceSwitchMenuItem(extension);
            this.menu.addMenuItem(this._serviceSwitch, 0);

            this._toggleVisibility(false);

            extension.manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    switch (state) {
                        case Syncthing.ServiceState.CONNECTED:
                            this._toggleVisibility(true);
                            break;
                        case Syncthing.ServiceState.DISCONNECTED:
                            this.removeSectionItems();
                            this._toggleVisibility(false);
                            break;
                    }
                }
            );

            extension.manager.connect(
                Syncthing.Signal.DEVICE_ADD,
                (manager, device) => {
                    this.addSectionItem(new DeviceMenuItem(device));
                }
            );

            extension.manager.connect(
                Syncthing.Signal.HOST_ADD,
                (manager, device) => {
                    this.setHost(device);
                }
            );
        }

        setHost(device) {
            this._host = device;
            this.label.text = device.getName();

            this._host.connect(
                Syncthing.Signal.STATE_CHANGE,
                (device, state) => {
                    this.icon.style_class =
                        "popup-menu-icon syncthing-state-icon " + state;
                }
            );

            this._host.connect(Syncthing.Signal.NAME_CHANGE, (device, name) => {
                this.label.text = name;
            });
        }

        addSectionItem(item) {
            super.addSectionItem(item);
            this._toggleVisibility(true);
        }

        showAutostartSwitch(toggle) {
            this._autoSwitch.visible = toggle;
            this._toggleVisibility(toggle);
        }

        showServiceSwitch(toggle) {
            this._serviceSwitch.visible = toggle;
            this._toggleVisibility(toggle);
        }

        _toggleVisibility(toggle) {
            let elementsVisible =
                this._autoSwitch.visible ||
                this._serviceSwitch.visible ||
                this.section.numMenuItems > 0;
            if (toggle) {
                this.setSensitive(toggle);
                this.visible = toggle;
            } else {
                this.setSensitive(elementsVisible);
                this.visible = elementsVisible;
            }
            this._deviceSeparator.visible =
                (this._autoSwitch.visible || this._serviceSwitch.visible) &&
                this.section.numMenuItems > 0;
        }
    }
);

// Syncthing indicator device menu item
export const DeviceMenuItem = GObject.registerClass(
    class DeviceMenuItem extends SwitchMenuItem {
        _init(device) {
            super._init(device.getName(), false, null);
            this._device = device;
            // let icon = new Gio.ThemedIcon({ name: 'network-computer-symbolic' });
            let icon = new Gio.ThemedIcon({ name: "network-server-symbolic" });
            this.icon = new St.Icon({
                gicon: icon,
                style_class: "popup-menu-icon syncthing-state-icon",
            });
            this.actor.insert_child_at_index(this.icon, 1);

            this.label.style_class = "syncthing-state-label";

            this.setSensitive(false);

            this._device.connect(Syncthing.Signal.STATE_CHANGE, (device) => {
                let state = device.getState();
                this._detachSwitchSignal();
                switch (state) {
                    case Syncthing.State.DISCONNECTED:
                        this.setSensitive(false);
                        this.setToggleState(false);
                        break;
                    case Syncthing.State.PAUSED:
                        this.setSensitive(true);
                        this.setToggleState(false);
                        break;
                    default:
                        this.setSensitive(true);
                        this.setToggleState(true);
                        break;
                }
                this._attachSwitchSignal();
                this.icon.style_class =
                    "popup-menu-icon syncthing-state-icon " + state;
            });

            this._device.connect(
                Syncthing.Signal.NAME_CHANGE,
                (device, name) => {
                    this.label.text = name;
                }
            );

            this._device.connect(Syncthing.Signal.DESTROY, () => {
                this.destroy();
            });
        }

        _process(event, state) {
            this.setSensitive(false);
            if (state) {
                this._device.resume();
            } else {
                this._device.pause();
            }
        }
    }
);

// Syncthing indicator device menu item
export const DevicesMenuSeparator = GObject.registerClass(
    class DevicesMenuSeparator extends PopupMenu.PopupMenuItem {
        _init() {
            super._init(_("devices"), {
                can_focus: false,
                hover: false,
                reactive: false,
                style_class: "separator",
            });
            this.visible = false;
            this.icon = new St.Icon({
                gicon: new Gio.ThemedIcon({
                    name: "network-workgroup-symbolic",
                }),
                style_class: "popup-menu-icon syncthing-state-icon",
            });
            this.actor.insert_child_at_index(this.icon, 1);
        }
    }
);

// Syncthing indicator no config item
export const NotConnectedItem = GObject.registerClass(
    class NotConnectedItem extends PopupMenu.PopupMenuItem {
        _init(extension) {
            super._init(_("not-connected"), {
                can_focus: false,
                hover: false,
                reactive: false,
            });

            extension.manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    switch (state) {
                        case Syncthing.ServiceState.CONNECTED:
                            this.visible = false;
                            break;
                        case Syncthing.ServiceState.DISCONNECTED:
                            this.visible = true;
                            break;
                    }
                }
            );
        }
    }
);

// Syncthing service switch menu item
export const ServiceSwitchMenuItem = GObject.registerClass(
    class ServiceSwitchMenuItem extends SwitchMenuItem {
        _init(extension) {
            super._init(_("service"), false);
            this.extension = extension;
            this.visible = false;

            extension.manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    this._detachSwitchSignal();
                    switch (state) {
                        case Syncthing.ServiceState.USER_ACTIVE:
                            this.setSensitive(true);
                            this.setToggleState(true);
                            break;
                        case Syncthing.ServiceState.SYSTEM_ACTIVE:
                            this.setSensitive(false);
                            this.setToggleState(true);
                            break;
                        case Syncthing.ServiceState.USER_STOPPED:
                            this.setSensitive(true);
                            this.setToggleState(false);
                            break;
                        case Syncthing.ServiceState.SYSTEM_STOPPED:
                            this.setSensitive(false);
                        case Syncthing.ServiceState.ERROR:
                            this.setToggleState(false);
                            break;
                    }
                    this._attachSwitchSignal();
                }
            );

            extension.manager.connect(
                Syncthing.Signal.ERROR,
                (manager, error) => {
                    this._detachSwitchSignal();
                    switch (error.type) {
                        case Syncthing.Error.DAEMON:
                            this.setSensitive(true);
                            this.setToggleState(false);
                            break;
                    }
                    this._attachSwitchSignal();
                }
            );
        }

        _process(event, state) {
            this.setSensitive(false);
            if (state) {
                this.extension.manager.startService();
            } else {
                this.extension.manager.stopService();
            }
        }
    }
);

// Syncthing service switch menu item
export const AutoSwitchMenuItem = GObject.registerClass(
    class AutoSwitchMenuItem extends SwitchMenuItem {
        _init(extension) {
            super._init(_("autostart"), false);
            this.extension = extension;
            this.visible = false;

            extension.manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    this._detachSwitchSignal();
                    switch (state) {
                        case Syncthing.ServiceState.USER_ENABLED:
                            this.setSensitive(true);
                            this.setToggleState(true);
                            break;
                        case Syncthing.ServiceState.SYSTEM_ENABLED:
                            this.setSensitive(false);
                            this.setToggleState(true);
                            break;
                        case Syncthing.ServiceState.USER_DISABLED:
                            this.setSensitive(true);
                            this.setToggleState(false);
                            break;
                        case Syncthing.ServiceState.SYSTEM_DISABLED:
                            this.setSensitive(false);
                        case Syncthing.ServiceState.ERROR:
                            this.setToggleState(false);
                            break;
                    }
                    this._attachSwitchSignal();
                }
            );
        }

        _process(event, state) {
            this.setSensitive(false);
            if (state) {
                this.extension.manager.enableService();
            } else {
                this.extension.manager.disableService();
            }
        }
    }
);

// Syncthing service rescan button
export const RescanButton = GObject.registerClass(
    class RescanButton extends St.Button {
        _init(extension) {
            super._init({
                style_class: "icon-button",
                can_focus: true,
                icon_name: "feed-refresh-symbolic",
                accessible_name: _("rescan"),
                reactive: false,
            });

            this.extension = extension;

            this.connect("clicked", () => {
                this.extension.indicator.open(true);
                this.extension.manager.rescan();
            });

            extension.manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    switch (state) {
                        case Syncthing.ServiceState.CONNECTED:
                            this.reactive = true;
                            break;
                        case Syncthing.ServiceState.DISCONNECTED:
                            this.reactive = false;
                            break;
                    }
                }
            );
        }
    }
);

// Syncthing advanced service settings button (web interface)
export const AdvancedButton = GObject.registerClass(
    class AdvancedButton extends St.Button {
        _init(extension) {
            super._init({
                style_class: "icon-button",
                can_focus: true,
                icon_name: "system-run-symbolic",
                accessible_name: _("web-interface"),
                reactive: false,
            });

            this.extension = extension;

            this.connect("clicked", () => {
                Gio.AppInfo.launch_default_for_uri(
                    this.extension.manager.getServiceURI(),
                    null
                );
                this.extension.indicator.close();
            });

            extension.manager.connect(
                Syncthing.Signal.SERVICE_CHANGE,
                (manager, state) => {
                    switch (state) {
                        case Syncthing.ServiceState.CONNECTED:
                            this.reactive = true;
                            break;
                        case Syncthing.ServiceState.DISCONNECTED:
                            this.reactive = false;
                            break;
                    }
                }
            );
        }
    }
);

// Syncthing extension settings button
export const SettingsButton = GObject.registerClass(
    class SettingsButton extends St.Button {
        _init(extension) {
            super._init({
                style_class: "icon-button",
                can_focus: true,
                icon_name: "org.gnome.Settings-symbolic",
                accessible_name: _("settings"),
            });

            this.extension = extension;

            this.connect("clicked", () => {
                this.extension.openPreferences();
                this.extension.indicator.close();
            });
        }
    }
);
