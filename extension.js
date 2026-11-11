import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SalatController } from './lib/controller.js';

export default class SalatPrayerTimeExtension extends Extension {
    enable() {
        this._ctrl = new SalatController(this);
        this._ctrl.enable();
    }

    disable() {
        this._ctrl.disable();
        this._ctrl = null;
    }
}
