/**
 * applyProps の分岐に対する回帰テスト。
 *
 * 実装当初、attrs 分岐の内側 if に else が結合してしまい（dangling else）、
 * id / type / checked / value / width などの「プロパティ指定」が
 * すべて黙って無視される不具合があった。UI 全体に影響するため分岐を固定する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProps } from '../src/ui/dom.js';

/** `in` 演算子と setAttribute を忠実に再現する最小の要素スタブ */
class FakeElement {
  constructor(known = {}) {
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = [];
    Object.assign(this, known);
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  addEventListener(type, fn) {
    this.listeners.push([type, fn]);
  }
}

test('要素のプロパティ（id / type / checked）が適用される', () => {
  const el = new FakeElement({ id: '', type: 'text', checked: false });
  applyProps(el, { type: 'checkbox', checked: true, id: 'auto-sub' });
  assert.equal(el.type, 'checkbox');
  assert.equal(el.checked, true);
  assert.equal(el.id, 'auto-sub');
  assert.equal(el.attributes.size, 0, 'プロパティは属性経由にならない');
});

test('canvas の width / height が適用される', () => {
  const el = new FakeElement({ width: 300, height: 150 });
  applyProps(el, { width: 1280, height: 720 });
  assert.equal(el.width, 1280);
  assert.equal(el.height, 720);
});

test('attrs は属性として設定され、後続の分岐を壊さない', () => {
  const el = new FakeElement({ id: '', value: '' });
  applyProps(el, { attrs: { 'aria-label': 'ラベル', role: 'listitem' }, id: 'x', value: '入力値' });
  assert.equal(el.attributes.get('aria-label'), 'ラベル');
  assert.equal(el.attributes.get('role'), 'listitem');
  assert.equal(el.id, 'x', 'attrs の後ろのプロパティ指定が無視されている');
  assert.equal(el.value, '入力値');
});

test('attrs の null / undefined は無視される', () => {
  const el = new FakeElement();
  applyProps(el, { attrs: { a: null, b: undefined, c: 0 } });
  assert.equal(el.attributes.has('a'), false);
  assert.equal(el.attributes.has('b'), false);
  assert.equal(el.attributes.get('c'), '0');
});

test('未知のキーは属性として設定される', () => {
  const el = new FakeElement();
  applyProps(el, { tabindex: '-1', accept: '.srt' });
  assert.equal(el.attributes.get('tabindex'), '-1');
  assert.equal(el.attributes.get('accept'), '.srt');
});

test('class / text / style / dataset / on が適用される', () => {
  const el = new FakeElement();
  el.className = 'base';
  const handler = () => {};
  applyProps(el, {
    class: 'extra',
    text: 'こんにちは',
    style: { color: 'red' },
    dataset: { cueId: 'c1' },
    on: { click: handler, keydown: handler },
  });
  assert.equal(el.className, 'base extra');
  assert.equal(el.textContent, 'こんにちは');
  assert.equal(el.style.color, 'red');
  assert.equal(el.dataset.cueId, 'c1');
  assert.equal(el.listeners.length, 2);
  assert.equal(el.listeners[0][0], 'click');
});

test('null / undefined の値はスキップされる', () => {
  const el = new FakeElement({ id: 'keep' });
  applyProps(el, { id: null, text: undefined });
  assert.equal(el.id, 'keep');
  assert.equal(el.textContent, '');
});

test('props が未指定でも例外にならない', () => {
  const el = new FakeElement();
  assert.doesNotThrow(() => applyProps(el, null));
  assert.doesNotThrow(() => applyProps(el, undefined));
});
