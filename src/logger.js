/* =============================================================================================================
	Logger 0.2
================================================================================================================

	GJS logger service

	Copyright (c) 2019, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

var Level = {
	DEBUG: 0,
	INFO: 1,
	WARN: 2,
	ERROR: 3
};

var Service = class Service {

	constructor(level, prefix) {
		this._levels = [];
		this._level = level;
		this._prefix = prefix;
		let i = 0;
		for (let name in Level) {
			this._levels[i] = name;
			i++;
		}
	}

	logCollection(level, collection) {
		if (level >= this._level) {
			let args = Array.prototype.slice.call(collection);
			args.unshift(level);
			this.log.apply(this, args);
		}
	}

	log(level) {
		if (level >= this._level) {
			let args = Array.prototype.slice.call(arguments);
			for (let i = 0; i < args.length; i++) {
				if (i == 0) {
					args[i] = '[' + this._prefix + ':' + this._levels[level] + ']';
				} else if (typeof args[i] != 'string') {
					args[i] = JSON.stringify(args[i]);
				}
			}
			log.apply(this, args);
		}
	}

	debug() {
		this.logCollection(Level.DEBUG, arguments);
	}

	info() {
		this.logCollection(Level.INFO, arguments);
	}

	warn() {
		this.logCollection(Level.WARN, arguments);
	}

	error() {
		this.logCollection(Level.ERROR, arguments);
	}

}