// content/detect.js — 运行在 MAIN world
// 自动覆盖 confirm/alert，通过 DOM 属性与 ISOLATED world 通信

window._originalConfirm = window.confirm;
window._originalAlert = window.alert;

window.confirm = function(msg) {
  document.body.setAttribute('data-cx-confirm', String(msg || ''));
  return true;
};

window.alert = function(msg) {
  document.body.setAttribute('data-cx-alert', String(msg || ''));
};
