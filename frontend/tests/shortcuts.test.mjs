import assert from 'node:assert/strict';
import test from 'node:test';
import { matchShortcut } from '../src/shortcuts.ts';

const key = (key, modifiers = {}) => matchShortcut({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...modifiers })?.id;

test('project commands support both primary modifiers and exact Shift variants', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.equal(key('s', { [modifier]: true }), 'save');
    assert.equal(key('S', { [modifier]: true, shiftKey: true }), 'save-as');
    assert.equal(key('z', { [modifier]: true }), 'undo');
    assert.equal(key('Z', { [modifier]: true, shiftKey: true }), 'redo');
  }
});

test('modified letters cannot accidentally start playback or drawing', () => {
  for (const letter of [' ', 'j', 'k', 'l', '1', 'r', 'f']) {
    assert.equal(key(letter, { ctrlKey: true }), undefined);
    assert.equal(key(letter, { metaKey: true }), undefined);
  }
  assert.equal(key('1', { altKey: true }), 'focus-library');
  assert.equal(key('2', { altKey: true }), 'focus-viewer');
  assert.equal(key('¡', { altKey: true, code: 'Digit1' }), 'focus-library');
  assert.equal(key('3', { shiftKey: true }), undefined);
});

test('holding a key repeats only continuous navigation commands', () => {
  assert.equal(key('ArrowRight', { repeat: true }), 'ArrowRight');
  assert.equal(key('ArrowLeft', { repeat: true, shiftKey: true }), 'ArrowLeft');
  assert.equal(key('=', { repeat: true }), 'zoom-in');
  for (const letter of [' ', 'r', 's', 'm', 'Delete', 'f']) assert.equal(key(letter, { repeat: true }), undefined);
  assert.equal(key('d', { ctrlKey: true, repeat: true }), undefined);
});

test('IME and AltGr events never invoke commands', () => {
  assert.equal(key('s', { ctrlKey: true, isComposing: true }), undefined);
  assert.equal(key('s', { ctrlKey: true, altKey: true }), undefined);
});

test('viewer commands and keyboard layouts match correctly', () => {
  assert.equal(key('f'), 'viewer-maximize');
  assert.equal(key('F', { shiftKey: true }), 'viewer-selection');
  assert.equal(key('+', { shiftKey: true }), 'zoom-in');
  assert.equal(key('+'), 'zoom-in');
  assert.equal(key('?', { shiftKey: true }), 'help');
  assert.equal(key('F1'), 'help');
});
