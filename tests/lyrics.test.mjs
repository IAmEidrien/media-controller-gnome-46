import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function fixture() {
    const lifecycle = [];
    const source = readFileSync(new URL('../lyrics.js', import.meta.url), 'utf8')
        .replace(/^import .*;$/gm, '').replace(/export /g, '');
    const {parseLyrics, LyricsSource} = vm.runInNewContext(
        `(() => {${source}; return {parseLyrics, LyricsSource};})()`, {
            TextDecoder,
            Gio: {Cancellable: class {cancel() { lifecycle.push('cancel'); }}},
            Soup: {Session: class {abort() { lifecycle.push('abort'); }}},
        });
    return {parseLyrics, source: new LyricsSource('test'), lifecycle};
}

test('LRC timing, offsets, translations and plain verse breaks survive parsing', () => {
    const {parseLyrics} = fixture();
    const lyrics = parseLyrics('[ar:Artist]\n[offset:100]\n[00:01.25]Hello\n[00:01.25]Translation\n[00:02][00:03]<00:02.50>World');
    assert.equal(lyrics.synced, true);
    assert.deepEqual(JSON.parse(JSON.stringify(lyrics.lines)), [
        {time: 1150000, text: 'Hello\nTranslation'},
        {time: 1900000, text: 'World'}, {time: 2900000, text: 'World'},
    ]);
    const plain = parseLyrics('\n[Chorus: Someone]\nWords\n\n\nNext\n');
    assert.equal(plain.synced, false);
    assert.deepEqual(Array.from(plain.lines, line => line.text),
        ['[Chorus: Someone]', 'Words', '', 'Next']);
    assert.equal(parseLyrics('[ar:Artist]\n[00:00]'), null);
});

test('online lookup stays opt-in and timed player lyrics never contact LRCLIB', async () => {
    const {source, lifecycle} = fixture();
    let requests = 0;
    source._request = async () => { requests++; return null; };
    const track = {title: 'Song', artists: ['Artist'], album: '', length: 10e6,
        url: '', lyrics: 'Local words'};
    assert.equal((await source.lookup(track, false)).lines[0].text, 'Local words');
    assert.equal(requests, 0);
    assert.equal((await source.lookup({...track, lyrics: '[00:01]Timed'}, true)).synced, true);
    assert.equal(requests, 0);
    await source.lookup({...track, lyrics: ''}, true);
    assert.equal(requests, 2);
    source.destroy();
    assert.deepEqual(lifecycle, ['cancel', 'abort']);
});

test('lookup coalesces requests and rejects mismatched timing while preserving local fallback', async () => {
    const {source} = fixture();
    let requests = 0;
    source._request = async () => {
        requests++;
        return {duration: 100, syncedLyrics: '[00:01]Wrong timing', plainLyrics: 'Right words'};
    };
    const track = {title: 'Song', artists: ['Artist'], album: '', length: 10e6, url: '', lyrics: ''};
    const [first, second] = await Promise.all([source.lookup(track, true), source.lookup(track, true)]);
    assert.equal(requests, 2);
    assert.equal(first, second);
    assert.equal(first.synced, false);
    assert.equal(first.lines[0].text, 'Right words');
    await source.lookup(track, true);
    assert.equal(requests, 2, 'successful results are cached');
    source._request = async () => { throw Error('offline'); };
    const local = await source.lookup({...track, title: 'Other', lyrics: 'Local fallback'}, true);
    assert.equal(local.lines[0].text, 'Local fallback');
    await assert.rejects(source.lookup({...track, title: 'Missing'}, true), /offline/);
});

test('plain exact-match lyrics do not prevent a timed search result', async () => {
    const {source} = fixture();
    let requests = 0;
    source._request = async () => ++requests === 1
        ? {duration: 10, plainLyrics: 'Plain words'}
        : [{duration: 10, syncedLyrics: '[00:01]Timed words'}];
    const lyrics = await source.lookup({title: 'Song', artists: ['Artist'],
        album: '', length: 10e6, url: '', lyrics: ''}, true);
    assert.equal(requests, 2);
    assert.equal(lyrics.synced, true);
    assert.equal(lyrics.lines[0].text, 'Timed words');
    source.destroy();
});
