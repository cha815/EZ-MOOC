// ==UserScript==
// @name         MOOC 视频学习辅助
// @namespace    local.mooc.study
// @license      MIT
// @homepageURL  https://github.com/cha815/EZ-MOOC
// @supportURL   https://github.com/cha815/EZ-MOOC/issues
// @version      0.9.1
// @description  正常播放、断点续播和不计分练习辅助，支持知识作答或课程资料作答
// @match        https://www.icourse163.org/mooc/learn/*
// @match        https://www.icourse163.org/course/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const defaults = {
    token: '',
    courseUrl: '',
    video: 'video',
    quiz: '.mooc-video-player__anchor-overlay.is-blocking[role="dialog"], [data-mooc-practice]',
    stem: '.rich-text-unit-renderer:not(.anchor-option-content), [data-mooc-stem]',
    option: 'label:has(input[type="radio"]), label:has(input[type="checkbox"])',
    submit: 'button, .j-submit',
    next: '[data-mooc-next-video]',
    continue: '.mooc-video-player__anchor-overlay button, [data-mooc-continue]',
    nativeAutoNext: 'input[aria-label="自动播放下一视频"]',
    maxRetries: 3,
    playbackRate: 2
  };
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  function parseCourseLink(value, URLClass = URL) {
    let url;
    try { url = new URLClass(String(value).trim()); } catch { throw new Error('请输入完整的中国大学 MOOC 课程链接'); }
    if (url.protocol !== 'https:' || !['www.icourse163.org', 'icourse163.org'].includes(url.hostname) || url.port || url.username || url.password) throw new Error('课程链接必须是 https://www.icourse163.org 上的课程地址');
    const match = url.pathname.match(/^\/(course|mooc\/learn)\/([A-Za-z0-9_-]+-\d+)(?:\/(.*))?$/);
    if (!match || (match[1] === 'course' && match[3]) || (match[1] === 'mooc/learn' && !/^content(?:\/\d+)?\/?$/.test(match[3] || 'content'))) throw new Error('请填写课程介绍页或课件/视频页链接');
    const tid = url.searchParams.get('tid') || '';
    if (tid && !/^\d+$/.test(tid)) throw new Error('课程链接中的 tid 应为数字');
    const clean = new URLClass(`https://www.icourse163.org${url.pathname}`);
    if (tid) clean.searchParams.set('tid', tid);
    if (match[1] === 'mooc/learn' && !match[3]) clean.pathname += clean.pathname.endsWith('/') ? 'content' : '/content';
    // A detail link with a term can go straight to the normal courseware page.
    if (match[1] === 'course' && tid) clean.pathname = `/mooc/learn/${match[2]}/content`;
    return { id: match[2], tid, url: clean.href };
  }
  const visible = el => !!el && !el.hidden && el.getClientRects().length > 0 && el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden';
  function documents(doc) {
    const result = [doc];
    for (const frame of doc.querySelectorAll('iframe')) {
      try { if (frame.contentDocument) result.push(...documents(frame.contentDocument)); } catch { /* Cross-origin frames are not bypassed. */ }
    }
    return result;
  }
  class Helper {
    constructor(doc, storage, request, config = {}) {
      this.doc = doc; this.storage = storage; this.request = request;
      this.config = { ...defaults, ...config, playbackRate: 2 }; this.state = 'stopped'; this.epoch = 0;
      const url = new doc.defaultView.URL(doc.defaultView.location.href);
      this.runKey = `mooc-running:${url.pathname.split('/').slice(0, 4).join('/')}:${url.searchParams.get('tid') || ''}`;
      this.title = '';
      this.video = null; this.key = ''; this.busy = false; this.logs = []; this.retries = 0;
      this.lastTime = -1; this.lastMove = Date.now(); this.lastAttempt = 0;
      this.restored = false; this.navigation = null; this.pending = null; this.nativeWait = null;
      this.feedbackPending = null;
      this.rateBinding = null; this.rateSample = null; this.measuredRate = null; this.rateError = '';
      this.now = () => this.doc.defaultView.performance.now();
    }
    all(selector) { return documents(this.doc).flatMap(d => [...d.querySelectorAll(selector)]).filter(visible); }
    courseAllowed() {
      const url = new this.doc.defaultView.URL(this.doc.defaultView.location.href);
      if (url.origin !== 'https://www.icourse163.org' || !/^\/mooc\/learn\/[A-Za-z0-9_-]+-\d+\/content(?:\/|$)/.test(url.pathname)) return false;
      if (!this.config.courseUrl) return true;
      const target = parseCourseLink(this.config.courseUrl, this.doc.defaultView.URL);
      const current = parseCourseLink(url.href, this.doc.defaultView.URL);
      return target.id === current.id && (!target.tid || target.tid === current.tid);
    }
    setCourseUrl(value) {
      const target = parseCourseLink(value, this.doc.defaultView.URL);
      this.pause('课程链接已保存，请在目标视频页点击开始');
      this.config.courseUrl = target.url;
      return target.url;
    }
    log(message) {
      this.logs.push(`${new Date().toLocaleTimeString()} ${message}`);
      this.logs = this.logs.slice(-80); this.render?.();
    }
    resetRateMeasurement() { this.rateSample = null; this.measuredRate = null; }
    bindRateEvents(video) {
      if (this.rateBinding?.video === video) return;
      if (this.rateBinding) {
        const binding = this.rateBinding;
        for (const name of binding.events) binding.video.removeEventListener(name, binding.listener);
        if (binding.timer !== null) this.doc.defaultView.clearTimeout(binding.timer);
      }
      this.rateBinding = null; this.resetRateMeasurement(); this.rateError = '';
      if (!video) return;
      const binding = { video, timer: null, events: ['ratechange', 'loadedmetadata', 'playing', 'seeking', 'waiting', 'pause', 'emptied'] };
      binding.listener = () => {
        this.resetRateMeasurement();
        if (binding.timer !== null || this.state !== 'running') return;
        // Run after the player's own event handlers, including source-load resets.
        binding.timer = this.doc.defaultView.setTimeout(() => {
          binding.timer = null;
          if (video === this.video && this.state === 'running' && this.courseAllowed()) this.enforceRate(video);
          this.render?.();
        }, 0);
      };
      for (const name of binding.events) video.addEventListener(name, binding.listener);
      this.rateBinding = binding;
    }
    enforceRate(video) {
      if (this.state !== 'running' || video !== this.video || !video?.isConnected) return;
      try {
        if (video.defaultPlaybackRate !== 2) video.defaultPlaybackRate = 2;
        if (video.playbackRate !== 2) {
          this.resetRateMeasurement(); video.playbackRate = 2;
          if (video.playbackRate !== 2) throw new Error('播放器没有接受2倍速设置');
          this.log('播放器倍速读数已设为2，等待实际播放计时验证');
        }
        this.rateError = '';
      } catch (error) {
        if (this.rateError !== error.message) { this.rateError = error.message; this.log(`倍速未确认：${error.message}`); }
      }
    }
    measureRate(video) {
      if (!video || video.paused || video.ended || video.seeking || video.readyState < 3 || !Number.isFinite(video.currentTime)) { this.resetRateMeasurement(); return; }
      const sample = { at: this.now(), time: video.currentTime };
      if (!this.rateSample) { this.rateSample = sample; return; }
      const elapsed = (sample.at - this.rateSample.at) / 1000;
      if (elapsed < 3) return;
      const advance = sample.time - this.rateSample.time;
      // Ignore seeks, stalled media and timers delayed by background tab throttling.
      this.measuredRate = elapsed <= 10 && advance > 0 && advance / elapsed <= 3 ? advance / elapsed : null;
      this.rateSample = sample;
    }
    rateStatus() {
      const video = this.video;
      if (!video?.isConnected || !visible(video) || !Number.isFinite(video.playbackRate) || video.playbackRate <= 0) return '倍速未确认（未检测到播放器）';
      const measured = this.measuredRate;
      const timing = measured === null ? '实际速度未确认（等待连续播放）' : `实测约${measured.toFixed(2)}倍速`;
      return `目标2倍速 · 播放器读数${video.playbackRate}倍速 · ${this.rateError ? `未确认：${this.rateError}` : timing}`;
    }
    pause(reason = '已暂停') {
      this.resetRateMeasurement();
      this.storage.removeItem(this.runKey);
      this.state = 'paused'; this.epoch++; this.video?.pause(); this.log(reason);
    }
    stop() { this.pause('已停止；保留播放位置'); this.state = 'stopped'; this.render?.(); }
    start(reason = '已开始') {
      if (!this.courseAllowed()) { this.pause('请先打开填写的目标课程视频页；登录或选课需手动完成'); return; }
      this.storage.setItem(this.runKey, 'running'); this.state = 'running'; this.epoch++; this.retries = 0; this.lastAttempt = 0; this.lastMove = Date.now(); this.log(reason); void this.tick();
    }
    suspend() {
      // pagehide is navigation, not a user stop. Preserve the active session for the next document.
      if (this.state === 'running') this.storage.setItem(this.runKey, 'running');
      else this.storage.removeItem(this.runKey);
      this.epoch++; this.video?.pause();
      this.bindRateEvents(null);
      this.state = 'suspended';
    }
    resumeSession() {
      if (this.storage.getItem(this.runKey) === 'running') this.start('页面切换后自动继续');
    }
    selectVideo() {
      const videos = this.all(this.config.video);
      if (videos.length > 1) throw new Error('检测到多个播放器，请在设置中缩小 video 选择器');
      const video = videos[0];
      if (!video) {
        this.bindRateEvents(null);
        if (this.video) { this.epoch++; this.video = null; this.pending = null; this.feedbackPending = null; }
        return null;
      }
      // During a source change, currentSrc can still point to the previous resource.
      const source = (video.getAttribute('src') || video.currentSrc || '').split('?')[0];
      const key = `mooc-position:${location.href}:${source}`;
      const selected = this.all('[role="tab"][aria-selected="true"]');
      const title = selected.length === 1 ? norm(selected[0].querySelector('[title]')?.getAttribute('title') || selected[0].getAttribute('aria-label') || selected[0].textContent) : '';
      if (video !== this.video || key !== this.key) {
        this.resetRateMeasurement();
        this.epoch++; this.pending = null; this.feedbackPending = null;
        this.video = video; this.key = key; this.restored = false;
        this.retries = 0; this.lastAttempt = 0; this.lastTime = -1; this.lastMove = Date.now(); this.navigation = null; this.nativeWait = null;
        this.title = title;
        if (this.state === 'running') this.log(`已识别视频${title ? `：${title}` : '切换，自动继续'}`);
      }
      this.title = title;
      this.bindRateEvents(video);
      return video;
    }
    readQuestion(root) {
      const stems = [...root.querySelectorAll(this.config.stem)].filter(visible);
      if (stems.length !== 1) throw new Error('题干未唯一识别，请配置 stem 选择器');
      const elements = [...root.querySelectorAll(this.config.option)].filter(visible);
      const inputs = elements.map(e => e.matches('input') ? e : e.querySelector('input'));
      const blanks = [...root.querySelectorAll('input:not([type]), input[type="text"], textarea')].filter(visible);
      if (blanks.length) {
        if (elements.length || blanks.length > 10 || !norm(stems[0].textContent)) throw new Error('混合题型或填空数量不受支持，请手动处理');
        const question = { practice: true, stem: norm(stems[0].textContent), options: [], type: 'fill', blankCount: blanks.length };
        const id = `mooc-submitted:${this.key}:${JSON.stringify(question)}`;
        return { question, elements: blanks, inputs: blanks, id };
      }
      if (elements.length < 2 || inputs.some(i => !i || !['radio', 'checkbox'].includes(i.type)) || new Set(inputs.map(i => i.type)).size !== 1) throw new Error('仅支持可识别的单选/多选题，请手动作答');
      const question = { practice: true, stem: norm(stems[0].textContent), options: elements.map(e => norm(e.textContent)), type: inputs[0].type === 'radio' ? 'single' : 'multiple' };
      if (!question.stem || question.options.some(o => !o) || new Set(question.options).size !== question.options.length) throw new Error('题目或选项缺失/重复，请手动作答');
      const id = `mooc-submitted:${this.key}:${JSON.stringify(question)}`;
      return { question, elements, inputs, id };
    }
    handleFeedback(root) {
      const stems = [...root.querySelectorAll(this.config.stem)];
      // Only recognize separate result text, never words inside a question or an option.
      const messages = [...root.querySelectorAll('p, [role="status"], [data-mooc-feedback]')]
        .filter(e => visible(e) && !e.closest('label') && !stems.some(stem => stem.contains(e)))
        .map(e => norm(e.textContent));
      const result = messages.find(text => /^(回答错误|回答不正确|答案错误|回答正确|答案正确|提交成功)[。！!]?$/u.test(text));
      if (!result) return false;
      const stem = norm(stems[0]?.textContent);
      const key = `mooc-feedback:${this.key}:${stem}:${result}`;
      const controls = [...root.querySelectorAll(this.config.continue)].filter(e => visible(e) && !e.disabled && /^(继续|继续播放|继续学习|完成)$/.test(norm(e.textContent)));
      if (!this.feedbackPending || this.feedbackPending.key !== key) {
        this.feedbackPending = { key, at: Date.now(), continued: false };
        if (this.storage.getItem(key)) { this.pause('已点击过继续学习但反馈仍存在，请手动确认'); return true; }
      }
      const pending = this.feedbackPending;
      if (controls.length > 1) { this.pause('继续学习按钮未唯一识别，请手动处理'); return true; }
      if (controls.length === 1 && !pending.continued) {
        pending.continued = true; pending.at = Date.now();
        this.storage.setItem(key, 'continued');
        controls[0].click();
        this.log(`${result}，已点击继续学习；不重新答题`);
      } else if (Date.now() - pending.at > 15000) {
        this.pause('练习反馈未关闭或继续按钮不可用，请手动确认');
      }
      return true;
    }
    async handleQuiz(root) {
      this.video?.pause();
      // Result screens can disable or remove inputs. Handle them before reading an unanswered question.
      if (this.handleFeedback(root)) return;
      const item = this.readQuestion(root);
      if (this.storage.getItem(item.id)) {
        // Never retry a submission whose result is unknown, including across refreshes.
        if (!this.pending || this.pending.id !== item.id || Date.now() - this.pending.at > 15000) this.pause('此题已提交或提交结果不明，请手动确认后继续');
        return;
      }
      if (item.inputs.some(i => i.disabled || i.readOnly)) return this.pause('答题控件已禁用，请确认题目状态后继续');
      if (!this.config.token) return this.pause('请先在设置中填写本地服务 token；本题由你作答');
      const epoch = this.epoch;
      this.log(`正在分析练习：${item.question.stem.slice(0, 70)}`);
      const answer = await this.request(item.question, this.config.token);
      // Refresh identity before applying an asynchronous answer from the previous lesson.
      this.selectVideo();
      if (epoch !== this.epoch || this.state !== 'running') return;
      if (!visible(root) || this.readQuestion(root).id !== item.id) return this.pause('答题期间页面发生变化，已取消提交');
      const fill = item.question.type === 'fill';
      const validResponse = fill
        ? Array.isArray(answer.texts) && answer.texts.length === item.inputs.length && answer.texts.every(t => typeof t === 'string' && t.trim().length > 0 && t.length <= 500) && Array.isArray(answer.indices) && answer.indices.length === 0
        : Array.isArray(answer.indices) && answer.indices.length > 0 && new Set(answer.indices).size === answer.indices.length && answer.indices.every(i => Number.isInteger(i) && i >= 0 && i < item.inputs.length) && (item.question.type !== 'single' || answer.indices.length === 1);
      if (answer.abstain !== false || !validResponse) return this.pause(`需手动作答：${answer.reason || '模型未返回格式正确的答案'}`);
      let buttons = [...root.querySelectorAll(this.config.submit)].filter(e => visible(e) && /^(提交|提交答案|确定)$/.test(norm(e.textContent)));
      if (buttons.length !== 1) return this.pause('提交按钮未唯一识别，已取消自动作答');
      if (fill) {
        const texts = answer.texts.map(t => t.trim());
        if (item.inputs.some((input, i) => (input.maxLength >= 0 && texts[i].length > input.maxLength) || (input.value.trim() && input.value.trim() !== texts[i]))) return this.pause('填空长度受限或已有手动输入，已停止自动填写');
        for (let i = 0; i < item.inputs.length; i++) {
          const input = item.inputs[i];
          const win = input.ownerDocument.defaultView;
          const proto = input.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
          // Use the native setter so React-controlled inputs receive the new value.
          input.focus();
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, texts[i]);
          input.dispatchEvent(new win.Event('input', { bubbles: true }));
          input.dispatchEvent(new win.Event('change', { bubbles: true }));
          input.blur();
        }
      } else {
        for (let i = 0; i < item.inputs.length; i++) {
          const target = answer.indices.includes(i);
          if (item.inputs[i].checked !== target && (target || item.inputs[i].type === 'checkbox')) item.elements[i].click();
        }
      }
      // React may enable/replace the submit button only after the choice event.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (epoch !== this.epoch || this.state !== 'running') return;
      if (!visible(root) || this.readQuestion(root).id !== item.id) return this.pause('选择后题目发生变化，已取消提交');
      const fresh = this.readQuestion(root);
      if (fresh.inputs.some((input, i) => fill ? input.value !== answer.texts[i].trim() : input.checked !== answer.indices.includes(i))) return this.pause('答案未成功写入页面，请手动作答');
      buttons = [...root.querySelectorAll(this.config.submit)].filter(e => visible(e) && !e.disabled && /^(提交|提交答案|确定)$/.test(norm(e.textContent)));
      if (buttons.length !== 1) return this.pause('选答案后提交按钮仍不可用，请手动处理');
      // Write BEFORE click. A failed/uncertain click must never be repeated automatically.
      this.storage.setItem(item.id, 'attempted');
      this.pending = { id: item.id, at: Date.now() };
      buttons[0].click();
      this.log(`已提交一次。${answer.answerMode === 'knowledge' ? '模型解题说明' : '解题依据'}：${typeof answer.evidence === 'string' && answer.evidence.trim() ? answer.evidence.slice(0, 120) : '未提供'}`);
    }
    async tick() {
      let ownsWork = false;
      try {
        if (!this.courseAllowed()) {
          if (this.state === 'running') this.pause('已离开目标课程视频页，停止自动操作');
          return;
        }
        const video = this.selectVideo();
        if (this.state === 'running' && video) this.enforceRate(video);
        this.measureRate(video);
        if (this.busy || this.state !== 'running') return;
        this.busy = true; ownsWork = true;
        if (!video) {
          if (Date.now() - this.lastMove > 30000) this.pause('30秒内未找到播放器：请登录、打开一个视频，或配置 video 选择器');
          return;
        }
        const quizzes = this.all(this.config.quiz);
        if (quizzes.length > 1) return this.pause('存在多个题目容器，请手动处理');
        if (quizzes.length) { await this.handleQuiz(quizzes[0]); return; }
        const unknown = this.all('[role="dialog"], .m-popover, .m-video-question').some(e => e.matches('[role="dialog"]') || e.querySelector('input[type="radio"], input[type="checkbox"], input[placeholder*="验证码"]'));
        if (unknown) return this.pause('发现未识别的题目或验证弹窗，请手动处理并配置选择器');
        this.feedbackPending = null;
        if (this.pending) {
          const controls = this.all(this.config.continue).filter(e => !e.disabled && /^(继续|继续播放|继续学习|完成)$/.test(norm(e.textContent)));
          if (controls.length === 1) controls[0].click();
          this.pending = null;
        }
        if (video.readyState < 1) {
          if (Date.now() - this.lastMove > 30000) this.pause('视频元数据加载超时，请检查网络后重新开始');
          return;
        }
        if (!this.restored) {
          this.restored = true;
          const saved = Number(this.storage.getItem(this.key));
          if (saved > 0 && Number.isFinite(video.duration) && saved < video.duration - 2 && video.currentTime < saved) {
            video.currentTime = saved; this.log(`恢复至 ${Math.floor(saved)} 秒`);
          }
        }
        if (video.currentTime !== this.lastTime) {
          this.lastTime = video.currentTime; this.lastMove = Date.now(); this.retries = 0;
          this.storage.setItem(this.key, String(video.currentTime));
        }
        if (video.ended) {
          if (this.navigation) {
            if (Date.now() - this.navigation > 20000) this.pause('下一视频未加载，请手动选择后继续');
            return;
          }
          // The current course already has native auto-next; do not race its ended handler.
          const auto = documents(this.doc).flatMap(d => [...d.querySelectorAll(this.config.nativeAutoNext)]);
          if (auto.length === 1 && auto[0].checked) {
            if (this.nativeWait === null) { this.nativeWait = Date.now(); this.log('等待网站自动播放下一视频'); return; }
            if (Date.now() - this.nativeWait < 5000) return;
          }
          let candidates = this.all(this.config.next).filter(e => !e.disabled && e.getAttribute('aria-disabled') !== 'true');
          if (!candidates.length) {
            const groups = this.all('[role="tablist"]');
            if (groups.length === 1) {
              const tabs = [...groups[0].querySelectorAll('[role="tab"]')];
              const current = tabs.findIndex(e => e.getAttribute('aria-selected') === 'true');
              const nextVideo = current >= 0 && tabs.slice(current + 1).find(e => visible(e) && !e.disabled && e.querySelector('[data-lesson-type-icon="video"]'));
              if (nextVideo) candidates = [nextVideo];
            }
          }
          if (candidates.length !== 1) return this.pause('当前视频已结束：下一视频按钮未唯一识别，请手动选择或配置 next');
          this.navigation = Date.now(); candidates[0].click(); this.log('已点击下一视频'); return;
        }
        if (video.paused || video.error || Date.now() - this.lastMove > 30000) {
          if (Date.now() - this.lastAttempt < 5000) return;
          if (this.retries >= this.config.maxRetries) return this.pause('播放重试次数已用完，请检查网络或点击播放器后重新开始');
          this.retries++; this.lastAttempt = Date.now();
          // No reload or synthetic completion events: a retry is only a normal play request.
          const epoch = this.epoch;
          try { await video.play(); if (epoch !== this.epoch || this.state !== 'running') video.pause(); }
          catch (error) { this.log(`播放失败（${this.retries}/${this.config.maxRetries}）：${error.message}`); }
        }
      } catch (error) { this.pause(`错误：${error.message}`); }
      finally { if (ownsWork) this.busy = false; this.render?.(); }
    }
  }
  // Expose the controller for local fixture tests, without granting page code GM capabilities.
  if (typeof module !== 'undefined' && module.exports) { module.exports = { Helper, defaults, parseCourseLink }; return; }
  const config = GM_getValue('config', defaults);
  const request = (question, token) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({ method: 'POST', url: 'http://127.0.0.1:17363/solve', timeout: 55000,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, data: JSON.stringify(question),
      onload: r => { try { const data = JSON.parse(r.responseText); if (r.status !== 200) throw new Error(data.error || `HTTP ${r.status}`); resolve(data); } catch (e) { reject(e); } },
      onerror: () => reject(new Error('无法连接本地答题服务，请运行 npm start')),
      ontimeout: () => reject(new Error('答题超时，本次不重试提交'))
    });
  });
  const helper = new Helper(document, sessionStorage, request, config);
  if (config.playbackRate !== 2) GM_setValue('config', helper.config);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;top:80px;z-index:2147483647';
  document.body.append(host);
  const ui = host.attachShadow({ mode: 'closed' });
  ui.innerHTML = `<style>:host{all:initial}section{font:14px/1.5 system-ui;color:#eaf0ff;background:#182235;padding:16px;border-radius:12px;width:310px;box-shadow:0 5px 24px #0006}button{margin:4px 3px 8px 0;padding:6px 12px;cursor:pointer}pre{white-space:pre-wrap;overflow:auto;max-height:180px;font-size:12px}textarea{box-sizing:border-box;width:100%;height:240px}summary{cursor:pointer}small{color:#c2cfe8}</style>
    <section><strong>MOOC 学习辅助</strong><p><input id="course-url" type="url" placeholder="粘贴课程或视频网页链接" style="box-sizing:border-box;width:100%;padding:7px"><button id="open-course">保存并打开课程</button></p><p id="status"></p><button id="start">开始</button><button id="pause">暂停</button><button id="stop">停止</button>
    <small>不计分练习 · 直接作答</small><details><summary>设置 / 页面适配</summary><p>在下方 JSON 中填写本地 token 和页面选择器。</p><textarea spellcheck="false"></textarea><button id="save">保存设置</button></details><details open><summary>运行日志</summary><pre></pre></details></section>`;
  const editor = ui.querySelector('textarea'); editor.value = JSON.stringify(helper.config, null, 2);
  const courseInput = ui.querySelector('#course-url'); courseInput.value = helper.config.courseUrl;
  ui.querySelector('#open-course').onclick = () => {
    try {
      const url = helper.setCourseUrl(courseInput.value);
      GM_setValue('config', helper.config);
      courseInput.value = url; editor.value = JSON.stringify(helper.config, null, 2);
      if (url !== location.href) location.assign(url);
    } catch (error) { helper.log(`课程链接无效：${error.message}`); }
  };
  helper.render = () => {
    const labels = { running: '运行中', paused: '已暂停', stopped: '已停止', suspended: '页面切换中' };
    const video = helper.video;
    const seconds = value => Number.isFinite(value) ? Math.floor(value) : 0;
    ui.querySelector('#status').textContent = `${labels[helper.state]}${helper.title ? ` · ${helper.title}` : ''} · ${seconds(video?.currentTime)} / ${seconds(video?.duration)} 秒 · ${helper.rateStatus()}`;
    ui.querySelector('pre').textContent = helper.logs.join('\n');
  };
  ui.querySelector('#start').onclick = () => helper.start();
  ui.querySelector('#pause').onclick = () => helper.pause();
  ui.querySelector('#stop').onclick = () => helper.stop();
  ui.querySelector('#save').onclick = () => {
    try {
      const next = { ...defaults, ...JSON.parse(editor.value) };
      if (typeof next.courseUrl !== 'string') throw new Error('courseUrl 必须为课程链接字符串');
      if (next.courseUrl.trim()) next.courseUrl = parseCourseLink(next.courseUrl).url;
      if (!Number.isInteger(next.maxRetries) || next.maxRetries < 1 || next.maxRetries > 5 || typeof next.token !== 'string') throw new Error('token 必须是字符串，maxRetries 必须为1~5');
      if (next.playbackRate !== 2) throw new Error('运行期间固定2倍速，playbackRate 请保留为2；暂停或停止后可在播放器中自行调整');
      for (const key of ['video', 'quiz', 'stem', 'option', 'submit', 'next', 'continue', 'nativeAutoNext']) { if (typeof next[key] !== 'string' || !next[key].trim()) throw new Error(`${key} 必须为选择器`); document.querySelector(next[key]); }
      helper.pause('配置已保存，请点击开始'); helper.config = next; GM_setValue('config', next); courseInput.value = next.courseUrl; editor.value = JSON.stringify(next, null, 2);
    } catch (error) { helper.log(`设置无效：${error.message}`); }
  };
  helper.render();
  helper.resumeSession();
  setInterval(() => void helper.tick(), 1000);
  addEventListener('pagehide', () => helper.suspend());
  addEventListener('pageshow', event => { if (event.persisted) helper.resumeSession(); });
})();
