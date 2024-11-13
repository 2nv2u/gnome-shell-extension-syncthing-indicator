/* =============================================================================================================
	SyncthingIndicator 0.37
================================================================================================================

	GJS syncthing gnome-shell panel indicator signalling the Syncthing deamon status.

	Credits to <jay.strict@posteo.de> for the reference implementation

	Copyright (c) 2019-2023, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Syncthing from './syncthing.js';

const LOGPRE = 'syncthing-indicator:'

// Syncthing indicator panel icon
class SyncthingPanelIcon {

	constructor(iconPath) {
		this._workingIcon = new Animation.Animation(
			Gio.File.new_for_path(iconPath + 'syncthing-working.svg'), 20, 20, 80
		);
		this._idleIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(iconPath + 'syncthing-idle.svg'),
			icon_size: 20
		});
		this._pausedIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(iconPath + 'syncthing-paused.svg'),
			icon_size: 20
		});
		this._disconnectedIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(iconPath + 'syncthing-disconnected.svg'),
			icon_size: 20
		});
		this.actor = new St.Bin();
		this.actor.set_child(this._disconnectedIcon);
	}

	setState(state) {
		this._workingIcon.stop();
		switch (state) {
			case Syncthing.State.SYNCING:
			case Syncthing.State.SCANNING:
				this.actor.set_child(this._workingIcon);
				this._workingIcon.play();
				break
			case Syncthing.State.PAUSED:
				this.actor.set_child(this._pausedIcon);
				break;
			case Syncthing.State.UNKNOWN:
			case Syncthing.State.DISCONNECTED:
				this.actor.set_child(this._disconnectedIcon);
				break;
			default:
				this.actor.set_child(this._idleIcon);
				break
		}
	}

}

// Syncthing indicator section menu
class SectionMenu extends PopupMenu.PopupSubMenuMenuItem {

	_init(title, icon) {
		super._init(title, true);
		this.icon.icon_name = icon;
		this.section = new PopupMenu.PopupMenuSection();
		this.menu.addMenuItem(this.section);
	}

}
SectionMenu = GObject.registerClass({ GTypeName: 'SectionMenu' }, SectionMenu)

// Syncthing indicator fodler menu
class FolderMenu extends SectionMenu {

	_init() {
		super._init(_('folders'), 'system-file-manager-symbolic');
		this.setSensitive(false);
	}

}
FolderMenu = GObject.registerClass({ GTypeName: 'FolderMenu' }, FolderMenu)

// Syncthing indicator fodler menu item
class FolderMenuItem extends PopupMenu.PopupBaseMenuItem {

	_init(folder) {
		super._init();
		this._folder = folder;

		let icon;
		let file = Gio.File.new_for_path(this._folder.path);
		try {
			icon = file.query_info('standard::symbolic-icon', 0, null).get_symbolic_icon();
		} catch (e) {
			if (e instanceof Gio.IOErrorEnum) {
				if (!file.is_native()) {
					icon = new Gio.ThemedIcon({ name: 'folder-remote-symbolic' });
				} else {
					icon = new Gio.ThemedIcon({ name: 'folder-symbolic' });
				}
			} else {
				throw e;
			}
		}

		this.icon = new St.Icon({ gicon: icon, style_class: 'popup-menu-icon syncthing-state-icon' });
		this.actor.add_child(this.icon);

		this.label = new St.Label({ text: folder.getName(), style_class: 'syncthing-state-label' });
		this.actor.add_child(this.label);
		this.actor.label_actor = this.label;

		this.path = file.get_uri();

		this._folder.connect(Syncthing.Signal.STATE_CHANGE, (folder, state) => {
			this.icon.style_class = 'popup-menu-icon syncthing-state-icon ' + state;
		});

		this._folder.connect(Syncthing.Signal.NAME_CHANGE, (folder, name) => {
			this.label.text = name;
		});

		this._folder.connect(Syncthing.Signal.DESTROY, (folder) => {
			this.destroy();
		});

	}

	activate(event) {
		try {
			let launchContext = global.create_app_launch_context(event.get_time(), -1);
			Gio.AppInfo.launch_default_for_uri(this.path, launchContext);
		} catch (e) {
			console.error(LOGPRE, 'failed-URI', uri, e.message)
			Main.notifyError(_('failed-URI') + ': ' + uri, e.message);
		}
		super.activate(event);
	}

}
FolderMenuItem = GObject.registerClass({ GTypeName: 'FolderMenuItem' }, FolderMenuItem)

// Syncthing indicator device menu
class DeviceMenu extends SectionMenu {

	_init(extension) {
		super._init(_('this-device'), 'computer-symbolic');

		this.label.style_class = 'syncthing-state-label';

		// this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
		this.menu.addMenuItem(new PopupMenu.PopupBaseMenuItem({
			can_focus: false,
			hover: false,
			reactive: false
		}), 0);

		this._rescanItem = new RescanMenuItem(extension);
		this.menu.addMenuItem(this._rescanItem, 0);

		this._configItem = new ConfigMenuItem(extension);
		this.menu.addMenuItem(this._configItem, 0);

		this._autoSwitch = new AutoSwitchMenuItem(extension);
		this.menu.addMenuItem(this._autoSwitch, 0);

		this._serviceSwitch = new ServiceSwitchMenuItem(extension);
		this.menu.addMenuItem(this._serviceSwitch, 0);

	}

	setHost(device) {
		this._host = device;
		this.label.text = device.getName();

		this._host.connect(Syncthing.Signal.STATE_CHANGE, (device, state) => {
			this.icon.style_class = 'popup-menu-icon syncthing-state-icon ' + state;
		});

		this._host.connect(Syncthing.Signal.NAME_CHANGE, (device, name) => {
			this.label.text = name;
		});
	}

}
DeviceMenu = GObject.registerClass({ GTypeName: 'DeviceMenu' }, DeviceMenu)

// Syncthing indicator device menu item
class DeviceMenuItem extends PopupMenu.PopupSwitchMenuItem {

	_init(device) {
		super._init(device.getName(), false, null);
		this._device = device;
		let icon = new Gio.ThemedIcon({ name: 'network-server-symbolic' });
		this.icon = new St.Icon({ gicon: icon, style_class: 'popup-menu-icon syncthing-state-icon' });
		this.actor.insert_child_at_index(this.icon, 1);

		this.label.style_class = 'syncthing-state-label';

		this.setSensitive(false);

		this._device.connect(Syncthing.Signal.STATE_CHANGE, (device) => {
			let state = device.getState()
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
					break
			}
			this.icon.style_class = 'popup-menu-icon syncthing-state-icon ' + state;
		});

		this._device.connect(Syncthing.Signal.NAME_CHANGE, (device, name) => {
			this.label.text = name;
		});

		this._device.connect(Syncthing.Signal.DESTROY, () => {
			this.destroy();
		});

	}

	activate(event) {
		if (!this.actor.state) {
			this._device.resume();
		} else {
			this._device.pause();
		}
	}

}
DeviceMenuItem = GObject.registerClass({ GTypeName: 'DeviceMenuItem' }, DeviceMenuItem)

// Syncthing indicator rescan menu item
class RescanMenuItem extends PopupMenu.PopupBaseMenuItem {

	_init(extension) {
		super._init();
		this.setSensitive(false);
		this.actor.add_child(
			new St.Icon({
				gicon: new Gio.ThemedIcon({ name: 'emblem-synchronizing-symbolic' }),
				style_class: 'popup-menu-icon'
			})
		);

		this._label = new St.Label({ text: _('rescan') });
		this.actor.add_child(this._label);
		this.actor.label_actor = this._label;
		this.extension = extension

		extension.manager.connect(Syncthing.Signal.SERVICE_CHANGE, (manager, state) => {
			switch (state) {
				case Syncthing.ServiceState.USER_ACTIVE:
				case Syncthing.ServiceState.SYSTEM_ACTIVE:
					this.setSensitive(true);
					break;
				case Syncthing.ServiceState.USER_STOPPED:
				case Syncthing.ServiceState.SYSTEM_STOPPED:
					this.setSensitive(false);
					break;
				case Syncthing.ServiceState.ERROR:
					this.setSensitive(false);
					break;
			}
		});

	}

	activate(event) {
		this.extension.indicator.open(true)
		this.extension.manager.rescan();
	}

}
RescanMenuItem = GObject.registerClass({ GTypeName: 'RescanMenuItem' }, RescanMenuItem)

// Syncthing indicator config menu item
class ConfigMenuItem extends PopupMenu.PopupBaseMenuItem {

	_init(extension) {
		super._init();
		this.setSensitive(false);
		this.actor.add_child(
			new St.Icon({
				gicon: new Gio.ThemedIcon({ name: 'preferences-system-symbolic' }),
				style_class: 'popup-menu-icon'
			})
		);

		this._label = new St.Label({ text: _('web-interface') });
		this.actor.add_child(this._label);
		this.actor.label_actor = this._label;
		this.extension = extension

		extension.manager.connect(Syncthing.Signal.SERVICE_CHANGE, (manager, state) => {
			switch (state) {
				case Syncthing.ServiceState.USER_ACTIVE:
				case Syncthing.ServiceState.SYSTEM_ACTIVE:
					this.setSensitive(true);
					break;
				case Syncthing.ServiceState.USER_STOPPED:
				case Syncthing.ServiceState.SYSTEM_STOPPED:
					this.setSensitive(false);
					break;
				case Syncthing.ServiceState.ERROR:
					this.setSensitive(false);
					break;
			}
		});

	}

	activate(event) {
		let launchContext = global.create_app_launch_context(event.get_time(), -1);
		try {
			Gio.AppInfo.launch_default_for_uri(this.extension.manager.config.getURI(), launchContext);
		} catch (e) {
			console.error(LOGPRE, 'failed-URI', uri, e.message)
			Main.notifyError(_('failed-URI') + ': ' + uri, e.message);
		}
		super.activate(event);
	}

}
ConfigMenuItem = GObject.registerClass({ GTypeName: 'ConfigMenuItem' }, ConfigMenuItem)

// Syncthing service switch menu item
class ServiceSwitchMenuItem extends PopupMenu.PopupSwitchMenuItem {

	_init(extension) {
		super._init(_("service"), false);
		this.extension = extension

		extension.manager.connect(Syncthing.Signal.SERVICE_CHANGE, (manager, state) => {
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
		});

		extension.manager.connect(Syncthing.Signal.ERROR, (manager, error) => {
			switch (error.type) {
				case Syncthing.Error.DAEMON:
					this.setSensitive(true);
					this.setToggleState(false);
					break;
			}
		});

	}

	activate(event) {
		this.setSensitive(false);
		if (this._switch.mapped)
			this.toggle();
		if (this.actor.state) {
			this.extension.manager.startService();
		} else {
			this.extension.manager.stopService();
		}
	}

}
ServiceSwitchMenuItem = GObject.registerClass({ GTypeName: 'ServiceSwitchMenuItem' }, ServiceSwitchMenuItem)

// Syncthing service switch menu item
class AutoSwitchMenuItem extends PopupMenu.PopupSwitchMenuItem {

	_init(extension) {
		super._init(_("autostart"), false);
		this.extension = extension

		extension.manager.connect(Syncthing.Signal.SERVICE_CHANGE, (manager, state) => {
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
		});

	}

	activate(event) {
		this.setSensitive(false);
		if (this._switch.mapped)
			this.toggle();
		if (this.actor.state) {
			this.extension.manager.enableService();
		} else {
			this.extension.manager.disableService();
		}
	}

}
AutoSwitchMenuItem = GObject.registerClass({ GTypeName: 'AutoSwitchMenuItem' }, AutoSwitchMenuItem)

// Syncthing indicator controller
class SyncthingIndicator extends PanelMenu.Button {

	_init(extension) {
		super._init(0.0, "SyncthingIndicator");
		this.menu.box.add_style_class_name('syncthing-indicator');
		this.icon = new SyncthingPanelIcon(extension.metadata.path + '/icons/');
		this.add_child(this.icon.actor);

		this._deviceMenu = new DeviceMenu(extension);
		this.menu.addMenuItem(this._deviceMenu);
		this._deviceMenu.menu.connect('open-state-changed', (menu, open) => {
			if (this.menu.isOpen && !open) this._folderMenu.menu.open(true);
		});

		this._folderMenu = new FolderMenu(extension);
		this.menu.addMenuItem(this._folderMenu);
		this._folderMenu.menu.connect('open-state-changed', (menu, open) => {
			if (this.menu.isOpen && !open) this._deviceMenu.menu.open(true);
		});


		this.menu.connect('open-state-changed', (menu, open) => {
			if (open) this.open(false);
		});

		extension.manager.connect(Syncthing.Signal.ERROR, (manager, error) => {
			let errorType = 'unknown-error'
			switch (error.type) {
				case Syncthing.Error.DAEMON:
					errorType = 'daemon-error'
					break;
				case Syncthing.Error.SERVICE:
					errorType = 'service-error'
					break;
				case Syncthing.Error.STREAM:
					errorType = 'decoding-error'
					break;
				case Syncthing.Error.CONNECTION:
					errorType = 'connection-error'
					break;
				case Syncthing.Error.CONFIG:
					errorType = 'config-error'
					break;
			}
			console.error(LOGPRE, errorType, error)
			Main.notifyError('Syncthing Indicator', _(errorType));
		});

		extension.manager.connect(Syncthing.Signal.SERVICE_CHANGE, (manager, state) => {
			switch (state) {
				case Syncthing.ServiceState.USER_STOPPED:
				case Syncthing.ServiceState.SYSTEM_STOPPED:
					this._folderMenu.setSensitive(false)
					break;
			}
		});

		extension.manager.connect(Syncthing.Signal.FOLDER_ADD, (manager, folder) => {
			this._folderMenu.setSensitive(true);
			this._folderMenu.section.addMenuItem(
				new FolderMenuItem(folder)
			);
		});

		extension.manager.connect(Syncthing.Signal.DEVICE_ADD, (manager, device) => {
			this._deviceMenu.section.addMenuItem(
				new DeviceMenuItem(device)
			);
		});

		extension.manager.connect(Syncthing.Signal.HOST_ADD, (manager, device) => {
			this._deviceMenu.setHost(device);
			device.connect(Syncthing.Signal.STATE_CHANGE, (device, state) => {
				this.icon.setState(state);
			});
		});
	}

	open(animate) {
		if (this._folderMenu.getSensitive()) {
			this._folderMenu.menu.open(animate);
		} else {
			this._deviceMenu.menu.open(animate);
		}
	}

}
SyncthingIndicator = GObject.registerClass({ GTypeName: 'SyncthingIndicator' }, SyncthingIndicator)

// Syncthing indicator extension
export default class SyncthingIndicatorExtension extends Extension {

	// Syncthing indicator enabler
	enable() {
		this.manager = new Syncthing.Manager(this.metadata.path);
		this.indicator = new SyncthingIndicator(this);
		Main.panel.addToStatusArea('syncthingIndicator', this.indicator);
		this.manager.attach();
	}

	// Syncthing indicator disabler
	disable() {
		this.indicator.destroy();
		this.indicator = null;
		this.manager.destroy();
		this.manager = null;
	}

}