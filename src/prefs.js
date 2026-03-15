/* =============================================================================================================
	SyncthingIndicator 0.50
================================================================================================================

	Preferences window - extension settings and configuration.

	Copyright (c) 2019-2026, 2nv2u <info@2nv2u.com>
	This work is distributed under GPLv3, see LICENSE for more information.
============================================================================================================= */

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import {
  ExtensionPreferences,
  gettext,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import * as Utils from "./utils.js";
import Config from "./config.js";

export default class SyncthingIndicatorExtensionPreferences extends ExtensionPreferences {
  // Fill preferences window with settings
  fillPreferencesWindow(window) {
    this._window = window;
    this._i18n = new Utils.I18N(this, gettext);

    const iconTheme = Gtk.IconTheme.get_for_display(window.get_display());
    const iconsDirectory = this.dir.get_child("icons").get_path();
    iconTheme.add_search_path(iconsDirectory);

    this._general();
  }

  _general() {
    const page = new Adw.PreferencesPage();
    this._window.add(page);

    // About button
    const aboutButton = new Gtk.Button({
      child: new Adw.ButtonContent({
        icon_name: "help-about-symbolic",
      }),
    });
    // Fragile Adw vfunc traversal - revisit when Adw provides proper API
    // TODO: Revisit
    const pagesStack = page.get_parent(); // AdwViewStack
    const contentStack = pagesStack.get_parent().get_parent(); // GtkStack
    const preferences = contentStack.get_parent(); // GtkBox
    const headerBar = preferences
      .get_first_child()
      .get_next_sibling()
      .get_first_child()
      .get_first_child()
      .get_first_child(); // AdwHeaderBar
    headerBar.pack_start(aboutButton);
    aboutButton.connect("clicked", () => {
      this.showAbout();
    });

    const settings = this.getSettings("org.gnome.shell.extensions.syncthing");
    const config = new Config(settings, true);

    // Settings group
    const settingsGroup = new Adw.PreferencesGroup({
      title: this._i18n._("settings-group-title"),
      description: this._i18n._("settings-group-description"),
    });
    page.add(settingsGroup);

    // Menu type model
    const menuTypesModel = new Gtk.StringList();
    menuTypesModel.append(this._i18n._("quick-settings"));
    menuTypesModel.append(this._i18n._("main-panel"));

    // Menu type combo selector
    const typeCombo = new Adw.ComboRow({
      title: this._i18n._("menu-type-title"),
      subtitle: this._i18n._("menu-type-subtitle"),
      model: menuTypesModel,
    });
    settings.bind("menu", typeCombo, "selected", Gio.SettingsBindFlags.DEFAULT);
    settingsGroup.add(typeCombo);

    // Icon state switch
    const iconStateSwitch = new Adw.SwitchRow({
      title: this._i18n._("icon-state-title"),
      subtitle: this._i18n._("icon-state-subtitle"),
    });
    settings.bind(
      "icon-state",
      iconStateSwitch,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settingsGroup.add(iconStateSwitch);

    // Settings button switch
    const settingsButtonSwitch = new Adw.SwitchRow({
      title: this._i18n._("setting-button-title"),
      subtitle: this._i18n._("setting-button-subtitle"),
    });
    settings.bind(
      "settings-button",
      settingsButtonSwitch,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settingsGroup.add(settingsButtonSwitch);

    // Settings button switch
    const useSysDItemSwitch = new Adw.SwitchRow({
      title: this._i18n._("use-sysd-item"),
      subtitle: this._i18n._("use-sysd-item-subtitle"),
    });
    settings.bind(
      "use-systemd",
      useSysDItemSwitch,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settingsGroup.add(useSysDItemSwitch);

    // Settings button switch
    const autoStartItemSwitch = new Adw.SwitchRow({
      title: this._i18n._("auto-start-item"),
      subtitle: this._i18n._("auto-start-item-subtitle"),
    });
    settings.bind(
      "use-systemd",
      autoStartItemSwitch,
      "visible",
      Gio.SettingsBindFlags.BOOLEAN,
    );
    settings.bind(
      "auto-start",
      autoStartItemSwitch,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    settingsGroup.add(autoStartItemSwitch);

    // Automatic configuration group
    const autoGroup = new Adw.PreferencesGroup({
      title: this._i18n._("auto-config-group-title"),
      description: this._i18n._("auto-config-group-description"),
    });
    page.add(autoGroup);

    // Automatic configuration switch
    const autoConfigSwitch = new Adw.SwitchRow({
      title: this._i18n._("auto-config-title"),
      subtitle: this._i18n._("auto-config-subtitle"),
    });
    settings.bind(
      "auto-config",
      autoConfigSwitch,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    autoGroup.add(autoConfigSwitch);

    // Config file view
    const configFileView = new Adw.ActionRow({
      title: this._i18n._("config-file-title"),
      subtitle: this._i18n._("unknown"),
    });
    settings.bind(
      "auto-config",
      configFileView,
      "visible",
      Gio.SettingsBindFlags.DEFAULT,
    );
    autoGroup.add(configFileView);

    // Service URI & port view
    const serviceAddressView = new Adw.ActionRow({
      title: this._i18n._("service-uri-title"),
      subtitle: this._i18n._("unknown"),
    });
    settings.bind(
      "auto-config",
      serviceAddressView,
      "visible",
      Gio.SettingsBindFlags.DEFAULT,
    );
    autoGroup.add(serviceAddressView);

    // API key view
    const apiKeyView = new Adw.ActionRow({
      title: this._i18n._("api-key-title"),
      subtitle: this._i18n._("unknown"),
    });
    settings.bind(
      "auto-config",
      apiKeyView,
      "visible",
      Gio.SettingsBindFlags.DEFAULT,
    );
    autoGroup.add(apiKeyView);

    // Load config and set fields
    config
      .load()
      .then(() => {
        configFileView.subtitle =
          config.filePath != null
            ? config.filePath.path
            : this._i18n._("unknown");
        serviceAddressView.subtitle =
          config.fileURI != null ? config.fileURI : this._i18n._("unknown");
        apiKeyView.subtitle =
          config.fileApiKey != null
            ? config.fileApiKey
            : this._i18n._("unknown");
      })
      .catch((error) => {
        console.log(error);
      });

    // Service URI & port entry
    const serviceAddressEntry = new Adw.EntryRow({
      title: this._i18n._("service-uri-title"),
      tooltip_text: this._i18n._("service-uri-tooltip"),
      show_apply_button: true,
    });
    settings.bind(
      "auto-config",
      serviceAddressEntry,
      "visible",
      Gio.SettingsBindFlags.INVERT_BOOLEAN,
    );
    settings.bind(
      "service-uri",
      serviceAddressEntry,
      "text",
      Gio.SettingsBindFlags.DEFAULT,
    );
    autoGroup.add(serviceAddressEntry);

    // API key entry
    const apiKeyEntry = new Adw.EntryRow({
      title: this._i18n._("api-key-title"),
      tooltip_text: this._i18n._("api-key-tooltip"),
      show_apply_button: true,
    });
    settings.bind(
      "auto-config",
      apiKeyEntry,
      "visible",
      Gio.SettingsBindFlags.INVERT_BOOLEAN,
    );
    settings.bind(
      "api-key",
      apiKeyEntry,
      "text",
      Gio.SettingsBindFlags.DEFAULT,
    );
    autoGroup.add(apiKeyEntry);
  }

  showAbout() {
    const about_window = new Adw.AboutWindow({
      transient_for: this._window,
      modal: true,
    });
    about_window.set_application_icon("syncthing-indicator");
    about_window.set_application_name(this._i18n._("syncthing-indicator"));
    about_window.set_version(`${this.metadata.version}`);
    about_window.set_developer_name("2nv2u");
    about_window.set_issue_url(this.metadata.url + "/issues");
    about_window.set_website(this.metadata.url);
    about_window.set_license_type(Gtk.License.GPL_3_0);
    about_window.set_copyright(this._i18n._("copyright") + " © 2026 2nv2u");
    about_window.show();
  }
}
