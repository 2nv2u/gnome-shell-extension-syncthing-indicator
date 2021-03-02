/* =============================================================================================================
	SyncthingManager 0.14
================================================================================================================

	GJS syncthing systemd manager

	Copyright (c) 2019, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

const Lang = imports.lang;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const Signals = imports.signals;
const ByteArray = imports.byteArray;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const Logger = Me.imports.logger;
const console = new Logger.Service(Logger.Level.WARN,'syncthing-indicator-manager');

// Error constants
var Error = {
	DAEMON: "daemon",
	SERVICE: "service",
	STREAM: "stream",
	CONNECTION: "connection",
	CONFIG: "config"
};

// Service constants
var Service = {
	NAME: 'syncthing.service'
};

// Signal constants
var Signal = {
	ADD: "add",
	DESTROY: "destroy",
	SERVICE_CHANGE: "serviceChange",
	HOST_ADD: "hostAdd",
	FOLDER_ADD: "folderAdd",
	FOLDER_CHANGE: "folderChange",
	FOLDER_DESTROY: "folderDestroy",
	DEVICE_ADD: "deviceAdd",
	DEVICE_CHANGE: "deviceChange",
	DEVICE_DESTROY: "deviceDestroy",
	STATE_CHANGE: "stateChange",
	ERROR: "error"
};

// State constants
var State = {
	UNKNOWN: "unknown",
	IDLE: "idle",
	SCANNING: "scanning",
	SYNCING: "syncing",
	PAUSED: "paused",
	ERRONEOUS: "erroneous",
	DISCONNECTED: "disconnected"
};

// Service state constants
var ServiceState = {
	ACTIVE: "active",
	STOPPED: "stopped",
	ENABLED: "enabled",
	DISABLED: "disabled"
};

// Abstract item used for folders and devices
class Item {

	constructor(data,manager){
		this._state = State.UNKNOWN,
		this._stateEmitted = State.UNKNOWN,
		this._stateEmitDelay = 200,
		this.id = data.id;
		this.name = data.name;
		this._manager = manager;
	}

	isBusy(){
		return (this.getState() == State.SYNCING || this.getState() == State.SCANNING);
	}

	setState(state){
		if(state.length > 0 && this._state != state){
			if(this._stateSource){
				this._stateSource.destroy();
			}
			console.info('State change',this.name,state);
			this._state = state;
			// Stop items from excessive state changes by only emitting 1 state per stateDelay
			this._stateSource = GLib.timeout_source_new(this._stateEmitDelay);
			this._stateSource.set_priority(GLib.PRIORITY_DEFAULT);
			this._stateSource.set_callback(Lang.bind(this, function(){
				if(this._stateEmitted != this._state){
					console.info('Emit state change',this.name,this._state);
					this._stateEmitted = this._state;
					this.emit(Signal.STATE_CHANGE,this._state);
				}
			}));
			this._stateSource.attach(null);
		}
	}

	getState(state){
		return this._state;
	}

	destroy(){
		this.emit(Signal.DESTROY);
	}

}
Signals.addSignalMethods(Item.prototype);

// Abstract item collection used for folders and devices
class ItemCollection {

	constructor(){
		this._collection = {};
	}

	add(item){
		if(item instanceof Item){
			this._collection[item.id] = item;
			item.connect(Signal.DESTROY, Lang.bind(this, function(_item){
				delete this._collection[_item.id];
			}));
			this.emit(Signal.ADD,item);
		}
	}

	destroy(id){
		if(id){
			let item = this._collection[id];
			delete this._collection[id];
			item.destroy();
			this.emit(Signal.DESTROY,item);
		} else {
			this.foreach(Lang.bind(this, function(_item){
				this.destroy(_item.id);
			}));
		}
	}

	get(id){
		return this._collection[id];
	}

	exists(id){
		return (id in this._collection);
	}

	foreach(handler){
		for(let itemID in this._collection){
			handler(this._collection[itemID]);
		}
	}

}
Signals.addSignalMethods(ItemCollection.prototype);

// Device
class Device extends Item {

	constructor(data,manager){
		super(data,manager);
		this._determineStateDelay = 600,
		this.folders = new ItemCollection();
		this.folders.connect(Signal.ADD, Lang.bind(this, function(collection,folder){
			folder.connect(Signal.STATE_CHANGE, Lang.bind(this,this.determineStateDelayed));
		}));
	}

	isOnline(){
		return (this.getState() != State.DISCONNECTED && this.getState() != State.PAUSED);
	}

	determineStateDelayed(){
		if(this._determineSource){
			this._determineSource.destroy();
		}
		// Stop items from excessive state change calculations by only emitting 1 state per stateDelay
		this._determineSource = GLib.timeout_source_new(this._determineStateDelay);
		this._determineSource.set_priority(GLib.PRIORITY_DEFAULT);
		this._determineSource.set_callback(Lang.bind(this,this.determineState));
		this._determineSource.attach(null);
	}

	determineState(){
		if(this.isOnline()){
			this.setState(State.PAUSED);
			this.folders.foreach(Lang.bind(this, function(folder){
				if(!this.isBusy()){
					console.info('Determine device state',this.name,folder.name,folder.getState());
					this.setState(folder.getState());
				}
			}));
		}
	}

	pause(){
		this._manager.pause(this);
	}

	resume(){
		this._manager.resume(this);
	}

}
Signals.addSignalMethods(Device.prototype);

// Device host
class HostDevice extends Device {

	constructor(data,manager){
		super(data,manager);
		this._manager.connect(Signal.DEVICE_ADD, Lang.bind(this, function(manager,device){
			device.connect(Signal.STATE_CHANGE, Lang.bind(this,this.determineStateDelayed));
		}));
		this._manager.devices.foreach(Lang.bind(this, function(device){
			device.connect(Signal.STATE_CHANGE, Lang.bind(this,this.determineStateDelayed));
		}));
		this.determineState();
	}

	determineState(){
		this.setState(State.PAUSED);
		this._manager.devices.foreach(Lang.bind(this, function(device){
			if(this != device && !this.isBusy() && device.isOnline()){
				console.info('Determine host device state',this.name,device.name,device.getState());
				this.setState(device.getState());
			}
		}));
		if(!this.isBusy()){
			super.determineState();
		}
	}

}
Signals.addSignalMethods(HostDevice.prototype);

// Folder
class Folder extends Item {

	constructor(data,manager){
		super(data,manager);
		this.path = data.path;
		this.devices = new ItemCollection();
	}

	rescan(){
		this._manager.rescan(this);
	}

}
Signals.addSignalMethods(Folder.prototype);

// Folder completion proxy per device
class FolderCompletionProxy extends Folder {

	constructor(data){
		super(data.folder);
		this.name += ' ('+data.device.name+')';
		this._folder = data.folder;
		this._device = data.device;
	}

	setCompletion(percentage){
		if(percentage<100){
			this.setState(State.SYNCING);
		} else {
			this.setState(State.IDLE);
		}
	}

}
Signals.addSignalMethods(FolderCompletionProxy.prototype);

// Synthing configuration
class Config {

	constructor(){
		this._uri = '';
		this._address = '';
		this._apikey = '';
		this._secure = false;
		this._found = false;
	}

	load(){
		this._found = false;

		// Extract syncthing configuration from the default config file
		let configFile = Gio.File.new_for_path(GLib.get_user_config_dir()+'/syncthing/config.xml');
		let configInputStream = configFile.read(null);
		let configDataInputStream = Gio.DataInputStream.new(configInputStream);
		let config = configDataInputStream.read_until("", null).toString();
		configInputStream.close(null);
		let regExp = new GLib.Regex(
			'<gui.*?tls="(true|false)".*?>.*?<address>(.*?)</address>.*?<apikey>(.*?)</apikey>.*?</gui>',
			GLib.RegexCompileFlags.DOTALL,
			0
		);
		let reMatch = regExp.match(config,0);
		if(reMatch[0]){
			this._address = reMatch[1].fetch(2);
			this._apikey = reMatch[1].fetch(3);
			this._uri = 'http'+((reMatch[1].fetch(1)=='true')?'s':'')+'://'+this._address;
			this._found = true;
			console.info('Found config',this._address,this._apikey,this._uri);
		} else {
			throw('Can\'t find gui xml node in config');
		}
	}

	setService(force=false){
		// (Force) Copy systemd config file to systemd's configuration directory (if it doesn't exist)
		let systemdConfigPath = GLib.get_user_config_dir()+'/systemd/user';
		let systemDConfigFileTo = Gio.File.new_for_path(systemdConfigPath+'/'+Service.NAME);
		if(force || !systemDConfigFileTo.query_exists(null)){
			let systemDConfigFileFrom = Gio.File.new_for_path(Me.path+'/'+Service.NAME);
			let systemdConfigDirectory = Gio.File.new_for_path(systemdConfigPath);
			if(!systemdConfigDirectory.query_exists(null)){
				systemdConfigDirectory.make_directory_with_parents(null);
			}
			let copyFlag = Gio.FileCopyFlags.NONE;
			if(force) copyFlag = Gio.FileCopyFlags.OVERWRITE;
			if(systemDConfigFileFrom.copy(systemDConfigFileTo,copyFlag,null,null)){
				console.info('Systemd configuration file copied to '+systemdConfigPath+'/'+Service.NAME);
			} else {
				console.warn('Couldn\'t copy systemd configuration file to '+systemdConfigPath+'/'+Service.NAME);
			}
		};
	}

	found(){
		return this._found;
	}

	getAPIKey(){
		return this._apikey;
	}

	getURI(){
		return this._uri;
	}

}

// Main system manager
class Manager {

	constructor(){
		this.folders = new ItemCollection();
		this.devices = new ItemCollection();

		this.folders.connect(Signal.ADD, Lang.bind(this, function(collection,folder){
			this.emit(Signal.FOLDER_ADD,folder);
		}));

		this.devices.connect(Signal.ADD, Lang.bind(this, function(collection,device){
			if(device instanceof HostDevice){
				this.host = device;
				this.emit(Signal.HOST_ADD,this.host);
			} else {
				this.emit(Signal.DEVICE_ADD,device);
			}
		}));

		this._httpSession = new Soup.Session();
		this._httpSession.ssl_strict = false; // Accept self signed certificates for now
		this._httpAborting = false;
		this._serviceActive = false;
		this._serviceEnabled = false;
		this._config = new Config();
		this._pollTime = 20000;
		this._pollCount = 0;
		this._pollConnectionHook = 6; // Every 2 minutes
		this._pollConfigHook = 45; // Every 15 minutes
		this._lastEventID = 1;
		this._apiKey = '';
		this._hostID = '';
		this._lastErrorTime = Date.now()

		this.connect(Signal.SERVICE_CHANGE, Lang.bind(this, function(manager,state){
			switch(state){
				case ServiceState.ACTIVE:
					this.openConnection('GET','/rest/system/status',Lang.bind(this, function(status){
						this._hostID = status.myID;
						this._callConfig(Lang.bind(this, function(config){
							this._callEvents('limit=1');
						}));
					}));
				break;
			}
		}));

	}

	_callConfig(handler){
		this.openConnection('GET','/rest/system/config',Lang.bind(this, function(config){
			this._processConfig(config);
			if(handler) handler(config);
		}));
	}

	_callEvents(options){
		this.openConnection('GET','/rest/events?'+options,Lang.bind(this, function(events){
			for(let i=0;i<events.length;i++){
				console.debug('Processing event',events[i].type,events[i].data);
				try {
					switch(events[i].type){
						case "ConfigSaved":
							this._config.load();
							this._processConfig(events[i].data);
						break;
						case "FolderErrors":
							if(this.folders.exists(events[i].data.folder)){
								this.folders.get(events[i].data.folder).setState(State.ERRONEOUS);
							}
						break;
						case "FolderCompletion":
							if(this.folders.exists(events[i].data.folder) && this.devices.exists(events[i].data.device)){
								let device = this.devices.get(events[i].data.device);
								if(device.folders.exists(events[i].data.folder)){
									if(!device.isOnline()) device.setState(State.SCANNING);
									device.folders.get(events[i].data.folder).setCompletion(events[i].data.completion);
								}
							}
						break;
						case "FolderSummary":
							if(this.folders.exists(events[i].data.folder)){
								this.folders.get(events[i].data.folder).setState(events[i].data.summary.state);
							}
						break;
						case "FolderPaused":
							if(this.folders.exists(events[i].data.id)){
								this.folders.get(events[i].data.id).setState(State.PAUSED);
							}
						break;
						case "StateChanged":
							if(this.folders.exists(events[i].data.folder)){
								this.folders.get(events[i].data.folder).setState(events[i].data.to);
							}
						break;
						case "DeviceResumed":
							if(this.devices.exists(events[i].data.device)){
								this.devices.get(events[i].data.device).setState(State.DISCONNECTED);
							}
						break;
						case "DevicePaused":
							if(this.devices.exists(events[i].data.device)){
								this.devices.get(events[i].data.device).setState(State.PAUSED);
							}
						break;
						case "DeviceConnected":
							if(this.devices.exists(events[i].data.id)){
								this.devices.get(events[i].data.id).setState(State.IDLE);
							}
						break;
						case "DeviceDisconnected":
							if(this.devices.exists(events[i].data.id)){
								this.devices.get(events[i].data.id).setState(State.DISCONNECTED);
							}
						break;
					}
					this._lastEventID = events[i].id;
				} catch(error){
					console.warn('Event processing failed',error.message);
				}
			}
			// Reschedule this event stream
			let source = GLib.timeout_source_new(50);
			source.set_priority(GLib.PRIORITY_LOW);
			source.set_callback(Lang.bind(this, function(){
				this._callEvents('since='+this._lastEventID);
			}));
			source.attach(null);
		}));
	}

	_callConnections(){
		this.openConnection('GET','/rest/system/connections',Lang.bind(this, function(data){
			let devices = data.connections;
			for(let deviceID in devices){
				if(this.devices.exists(deviceID) && deviceID != this._hostID){
					if(devices[deviceID].connected){
						this.devices.get(deviceID).setState(State.IDLE);
					} else if(devices[deviceID].paused){
						this.devices.get(deviceID).setState(State.PAUSED);
					} else {
						this.devices.get(deviceID).setState(State.DISCONNECTED);
					}
				}
			}
		}));
	}

	_processConfig(config){
		// Only include devices which shares folders with this host
		let usedDevices = {};
		for(let i=0;i<config.folders.length;i++){
			if(!this.folders.exists(config.folders[i].id)){
				let name = config.folders[i].label;
				if(name.length == 0) name = config.folders[i].id;
				let folder = new Folder({
					id: config.folders[i].id,
					name: name,
					path: config.folders[i].path
				},this);
				this.folders.add(folder);
			}
			if(config.folders[i].paused){
				this.folders.get(config.folders[i].id).setState(State.PAUSED);
		} else {
			this.openConnection('GET','/rest/db/status?folder='+config.folders[i].id,Lang.bind(this, function(folderID){
				return function(data){
					this.folders.get(folderID).setState(data.state);
				}
			}(config.folders[i].id)));
		}
			for(let j=0;j<config.folders[i].devices.length;j++){
				if(!(config.folders[i].devices[j].deviceID in usedDevices)){
					usedDevices[config.folders[i].devices[j].deviceID] = [];
				}
				usedDevices[config.folders[i].devices[j].deviceID].push(
					this.folders.get(config.folders[i].id)
				);
			}
		}
		// TODO: remove / update old devices & folders, current destroy is way to invasive
		for(let i=0;i<config.devices.length;i++){
			if(config.devices[i].deviceID in usedDevices && !this.devices.exists(config.devices[i].deviceID)){
				let device;
				if(this._hostID == config.devices[i].deviceID){
					device = new HostDevice({
						id: config.devices[i].deviceID,
						name: config.devices[i].name
					},this);
				} else {
					device = new Device({
						id: config.devices[i].deviceID,
						name: config.devices[i].name
					},this);
				}
				this.devices.add(device);
				for(let j=0;j<usedDevices[config.devices[i].deviceID].length;j++){
					let folder = usedDevices[config.devices[i].deviceID][j];
					if(device != this.host){
						folder = new FolderCompletionProxy({
							folder: folder,
							device: device
						});
						this.openConnection('GET','/rest/db/completion?folder='+folder.id+'&device='+device.id,
							Lang.bind(this, function(proxy){
								return function(data){
									proxy.setCompletion(data.completion);
								}
							}(folder))
						);
					}
					device.folders.add(folder);
				}
			}
		}
		this._callConnections();
	}

	_callState(){
		if(this._pollSource){
			this._pollSource.destroy();
		}
		if(this._isServiceActive() && this._config.found()){
			if(this._pollCount % this._pollConfigHook == 0){
				// TODO: this should not be necessary, we should remove old items
				this.folders.destroy();
				this.devices.destroy();
				this._callConfig();
			}
			if(this._pollCount % this._pollConnectionHook == 0){
				this._isServiceEnabled();
				this._callConnections();
			}
			this.openConnection('GET','/rest/system/error',Lang.bind(this, function(data){
				let errorTime;
				let errors = data.errors;
				if(errors != null){
					for(let i=0;i<errors.length;i++){
						errorTime = new Date(errors[i].when)
						if(errorTime > this._lastErrorTime){
							this._lastErrorTime = errorTime;
							console.error('Syncthing error',errors[i]);
							this.emit(Signal.ERROR,{
								type: Error.SERVICE,
								message: errors[i].message
							});
						}
					}
				}
			}));
		} else {
			this._isServiceEnabled();
		}
		this._pollSource = GLib.timeout_source_new(this._pollTime);
		this._pollSource.set_priority(GLib.PRIORITY_LOW);
		this._pollSource.set_callback(Lang.bind(this, this._callState));
		this._pollSource.attach(null);
		this._pollCount++;
	}

	_isServiceActive(){
		let state = this._serviceCommand('is-active');
		let active = (state == 'active');
		if(state == 'failed'){
			console.error('Service failed to start ['+Service.NAME+']');
			this.emit(Signal.ERROR,{
				type: Error.DAEMON,
				message: 'service failed to start'
			});
		} else if(active != this._serviceActive){
			this._serviceActive = active;
			this.emit(Signal.SERVICE_CHANGE,(active ? ServiceState.ACTIVE : ServiceState.STOPPED));
			if(this.host) this.host.setState(active ? State.IDLE : State.DISCONNECTED);
		}
		return active;
	}

	_isServiceEnabled(){
		let enabled = (this._serviceCommand('is-enabled') == 'enabled');
		if(enabled != this._serviceEnabled){
			this._serviceEnabled = enabled;
			this.emit(Signal.SERVICE_CHANGE,(enabled ? ServiceState.ENABLED : ServiceState.DISABLED));
		}
		return enabled;
	}

	_serviceCommand(command){
		let argv = 'systemctl --user '+command+' '+Service.NAME;
		let result = GLib.spawn_sync(null, argv.split(' '), null, GLib.SpawnFlags.SEARCH_PATH, null)[1];
		return ByteArray.toString(result).trim();
	}

	abortConnections(){
		this._httpAborting = true;
		this._httpSession.abort();
	}

	openConnection(method,uri,callback){
		if(this._config.found()){
			let msg = Soup.Message.new(method,this._config.getURI()+uri);
			msg.request_headers.append('X-API-Key',this._config.getAPIKey());
			this.openConnectionMessage(msg,callback);
		}
	}

	openConnectionMessage(msg,callback){
		if(this._serviceActive && this._config.found()){
			console.debug('Opening connection',msg.method+':'+msg.uri.get_path());
			this._httpAborting = false;
			this._httpSession.queue_message(msg, Lang.bind(this, function(session,msg){
				if(msg.status_code == 200){
					try {
						if(callback && msg.response_body.data.length>0){
							console.debug('Callback',msg.method+':'+msg.uri.get_path(),msg.response_body.data);
							callback(JSON.parse(msg.response_body.data));
						}
					} catch(error){
						console.error('Stream / parsing error',msg.method+':'+msg.uri.get_path(),error.message,msg.response_body.data);
						this.emit(Signal.ERROR,{
							type: Error.STREAM,
							message: 'stream / parsing error: '+msg.method+':'+msg.uri.get_path()
						});
					}
				} else if(!this._httpAborting){
					if(msg.status_code < 100){
						console.warn(msg.reason_phrase,'will retry',msg.method+':'+msg.uri.get_path(),msg.status_code);
						// Retry this connection attempt
						let source = GLib.timeout_source_new(1000);
						source.set_priority(GLib.PRIORITY_LOW);
						source.set_callback(Lang.bind(this, function(){
								this.openConnectionMessage(msg,callback);
						}));
						source.attach(null);
					} else {
						console.error(msg.reason_phrase,msg.method+':'+msg.uri.get_path(),msg.status_code,msg.response_body.data);
						this.emit(Signal.ERROR,{
							type: Error.CONNECTION,
							message: msg.reason_phrase+' - '+msg.method+':'+msg.uri.get_path()
						});
					}
				}
			}));
		}
	}

	destroy(){
		if(this._pollSource){
			this._pollSource.destroy();
		}
		if(this._stateSource){
			this._stateSource.destroy();
		}
		this.folders.destroy();
		this.devices.destroy();
	}

	attach(){
		try {
			this._config.load();
		} catch(error){
			console.error('Could not open / find config',error);
			this.emit(Signal.ERROR,{
				type: Error.CONFIG,
				message: 'could not open / find config: '+error
			});
		}
		return this._callState();
	}

	reset(){
		this.abortConnections();
		this.destroy();
		this._lastEventID = 1;
		this._pollCount = 0;
		this._callConfig(Lang.bind(this, function(config){
			this._callEvents('limit=1');
		}));
	}

	enableService(){
		this._config.setService(true);
		this._serviceCommand('enable');
		this._isServiceEnabled();
	}

	disableService(){
		this._serviceCommand('disable');
		this._isServiceEnabled();
	}

	startService(){
		this._config.setService();
		this._serviceCommand('start');
	}

	stopService(){
		this._serviceCommand('stop');
		if(!this._isServiceActive()){
			this.folders.destroy();
			this.devices.destroy();
		}
	}

	rescan(folder){
		if(folder){
			this.openConnection('POST','/rest/db/scan?folder='+folder.id);
		} else {
			this.openConnection('POST','/rest/db/scan');
		}
	}

	resume(device){
		if(device){
			this.openConnection('POST','/rest/system/resume?device='+device.id);
		}
	}

	pause(device){
		if(device){
			this.openConnection('POST','/rest/system/pause?device='+device.id);
		}
	}

	getConfig(){
		return this._config;
	}

}
Signals.addSignalMethods(Manager.prototype);
