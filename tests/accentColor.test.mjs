import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../accentColor.js', import.meta.url), 'utf8')
    .replace(/^import.*;$/gm, '').replace(/export (?=(const|class|function)\b)/g, '');
function load(api = {}) {
    return vm.runInNewContext(`(() => { ${source}; return {ThemeAccent, resolveAccentColor, DEFAULT_ACCENT}; })()`, api);
}
const {resolveAccentColor, DEFAULT_ACCENT} = load();
const red = {red: 224, green: 27, blue: 36, alpha: 255};

test('accent follows the themed slider, explicit CSS overrides it, and missing/invalid properties fall back', () => {
    const node = properties => ({lookup_color: property => [property in properties, properties[property]]});
    assert.equal(resolveAccentColor(node({'-barlevel-active-background-color': red})), 'rgba(224, 27, 36, 1)');
    const purple = {red: 145, green: 65, blue: 172, alpha: 255};
    assert.equal(resolveAccentColor(node({'-barlevel-active-background-color': red,
        '-media-controller-accent-color': purple})), 'rgba(145, 65, 172, 1)');
    assert.equal(resolveAccentColor(node({})), DEFAULT_ACCENT);
    assert.equal(resolveAccentColor(node({'-media-controller-accent-color': {red: NaN}})), DEFAULT_ACCENT);
    assert.equal(resolveAccentColor({lookup_color() { throw Error('invalid CSS'); }}), DEFAULT_ACCENT);
});

test('theme changes refresh once per color and disabling removes the theme listener and hidden probe', () => {
    const listeners = new Map();
    let next = 0;
    const context = {connect: (_signal, cb) => { listeners.set(++next, cb); return next; },
        disconnect: id => listeners.delete(id)};
    let color = red;
    let probe;
    class Widget {
        constructor(params) { Object.assign(this, params); probe = this; }
        connect(_signal, callback) { this.styleChanged = callback; }
        get_theme_node() { return {lookup_color: key => [key.includes('barlevel'), color]}; }
        destroy() { this.destroyed = true; }
    }
    const {ThemeAccent} = load({St: {Widget, ThemeContext: {get_for_stage: () => context}},
        Main: {uiGroup: {add_child() {}}}, global: {stage: {}}});
    const colors = [];
    const accent = new ThemeAccent(value => colors.push(value));
    assert.equal(probe.visible, false);
    assert.equal(probe.reactive, false);
    assert.equal(colors.length, 1);
    probe.styleChanged();
    assert.equal(colors.length, 1);
    color = {...red, red: 53, green: 132, blue: 228};
    for (const callback of listeners.values()) callback();
    assert.equal(colors.at(-1), 'rgba(53, 132, 228, 1)');
    accent.destroy();
    assert.equal(listeners.size, 0);
    assert.equal(probe.destroyed, true);
});
