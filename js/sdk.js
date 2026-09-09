// Обёртка над SDK Яндекс Игр. Локально (без /sdk.js) — mock-режим:
// реклама рисуется заглушкой, сохранения идут в localStorage.

const LS_KEY = 'neshumi_save_v1';

export const SDK = {
  ysdk: null,
  player: null,
  mock: true,

  _pauseCb: null,
  _resumeCb: null,

  async init() {
    try {
      if (window.YaGames) {
        this.ysdk = await window.YaGames.init();
        this.mock = false;
        // гостевой вход: scopes:false — без запроса авторизации,
        // прогресс всё равно сохраняется
        try { this.player = await this.ysdk.getPlayer({ scopes: false }); } catch (e) { this.player = null; }
      }
    } catch (e) {
      console.warn('SDK init failed, mock mode', e);
    }
  },

  // Обязательно по требованиям Яндекса: платформа сама шлёт эти события,
  // когда игру надо остановить (свернули вкладку, открыли оверлей и т.п.).
  onPauseResume(onPause, onResume) {
    this._pauseCb = onPause;
    this._resumeCb = onResume;
    if (!this.ysdk || !this.ysdk.on) return;
    try {
      this.ysdk.on('game_api_pause', onPause);
      this.ysdk.on('game_api_resume', onResume);
    } catch (e) {}
  },

  offPauseResume() {
    if (!this.ysdk || !this.ysdk.off) return;
    try {
      if (this._pauseCb) this.ysdk.off('game_api_pause', this._pauseCb);
      if (this._resumeCb) this.ysdk.off('game_api_resume', this._resumeCb);
    } catch (e) {}
    this._pauseCb = this._resumeCb = null;
  },

  ready() {
    try { this.ysdk?.features?.LoadingAPI?.ready(); } catch (e) {}
  },
  gameplayStart() {
    try { this.ysdk?.features?.GameplayAPI?.start(); } catch (e) {}
  },
  gameplayStop() {
    try { this.ysdk?.features?.GameplayAPI?.stop(); } catch (e) {}
  },

  // --- сохранения ----------------------------------------------------------
  async load() {
    let local = null;
    try { local = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) {}
    if (this.player) {
      try {
        const cloud = await this.player.getData();
        if (cloud && cloud.night && (!local || (cloud.totalRuns || 0) >= (local.totalRuns || 0))) return cloud;
      } catch (e) {}
    }
    return local;
  },

  save(data) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) {}
    if (this.player) {
      try { this.player.setData(data); } catch (e) {}
    }
  },

  // баннер: показываем только в меню
  showBanner() {
    try { this.ysdk?.adv?.showBannerAdv?.(); } catch (e) {}
  },
  hideBanner() {
    try { this.ysdk?.adv?.hideBannerAdv?.(); } catch (e) {}
  },

  // --- реклама ---------------------------------------------------------------
  // На время показа рекламы Яндекс требует глушить звук и останавливать
  // геймплей. Колбэки ставит main.js через setAdHooks.
  _onAdOpen: null,
  _onAdClose: null,
  setAdHooks(onOpen, onClose) { this._onAdOpen = onOpen; this._onAdClose = onClose; },
  _adOpen() { try { this._onAdOpen && this._onAdOpen(); } catch (e) {} },
  _adClose() { try { this._onAdClose && this._onAdClose(); } catch (e) {} },

  // onClose(wasShown); в mock-режиме показывается заглушка
  showInterstitial(onClose) {
    const done = wasShown => { this._adClose(); onClose(wasShown); };
    this._adOpen();
    if (!this.mock && this.ysdk) {
      try {
        this.ysdk.adv.showFullscreenAdv({
          callbacks: {
            onClose: wasShown => done(wasShown),
            onError: () => done(false),
          },
        });
        return;
      } catch (e) { done(false); return; }
    }
    mockAd(2, () => done(true));
  },

  // onDone(rewarded)
  showRewarded(onDone) {
    const done = r => { this._adClose(); onDone(r); };
    this._adOpen();
    if (!this.mock && this.ysdk) {
      let rewarded = false;
      try {
        this.ysdk.adv.showRewardedVideo({
          callbacks: {
            onRewarded: () => { rewarded = true; },
            onClose: () => done(rewarded),
            onError: () => done(false),
          },
        });
        return;
      } catch (e) { done(false); return; }
    }
    mockAd(2, () => done(true));
  },
};

function mockAd(seconds, cb) {
  const el = document.getElementById('adMock');
  const timer = document.getElementById('adMockTimer');
  el.classList.remove('hidden');
  let left = seconds;
  timer.textContent = left;
  const iv = setInterval(() => {
    left--;
    if (left <= 0) {
      clearInterval(iv);
      el.classList.add('hidden');
      cb();
    } else timer.textContent = left;
  }, 1000);
}
