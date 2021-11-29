/* =============================================================================================================
	SyncthingIndicator 0.22
================================================================================================================

	GJS syncthing gnome-shell panel indicator signalling the Syncthing deamon status.

	Credits to <jay.strict@posteo.de> for the reference implementation

	Copyright (c) 2019-2021, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;

const Main = imports.ui.main;
const Animation = imports.ui.animation;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const StatusSystem = imports.ui.status.system;
const Gettext = imports.gettext;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Domain = Gettext.domain(Me.metadata.uuid);
const _ = Domain.gettext;

const Logger = Me.imports.logger;
const console = new Logger.Service(Logger.Level.WARN,'syncthing-indicator-ui');

const Syncthing = Me.imports.syncthing;

// Syncthing indicator panel icon
class SyncthingPanelIcon {

	constructor(){
		this._workingIcon = new Animation.Animation(
			Gio.File.new_for_path(Me.path+'/icons/syncthing-working.svg'), 20, 20, 80
		);
		this._idleIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(Me.path+'/icons/syncthing-idle.svg'),
			icon_size: 20
		});
		this._pausedIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(Me.path+'/icons/syncthing-paused.svg'),
			icon_size: 20
		});
		this._disconnectedIcon = new St.Icon({
			gicon: Gio.icon_new_for_string(Me.path+'/icons/syncthing-disconnected.svg'),
			icon_size: 20
		});
		this.actor = new St.Bin();
		this.actor.set_child(this._disconnectedIcon);
	}

	setState(state){
		this._workingIcon.stop();
		switch(state){
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

	_init(title,icon){
		super._init(title,true);
		this.icon.icon_name = icon;
		this.icon.add_style_class_name('syncthing-submenu-icon');
		this.section = new PopupMenu.PopupMenuSection();
		this.section.actor.add_style_class_name('syncthing-menu-spacing');
		this.menu.addMenuItem(this.section);
	}

}
SectionMenu = GObject.registerClass({GTypeName: 'SectionMenu'}, SectionMenu)

// Syncthing indicator fodler menu
class FolderMenu extends SectionMenu {

	_init(){
		super._init(_('folders'),'system-file-manager-symbolic');
		this.setSensitive(false);
	}

}
FolderMenu = GObject.registerClass({GTypeName: 'FolderMenu'}, FolderMenu)

// Syncthing indicator fodler menu item
class FolderMenuItem extends PopupMenu.PopupBaseMenuItem {

	_init(folder){
		super._init();
		this._folder = folder;

		let icon;
		let file = Gio.File.new_for_path(this._folder.path);
		try {
			icon = file.query_info('standard::symbolic-icon', 0, null).get_symbolic_icon();
		} catch(e){
			if(e instanceof Gio.IOErrorEnum){
				if(!file.is_native()){
					icon = new Gio.ThemedIcon({ name: 'folder-remote-symbolic' });
				} else {
					icon = new Gio.ThemedIcon({ name: 'folder-symbolic' });
				}
			} else {
				throw e;
			}
		}

		this.icon = new St.Icon({ gicon: icon, style_class: 'popup-menu-icon' });
		this.actor.add_child(this.icon);

		this.label = new St.Label({ text: folder.name });
		this.actor.add_child(this.label);
		this.actor.label_actor = this.label;

		this.path = file.get_uri();

		this._folder.connect(Syncthing.Signal.STATE_CHANGE, (folder,state) => {
			this.icon.style_class = 'popup-menu-icon '+state;
		});

		this._folder.connect(Syncthing.Signal.DESTROY, (folder) => {
			this.destroy();
		});

	}

	activate(event){
		try {
			let launchContext = global.create_app_launch_context(event.get_time(), -1);
			Gio.AppInfo.launch_default_for_uri(this.path, launchContext);
		} catch(e){
			Main.notifyError(_('failed-URI')+': '+uri, e.message);
		}
		super.activate(event);
	}

}
FolderMenuItem = GObject.registerClass({GTypeName: 'FolderMenuItem'}, FolderMenuItem)

// Syncthing indicator device menu
class DeviceMenu extends SectionMenu {

	_init(extension){
		super._init(_('this-device'),'computer-symbolic');

		this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

		this._serviceSwitch = new ServiceSwitchMenuItem(extension);
		this.menu.addMenuItem(this._serviceSwitch);

		this._autoSwitch = new AutoSwitchMenuItem(extension);
		this.menu.addMenuItem(this._autoSwitch);

		this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

		this._configItem = new ConfigMenuItem(extension);
		this.menu.addMenuItem(this._configItem);

		this._rescanItem = new RescanMenuItem(extension);
		this.menu.addMenuItem(this._rescanItem);

		extension.manager.connect(Syncthing.Signal.SERVICE_CHANGE, (manager,state) => {
			switch(state){
				case Syncthing.ServiceState.ACTIVE:
					this._serviceSwitch.setSensitive(true);
					this._serviceSwitch.setToggleState(true);
					this._configItem.setSensitive(true);
					this._rescanItem.setSensitive(true);
				break;
				case Syncthing.ServiceState.STOPPED:
					this._serviceSwitch.setSensitive(true);
					this._serviceSwitch.setToggleState(false);
					this._configItem.setSensitive(false);
					this._rescanItem.setSensitive(false);
				break;
				case Syncthing.ServiceState.ENABLED:
					this._autoSwitch.setSensitive(true);
					this._autoSwitch.setToggleState(true);
				break;
				case Syncthing.ServiceState.DISABLED:
					this._autoSwitch.setSensitive(true);
					this._autoSwitch.setToggleState(false);
				break;
				case Syncthing.ServiceState.ERROR:
					this._serviceSwitch.setSensitive(false);
					this._autoSwitch.setSensitive(false);
				break;
			}
		});

		extension.manager.connect(Syncthing.Signal.ERROR, (manager,error) => {
			switch(error.type){
				case Syncthing.Error.DAEMON:
					this._serviceSwitch.setToggleState(false);
				break;
			}
		});

	}

	setDevice(device){
		this.device = device;
		this.label.text = device.name;
		this.device.connect(Syncthing.Signal.STATE_CHANGE, (device,state) => {
			this.icon.style_class = 'popup-menu-icon syncthing-submenu-icon '+state;
		});
	}

}
DeviceMenu = GObject.registerClass({GTypeName: 'DeviceMenu'}, DeviceMenu)

// Syncthing indicator device menu item
class DeviceMenuItem extends PopupMenu.PopupSwitchMenuItem {

	_init(device){
		super._init(device.name, false, null);

		this._device = device;

		let icon = new Gio.ThemedIcon({ name: 'network-server-symbolic' });
		this.icon = new St.Icon({ gicon: icon, style_class: 'popup-menu-icon' });
		this.actor.insert_child_at_index(this.icon,1);

		this.setSensitive(false);

		this._device.connect(Syncthing.Signal.STATE_CHANGE, (device) => {
			let state = device.getState()
			switch(state){
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
			this.icon.style_class = 'popup-menu-icon '+state;
		});

		this._device.connect(Syncthing.Signal.DESTROY, () => {
			this.destroy();
		});

	}

	activate(event){
		if(!this.actor.state){
			this._device.resume();
		} else {
			this._device.pause();
		}
	}

}
DeviceMenuItem = GObject.registerClass({GTypeName: 'DeviceMenuItem'}, DeviceMenuItem)

// Syncthing indicator rescan menu item
class RescanMenuItem extends PopupMenu.PopupBaseMenuItem {

	_init(extension){
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
	}

	activate(event){
		this.extension.indicator.folderMenu.menu.open(true)
		this.extension.manager.rescan();
	}

}
RescanMenuItem = GObject.registerClass({GTypeName: 'RescanMenuItem'}, RescanMenuItem)

// Syncthing indicator config menu item
class ConfigMenuItem extends PopupMenu.PopupBaseMenuItem {

	_init(extension){
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
	}

	activate(event){
		let launchContext = global.create_app_launch_context(event.get_time(), -1);
		try {
			Gio.AppInfo.launch_default_for_uri(this.extension.manager.getConfig().getURI(), launchContext);
		} catch(e){
			Main.notifyError(_('failed-URI')+': '+uri, e.message);
		}
		super.activate(event);
	}

}
ConfigMenuItem = GObject.registerClass({GTypeName: 'ConfigMenuItem'}, ConfigMenuItem)

// Syncthing service switch menu item
class ServiceSwitchMenuItem extends PopupMenu.PopupSwitchMenuItem {

	_init(extension){
		super._init(_("service"), false);
		this.extension = extension
	}

	activate(event){
		if (this._switch.mapped)
			this.toggle();
		if(this.actor.state){
			this.extension.manager.startService();
		} else {
			this.extension.manager.stopService();
		}
	}

}
ServiceSwitchMenuItem = GObject.registerClass({GTypeName: 'ServiceSwitchMenuItem'}, ServiceSwitchMenuItem)

// Syncthing service switch menu item
class AutoSwitchMenuItem extends PopupMenu.PopupSwitchMenuItem {

	_init(extension){
		super._init(_("autostart"), false);
		this.extension = extension
	}

	activate(event){
		if (this._switch.mapped)
			this.toggle();
		if(this.actor.state){
			this.extension.manager.enableService();
		} else {
			this.extension.manager.disableService();
		}
	}

}
AutoSwitchMenuItem = GObject.registerClass({GTypeName: 'AutoSwitchMenuItem'}, AutoSwitchMenuItem)

// Syncthing indicator controller
class SyncthingIndicator extends PanelMenu.Button {

	_init(extension){
		super._init(0.0, "SyncthingIndicator");

		this.menu.box.add_style_class_name('syncthing-indicator');

		this.icon = new SyncthingPanelIcon();
		this.add_actor(this.icon.actor);

		this.deviceMenu = new DeviceMenu(extension);
		this.menu.addMenuItem(this.deviceMenu);
		this.deviceMenu.menu.connect('open-state-changed', (menu,open) => {
			if(this.menu.isOpen && !open) this.folderMenu.menu.open(true);
		});

		this.folderMenu = new FolderMenu(extension);
		this.menu.addMenuItem(this.folderMenu);
		this.folderMenu.menu.connect('open-state-changed', (menu,open) => {
			if(this.menu.isOpen && !open) this.deviceMenu.menu.open(true);
		});

		this.defaultMenu = this.deviceMenu;
		this.menu.connect('open-state-changed', (menu,open) => {
			if(open) this.defaultMenu.menu.open(false);
		});

		extension.manager.connect(Syncthing.Signal.ERROR, (manager,error) => {
			switch(error.type){
				case Syncthing.Error.DAEMON:
					Main.notifyError(_('daemon-error'),error.message);
				break;
				case Syncthing.Error.SERVICE:
					Main.notifyError(_('service-error'),error.message);
				break;
				case Syncthing.Error.STREAM:
					Main.notifyError(_('decoding-error'),error.message);
				break;
				case Syncthing.Error.CONNECTION:
					Main.notifyError(_('connection-error'),error.message);
				break;
				case Syncthing.Error.CONFIG:
					Main.notifyError(_('config-error'),error.message);
				break;
			}
		});

		extension.manager.connect(Syncthing.Signal.SERVICE_CHANGE, (manager,state) => {
			switch(state){
				case Syncthing.ServiceState.ACTIVE:
					this.defaultMenu = this.folderMenu;
					this.folderMenu.setSensitive(true)
				break;
				case Syncthing.ServiceState.STOPPED:
					this.defaultMenu = this.deviceMenu;
					this.folderMenu.setSensitive(false)
				break;
			}
		});

		extension.manager.connect(Syncthing.Signal.FOLDER_ADD, (manager,folder) => {
			this.folderMenu.setSensitive(true);
			this.folderMenu.section.addMenuItem(
				new FolderMenuItem(folder)
			);
		});

		extension.manager.connect(Syncthing.Signal.DEVICE_ADD, (manager,device) => {
			this.deviceMenu.section.addMenuItem(
				new DeviceMenuItem(device)
			);
		});

		extension.manager.connect(Syncthing.Signal.HOST_ADD, (manager,device) => {
			this.deviceMenu.setDevice(device);
			device.connect(Syncthing.Signal.STATE_CHANGE, (device,state) => {
				this.icon.setState(state);
			});
		});
	}

}
SyncthingIndicator = GObject.registerClass({GTypeName: 'SyncthingIndicator'}, SyncthingIndicator)

// Syncthing indicator extension
class SyncthingIndicatorExtension {

	constructor(){
		this.manager;
		this.indicator;
	}

	// Syncthing indicator enabler
	enable(){
		this.manager = new Syncthing.Manager();
		this.indicator = new SyncthingIndicator(this);
		Main.panel.addToStatusArea('syncthingIndicator', this.indicator);
		this.manager.attach();
	}

	// Syncthing indicator disabler
	disable(){
		this.indicator.destroy();
		this.manager.destroy();
	}

}

// Syncthing indicator extension initiator
function init(){
	ExtensionUtils.initTranslations(Me.metadata.uuid);
	return new SyncthingIndicatorExtension()
}