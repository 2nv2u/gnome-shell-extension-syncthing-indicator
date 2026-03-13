/* =============================================================================================================
	SyncthingManager 0.48
================================================================================================================

	GJS utils.

	Copyright (c) 2019-2025, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import GLib from "gi://GLib";
const Signals = imports.signals;

export class Timer {
  static _timers = new Set();

  static run(
    timeout,
    callback,
    recurring = false,
    priority = GLib.PRIORITY_DEFAULT,
  ) {
    return new Timer(timeout, recurring, priority).run(callback);
  }

  static destroy() {
    for (let timer of Timer._timers) timer.destroy();
    Timer._timers.clear();
  }

  constructor(
    timeout,
    recurring = false,
    priority = GLib.PRIORITY_DEFAULT_IDLE,
  ) {
    Timer._timers.add(this);
    this._timeout = timeout;
    this._recurring = recurring;
    this._priority = priority;
  }

  run(
    callback,
    timeout = this._timeout,
    recurring = this._recurring,
    priority = this._priority,
  ) {
    this.cancel();
    this._run(callback, timeout, recurring, priority);
  }

  _run(callback, timeout, recurring, priority) {
    if (this._source) {
      this._source.destroy();
    }
    this._source = GLib.timeout_source_new(timeout);
    this._source.set_priority(priority);
    this._source.set_callback(() => {
      callback();
      if (recurring) {
        this._run(callback, timeout, recurring, priority);
      } else {
        return GLib.SOURCE_REMOVE;
      }
    });
    this._source.attach(null);
  }

  cancel() {
    if (this._source) {
      this._source.destroy();
      this._source = null;
    }
  }

  destroy() {
    if (Timer._timers.has(this)) {
      Timer._timers.delete(this);
      this.cancel();
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => Timer.run(ms, resolve));
}

export class Emitter {}
Signals.addSignalMethods(Emitter.prototype);
