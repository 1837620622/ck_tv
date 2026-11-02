// 小工具：安全地创建 DOM（文字一律当作文本，不会被当成 HTML 执行）、图标、提示条。

import { ICONS } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h('div', { class: 'card', onclick: fn }, child1, 'text', [child2, child3])
 * 子元素可以是 Node、字符串、数字、数组；null/false/undefined 会被忽略。
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object')
      Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function')
      el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(
      child instanceof Node ? child : document.createTextNode(String(child))
    );
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * 清空元素，再放入新的子元素。
 * 注意：不要用 clear(el).append(...)，原生 append 会把 null 变成文字 "null"。
 * 这里和 h() 一样跳过 null、undefined、false。
 */
export function fill(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** 图标（线条风格 SVG）。名字见 icons.js */
export function icon(name, { size = 18, stroke = 2, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  // ICONS 里的内容是我们自己写的常量，不含用户数据
  svg.innerHTML = ICONS[name] || ICONS.info;
  return svg;
}

/** 底部提示条。tone: ok | err | info */
export function toast(message, tone = 'info', duration = 2600) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = h('div', {
      class: 'toast-stack',
      role: 'status',
      'aria-live': 'polite',
    });
    document.body.append(stack);
  }
  const iconName =
    tone === 'ok' ? 'checkCircle' : tone === 'err' ? 'xCircle' : 'info';
  const node = h(
    'div',
    { class: `toast ${tone}` },
    icon(iconName),
    h('span', null, message)
  );
  stack.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, duration);
  return node;
}

/** 按钮进入忙碌状态（禁用 + 文字变化），返回恢复函数 */
export function busy(button, label = '处理中…') {
  const original = button.textContent;
  const originalChildren = [...button.childNodes];
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  clear(button).append(
    icon('loader', { size: 16, className: 'spin' }),
    document.createTextNode(label)
  );
  return () => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    clear(button);
    for (const node of originalChildren) button.append(node);
    if (!originalChildren.length) button.textContent = original;
  };
}
