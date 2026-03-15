/* =============================================================================================================
	SyncthingManager 0.50
================================================================================================================

	GJS utilities - Timer, Emitter, XMLParser, and i18n fallback translations.

	Copyright (c) 2019-2026, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================ */

import GLib from "gi://GLib";
import Gio from "gi://Gio";

const Signals = imports.signals;

const LOG_PREFIX = "syncthing-indicator-utils:";

// I18N class with fallback translations when gettext returns the key
export class I18N {
  #data;
  #file;
  #gettext;

  constructor(extension, gettext) {
    // Create a singleton of this class
    if (I18N._instance) return I18N._instance;
    I18N._instance = this;

    this.#gettext = gettext;
    this.#file = Gio.File.new_for_path(
      extension.path + "/locale/fallback.json",
    );
  }

  gettext(str) {
    if (!this.#data) {
      try {
        const [ok, contents] = this.#file.load_contents(null);
        if (ok) this.#data = JSON.parse(new TextDecoder().decode(contents));
      } catch (e) {
        console.error(
          LOG_PREFIX,
          "error loading fallback translations",
          e.message,
        );
      }
      this.#data = this.#data || {};
    }
    return this.#data[str] || str;
  }

  // Request key and supply key, values pairs to be replaced in the translation
  _(str, ...args) {
    let translated = this.#gettext(str);
    if (translated === str) translated = this.gettext(str);
    for (let i = 0; i < args.length; i += 2) {
      translated = translated.replace(args[i], args[i + 1]);
    }
    return translated;
  }
}

// Timer utility class
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

  #timeout;
  #recurring;
  #priority;
  #source;

  constructor(
    timeout,
    recurring = false,
    priority = GLib.PRIORITY_DEFAULT_IDLE,
  ) {
    Timer._timers.add(this);
    this.#timeout = timeout;
    this.#recurring = recurring;
    this.#priority = priority;
  }

  run(
    callback,
    timeout = this.#timeout,
    recurring = this.#recurring,
    priority = this.#priority,
  ) {
    this.cancel();
    this.#run(callback, timeout, recurring, priority);
  }

  #run(callback, timeout, recurring, priority) {
    if (this.#source) {
      this.#source.destroy();
    }
    this.#source = GLib.timeout_source_new(timeout);
    this.#source.set_priority(priority);
    this.#source.set_callback(() => {
      callback();
      if (recurring) {
        this.#run(callback, timeout, recurring, priority);
      } else {
        return GLib.SOURCE_REMOVE;
      }
    });
    this.#source.attach(null);
  }

  cancel() {
    if (this.#source) {
      this.#source.destroy();
      this.#source = null;
    }
  }

  destroy() {
    if (Timer._timers.has(this)) {
      Timer._timers.delete(this);
      this.cancel();
    }
  }
}

// Sleep utility method
export function sleep(ms) {
  return new Promise((resolve) => Timer.run(ms, resolve));
}

// Base emitter class
export class Emitter {}
Signals.addSignalMethods(Emitter.prototype);

// XML parser class
export class XMLParser {
  static ATTRIBUTE = "@attr";
  static BODY = "@body";
  static NODE = "@node";

  constructor(options = {}) {
    this.ATTR = options.attribute || XMLParser.ATTRIBUTE;
    this.BODY = options.body || XMLParser.BODY;
    this.NODE = options.node || XMLParser.NODE;
  }

  parse(xmlString) {
    const result = {};
    const stack = [result];

    const regex = /<(\/?)([\w-]+)([^>]*)(\/?)>|([^<]+)/g;
    let match;

    const { ATTR, BODY, NODE } = this;

    const processAttributes = (attrStr) => {
      const attrs = {};
      if (!attrStr) return attrs;
      const attrRegex = /([\w-]+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
        attrs[attrMatch[1]] = attrMatch[2];
      }
      return attrs;
    };

    while ((match = regex.exec(xmlString)) !== null) {
      if (match[5]) {
        const text = match[5].trim();
        if (text && stack.length > 0) {
          const current = stack[stack.length - 1];
          if (current[BODY] !== undefined) {
            current[BODY] += text;
          } else {
            current[BODY] = text;
          }
        }
      } else if (match[1] === "/") {
        const current = stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) {
          for (const key of Object.keys(parent)) {
            const val = parent[key];
            const isMatch =
              val === current || (Array.isArray(val) && val.includes(current));
            if (isMatch) {
              if (Array.isArray(val)) {
                for (let i = 0; i < val.length; i++) {
                  if (val[i] === current) {
                    if (current[BODY] && Object.keys(current).length === 1) {
                      val[i] = current[BODY];
                    } else if (
                      !current[BODY] &&
                      Object.keys(current).length === 0
                    ) {
                      val.splice(i, 1);
                      i--;
                    }
                  } else if (
                    typeof val[i] === "object" &&
                    val[i][BODY] &&
                    Object.keys(val[i]).length === 1
                  ) {
                    val[i] = val[i][BODY];
                  }
                }
                if (val.length === 1) {
                  parent[key] = val[0];
                }
              } else if (typeof val === "object" && val[ATTR] && val[NODE]) {
                if (current[BODY] && Object.keys(current).length === 1) {
                  val[NODE] = current[BODY];
                } else if (
                  !current[BODY] &&
                  Object.keys(current).length === 0
                ) {
                  delete val[NODE];
                }
              } else if (current[BODY] && Object.keys(current).length === 1) {
                parent[key] = current[BODY];
              } else if (!current[BODY] && Object.keys(current).length === 0) {
                delete parent[key];
              }
              break;
            }
          }
        }
      } else {
        const tag = match[2];
        const attrsStr = match[3];
        const selfClosing = match[4] === "/";
        const attrs = processAttributes(attrsStr);

        const parent = stack[stack.length - 1];
        const existing = parent[tag];
        const hasChildWithSameName = existing !== undefined;

        const hasAttrs = Object.keys(attrs).length > 0;
        const currentVal = parent[tag];
        const isArrayCase = Array.isArray(currentVal);
        const isAttrConflict =
          hasChildWithSameName && typeof existing === "string";
        const isTextOnlyObj =
          typeof existing === "object" &&
          existing !== null &&
          Object.keys(existing).length === 1 &&
          BODY in existing;
        const isConvertingToArray =
          hasChildWithSameName &&
          !isArrayCase &&
          typeof existing === "object" &&
          existing !== null &&
          !existing[ATTR];

        let obj;
        if (hasChildWithSameName) {
          if (isArrayCase) {
            obj = {};
            currentVal.push(obj);
          } else if (typeof existing === "string" || isTextOnlyObj) {
            const strVal =
              typeof existing === "string" ? existing : existing[BODY];
            parent[tag] = [strVal, (obj = {})];
          } else if (typeof existing === "object" && existing !== null) {
            if (existing[ATTR]) {
              parent[tag] = { [ATTR]: existing[ATTR], [NODE]: (obj = {}) };
            } else {
              parent[tag] = [existing, (obj = {})];
            }
          } else {
            parent[tag] = { [ATTR]: existing, [NODE]: (obj = {}) };
          }
        } else {
          obj = {};
        }

        if (hasAttrs) {
          if (isAttrConflict || isArrayCase || isConvertingToArray) {
            Object.assign(obj, attrs);
          } else if (hasChildWithSameName) {
            obj[ATTR] = attrs;
          } else {
            Object.assign(obj, attrs);
          }
        }

        if (!hasChildWithSameName) {
          parent[tag] = obj;
        }

        if (!selfClosing) {
          stack.push(obj);
        }
      }
    }

    return result;
  }
}
