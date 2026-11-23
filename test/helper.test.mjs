import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { solve, validateAnswer, modelConfig, validQuestion } from '../solver.mjs';

const context = '传输控制协议TCP提供面向连接的可靠传输服务。';
const answer = { abstain: false, confidence: 0.99, indices: [1], evidence: context, reason: '课程原文' };
const html = `<video src="https://media.example/v1.mp4"></video><button data-mooc-next-video>下一视频</button>`;
const quiz = `<div data-mooc-practice><p data-mooc-stem>哪个协议提供可靠传输？</p><label><input type="radio" name="q">UDP</label><label><input type="radio" name="q">TCP</label><button>提交</button></div>`;
function fixture(extra = '', request = async () => answer) {
  const dom = new JSDOM(html + extra, { url: 'https://www.icourse163.org/mooc/learn/NJUPT-1001639008/content/1?tid=2' });
  dom.window.Element.prototype.getClientRects = function () { return this.hidden || this.closest('[hidden]') ? [] : [{}]; };
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL('../mooc-helper.user.js', import.meta.url), 'utf8'), { module, location: dom.window.location, console, setTimeout });
  const helper = new module.exports.Helper(dom.window.document, dom.window.sessionStorage, request, { token: 'test' });
  helper.state = 'running';
  const video = dom.window.document.querySelector('video');
  let time = 0, paused = true, ended = false, plays = 0;
  Object.defineProperties(video, {
    currentTime: { get: () => time, set: v => { time = v; } },
    duration: { value: 100 }, readyState: { value: 4 },
    paused: { get: () => paused }, ended: { get: () => ended }
  });
  video.play = async () => { plays++; paused = false; };
  video.pause = () => { paused = true; };
  return { dom, helper, video, ended: () => { ended = true; }, plays: () => plays };
}
test('播放并恢复当前视频位置', async () => {
  const { helper, video, plays } = fixture(); helper.selectVideo(); helper.storage.setItem(helper.key, '42');
  await helper.tick(); assert.equal(video.currentTime, 42); assert.equal(plays(), 1);
  assert.equal(video.playbackRate, 2); assert.equal(video.defaultPlaybackRate, 2);
});
test('当前视频不读取其他视频位置', async () => {
  const { helper, video } = fixture(); helper.storage.setItem('mooc-position:other', '80');
  await helper.tick(); assert.equal(video.currentTime, 0);
});
test('暂停和停止确实停止播放器', async () => {
  const { helper, video } = fixture(); await helper.tick(); helper.pause(); assert.equal(video.paused, true);
  helper.stop(); assert.equal(helper.state, 'stopped');
});
test('练习准确选择答案，且提交仅一次', async () => {
  let requests = 0;
  const { helper, dom } = fixture(quiz, async () => { requests++; return answer; });
  let submissions = 0;
  dom.window.document.querySelector('[data-mooc-practice] button').onclick = () => submissions++;
  await helper.tick(); await helper.tick();
  assert.equal(dom.window.document.querySelectorAll('input')[1].checked, true);
  assert.equal(submissions, 1); assert.equal(requests, 1);
});
test('刷新后的不明提交不会重发', async () => {
  const { helper, dom } = fixture(quiz); helper.selectVideo();
  const item = helper.readQuestion(dom.window.document.querySelector('[data-mooc-practice]'));
  helper.storage.setItem(item.id, 'attempted'); await helper.tick(); assert.equal(helper.state, 'paused');
});
test('低置信度不再阻止选择答案', async () => {
  const { helper, dom } = fixture(quiz, async () => ({ ...answer, confidence: 0.6 }));
  await helper.tick(); assert.equal(helper.state, 'running'); assert.ok(dom.window.document.querySelector('input:checked'));
});
test('答题中暂停，延迟响应不能提交', async () => {
  let finish;
  const { helper, dom } = fixture(quiz, () => new Promise(resolve => { finish = resolve; }));
  const run = helper.tick(); helper.pause(); finish(answer); await run;
  assert.equal(dom.window.document.querySelector('input:checked'), null);
});
test('答题期间题目变化，取消旧答案', async () => {
  let finish;
  const { helper, dom } = fixture(quiz, () => new Promise(resolve => { finish = resolve; }));
  const run = helper.tick(); dom.window.document.querySelector('[data-mooc-stem]').textContent = '新题目';
  finish(answer); await run; assert.equal(helper.state, 'paused'); assert.equal(dom.window.document.querySelector('input:checked'), null);
});
test('服务不可达暂停，不循环请求', async () => {
  let calls = 0;
  const { helper } = fixture(quiz, async () => { calls++; throw new Error('offline'); });
  await helper.tick(); await helper.tick(); assert.equal(calls, 1); assert.equal(helper.state, 'paused');
});
test('下一视频只点击一次', async () => {
  const { helper, dom, ended } = fixture(); let count = 0;
  dom.window.document.querySelector('[data-mooc-next-video]').onclick = () => count++;
  ended(); await helper.tick(); await helper.tick(); assert.equal(count, 1);
});
test('多个下一视频候选时暂停', async () => {
  const { helper, ended } = fixture('<button data-mooc-next-video>另一个</button>');
  ended(); await helper.tick(); assert.equal(helper.state, 'paused');
});
test('播放最多重试配置次数', async () => {
  const { helper, video } = fixture(); let count = 0;
  video.play = async () => { count++; throw new Error('autoplay'); };
  for (let i = 0; i < 5; i++) { helper.lastAttempt = 0; await helper.tick(); }
  assert.equal(count, 3); assert.equal(helper.state, 'paused');
});
test('未知练习弹窗暂停，不继续播放', async () => {
  const { helper, plays } = fixture('<div role="dialog"><input type="radio"></div>');
  await helper.tick(); assert.equal(plays(), 0); assert.equal(helper.state, 'paused');
});
test('证据缺失、虚构引用、越界和重复选项均被拒绝', () => {
  const q = { options: ['UDP', 'TCP'], type: 'single' };
  assert.ok(validateAnswer(answer, q, context));
  for (const bad of [{ evidence: '' }, { evidence: '这是一条资料里并不存在的引文内容' }, { indices: [2] }, { indices: [1, 1] }, { indices: [0, 1] }]) assert.equal(validateAnswer({ ...answer, ...bad }, q, context), null);
});
test('资料模式无资料或未配置密钥时不调用模型', async () => {
  const fail = () => { throw new Error('unexpected request'); };
  assert.equal((await solve({}, '', { answerMode: 'materials', fetchImpl: fail })).abstain, true);
  assert.equal((await solve({}, context, { fetchImpl: fail })).abstain, true);
});
test('模型结构化结果和请求协议匹配', async () => {
  const result = await solve({ type: 'single', options: ['UDP', 'TCP'] }, context, { apiKey: 'test', model: 'configured-model', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body); assert.equal(body.store, false); assert.equal(body.text.format.type, 'json_schema');
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }) };
  } }); assert.deepEqual(result, { ...answer, answerMode: 'knowledge' });
});
test('多选按完整集合选择，不保留错误的预选项', async () => {
  const markup = quiz.replaceAll('type="radio"', 'type="checkbox"');
  const { helper, dom } = fixture(markup, async () => ({ ...answer, indices: [0, 1] }));
  await helper.tick(); assert.equal(dom.window.document.querySelectorAll('input:checked').length, 2);
});
test('成功反馈中的继续按钮只点击一次', async () => {
  const { helper, dom } = fixture(quiz);
  const root = dom.window.document.querySelector('[data-mooc-practice]');
  await helper.tick();
  const feedback = dom.window.document.createElement('p'); feedback.textContent = '回答正确'; root.append(feedback);
  const button = dom.window.document.createElement('button'); button.setAttribute('data-mooc-continue', ''); button.textContent = '继续播放'; root.append(button);
  let count = 0; button.onclick = () => count++;
  await helper.tick(); await helper.tick(); assert.equal(count, 1);
});
test('错误反馈不会再次请求或试选其他选项', async () => {
  let calls = 0;
  const { helper, dom } = fixture(quiz, async () => { calls++; return answer; });
  await helper.tick(); dom.window.document.querySelector('[data-mooc-stem]').insertAdjacentHTML('afterend', '<p>回答错误</p>');
  await helper.tick(); assert.equal(helper.state, 'paused'); assert.equal(calls, 1);
});
test('延迟成功的播放请求不会撤销用户暂停', async () => {
  const { helper, video } = fixture(); let finish;
  video.play = () => new Promise(resolve => { finish = resolve; });
  const run = helper.tick(); helper.pause(); finish(); await run;
  assert.equal(video.paused, true); assert.equal(helper.state, 'paused');
});
test('真实弹题结构：选答案后提交按钮才启用', async () => {
  const markup = `<div role="dialog" class="mooc-video-player__anchor-overlay is-blocking"><div class="rich-text-unit-renderer"><p>OSI/RM的中文名称是开放系统互连/参考模型。</p></div><label class="anchor-option"><input type="radio" name="anchor"><span>A.</span><div class="rich-text-unit-renderer anchor-option-content">正确</div></label><label class="anchor-option"><input type="radio" name="anchor"><span>B.</span><div class="rich-text-unit-renderer anchor-option-content">错误</div></label><button disabled>提交</button></div>`;
  const { helper, dom } = fixture(markup, async () => ({ ...answer, indices: [0] }));
  const root = dom.window.document.querySelector('[role="dialog"]');
  const button = root.querySelector('button'); let count = 0;
  root.onchange = () => { button.disabled = false; };
  button.onclick = () => count++;
  await helper.tick(); assert.equal(count, 1); assert.equal(helper.state, 'running');
});
test('网站已勾选自动下一视频，脚本不重复切换', async () => {
  const { helper, dom, ended } = fixture('<input type="checkbox" aria-label="自动播放下一视频" checked>');
  let count = 0; dom.window.document.querySelector('[data-mooc-next-video]').onclick = () => count++;
  ended(); await helper.tick(); await helper.tick(); assert.equal(count, 0); assert.ok(helper.nativeWait);
});
test('课时标签回退只选当前标签之后的视频，跳过文档', async () => {
  const { helper, dom, ended } = fixture(`<div role="tablist"><button role="tab" aria-selected="true">当前</button><button role="tab"><i data-lesson-type-icon="pdf"></i>PDF</button><button role="tab" id="nextVideo"><i data-lesson-type-icon="video"></i>下一视频</button></div>`);
  dom.window.document.querySelector('[data-mooc-next-video]').remove();
  let count = 0; dom.window.document.querySelector('#nextVideo').onclick = () => count++;
  ended(); await helper.tick(); assert.equal(count, 1);
});
test('原生续播五秒内没反应后，回退一次正常点击', async () => {
  const { helper, dom, ended } = fixture('<input type="checkbox" aria-label="自动播放下一视频" checked>');
  let count = 0; dom.window.document.querySelector('[data-mooc-next-video]').onclick = () => count++;
  ended(); await helper.tick(); helper.nativeWait = Date.now() - 6000;
  await helper.tick(); await helper.tick(); assert.equal(count, 1);
});
test('真实成功反馈：禁用选项不会阻断继续学习按钮', async () => {
  const { helper, dom } = fixture(quiz);
  await helper.tick();
  const root = dom.window.document.querySelector('[data-mooc-practice]');
  root.className = 'mooc-video-player__anchor-overlay';
  root.querySelectorAll('input').forEach(e => { e.disabled = true; });
  const button = root.querySelector('button'); button.textContent = '继续学习';
  let count = 0; button.onclick = () => count++;
  root.insertAdjacentHTML('beforeend', '<p>回答正确</p>');
  await helper.tick(); await helper.tick(); assert.equal(count, 1); assert.equal(helper.state, 'running');
});
test('DeepSeek配置不会误用OpenAI密钥，且保留原有默认服务', () => {
  assert.deepEqual(modelConfig({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'ds-secret', OPENAI_API_KEY: 'other' }), { provider: 'deepseek', apiKey: 'ds-secret', model: 'deepseek-flash' });
  assert.equal(modelConfig({ OPENAI_API_KEY: 'other' }).provider, 'openai');
  assert.equal(modelConfig({ AI_PROVIDER: 'deepseek', OPENAI_API_KEY: 'other' }).apiKey, undefined);
  assert.throws(() => modelConfig({ AI_PROVIDER: 'typo' }));
});
test('DeepSeek请求端点、鉴权和结构化答案解析', async () => {
  const result = await solve({ type: 'single', options: ['UDP', 'TCP'] }, context, {
    provider: 'deepseek', apiKey: 'ds-test', model: 'deepseek-flash',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/responses');
      assert.equal(init.headers.Authorization, 'Bearer ds-test');
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'deepseek-flash');
      assert.equal(body.reasoning.effort, 'none');
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, undefined);
      return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }) };
    }
  }); assert.deepEqual(result, { ...answer, answerMode: 'knowledge' });
});
test('DeepSeek截断和服务错误时暂停，无说明不再阻止知识作答', async () => {
  const options = { provider: 'deepseek', apiKey: 'ds-test', model: 'deepseek-flash' };
  const q = { type: 'single', options: ['UDP', 'TCP'] };
  await assert.rejects(solve(q, context, { ...options, fetchImpl: async () => ({ ok: false, status: 429 }) }), /429/);
  await assert.rejects(solve(q, context, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'incomplete' }) }) }), /未完成/);
  const result = await solve(q, context, { ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...answer, evidence: '' }) }] }] }) }) });
  assert.equal(result.abstain, false);
});
test('无需课程资料也可通过DeepSeek知识作答，并兼容已安装的油猴脚本', async () => {
  const explanation = '知识推断：TCP通过确认和重传机制提供可靠传输。';
  const { helper, dom } = fixture(quiz, question => solve(question, '', {
    provider: 'deepseek', model: 'deepseek-flash', apiKey: 'test',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(JSON.parse(body.input).courseMaterial, '');
      assert.ok(body.instructions.includes('直接根据自身知识给出最可能的答案'));
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...answer, evidence: explanation }) }] }] }) };
    }
  }));
  let submitted = 0;
  dom.window.document.querySelector('[data-mooc-practice] button').onclick = () => submitted++;
  await helper.tick();
  assert.equal(submitted, 1); assert.equal(helper.state, 'running');
  assert.ok(helper.logs.some(line => line.includes('模型解题说明')));
});
test('知识说明不能当成课程引文；知识模式忽略分数但拒绝重复选项', () => {
  const q = { options: ['UDP', 'TCP'], type: 'single' };
  const inferred = { ...answer, evidence: '知识推断：TCP通过确认与重传提供可靠的传输。' };
  assert.ok(validateAnswer(inferred, q, '', 'knowledge'));
  assert.equal(validateAnswer(inferred, q, context, 'materials'), null);
  assert.ok(validateAnswer({ ...inferred, confidence: 0.01, evidence: '' }, q, '', 'knowledge'));
  assert.equal(validateAnswer({ ...inferred, indices: [1, 1] }, q, '', 'knowledge'), null);
});
test('知识模式遇到模型拒答仍暂停，不随机选择', async () => {
  const { helper, dom } = fixture(quiz, question => solve(question, '', {
    provider: 'deepseek', model: 'deepseek-flash', apiKey: 'test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...answer, abstain: true, indices: [], reason: '具体数据不确定' }) }] }] }) })
  }));
  await helper.tick(); assert.equal(helper.state, 'paused');
  assert.equal(dom.window.document.querySelector('input:checked'), null);
});

const fillQuiz = `<div class="mooc-video-player__anchor-overlay is-blocking" role="dialog"><div class="rich-text-unit-renderer"><p>计算机网络从逻辑上是由终端系统和（ ）两个部分组成。</p></div><input type="text"><button disabled>提交</button></div>`;
const fillAnswer = { ...answer, indices: [], texts: ['通信子网'], evidence: '知识推断：终端系统通过通信子网实现彼此间的数据通信。' };
test('填空题从识别到模型结果填写、触发输入事件并只提交一次', async () => {
  const { helper, dom } = fixture(fillQuiz, question => solve(question, '', {
    apiKey: 'test', model: 'deepseek-flash', provider: 'deepseek', fetchImpl: async (_url, init) => {
      const data = JSON.parse(init.body);
      const q = JSON.parse(data.input).question;
      assert.equal(q.type, 'fill'); assert.equal(q.blankCount, 1); assert.deepEqual(q.options, []);
      assert.equal(validQuestion(q), true);
      assert.ok(data.text.format.schema.required.includes('texts'));
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(fillAnswer) }] }] }) };
    }
  }));
  const root = dom.window.document.querySelector('[role="dialog"]');
  const button = root.querySelector('button'); let count = 0, changes = 0;
  root.oninput = () => { button.disabled = false; changes++; };
  button.onclick = () => count++;
  await helper.tick(); await helper.tick();
  assert.equal(root.querySelector('input').value, '通信子网');
  assert.equal(count, 1); assert.equal(changes, 1);
});
test('多个填空及textarea按照输入框顺序填写', async () => {
  const markup = fillQuiz.replace('<input type="text">', '<input type="text"><textarea></textarea>');
  const { helper, dom } = fixture(markup, async () => ({ ...fillAnswer, texts: ['第一空', '第二空'] }));
  const root = dom.window.document.querySelector('[role="dialog"]');
  root.oninput = () => { root.querySelector('button').disabled = false; };
  await helper.tick();
  assert.equal(root.querySelector('input').value, '第一空');
  assert.equal(root.querySelector('textarea').value, '第二空');
});
test('填空答案数不匹配、空答案或混用选择索引均拒绝', () => {
  const q = { practice: true, stem: '题目', options: [], type: 'fill', blankCount: 1 };
  assert.equal(validQuestion(q), true);
  assert.equal(validQuestion({ ...q, blankCount: 0 }), false);
  assert.equal(validQuestion({ ...q, blankCount: 11 }), false);
  assert.equal(validQuestion({ ...q, options: ['干扰项'] }), false);
  assert.ok(validateAnswer(fillAnswer, q, '', 'knowledge'));
  for (const bad of [{ texts: [] }, { texts: [''] }, { texts: ['一个', '两个'] }, { texts: [4] }, { indices: [0] }, { texts: ['a'.repeat(501)] }]) assert.equal(validateAnswer({ ...fillAnswer, ...bad }, q, '', 'knowledge'), null);
});
test('填空结果不完整或超出输入框长度时不提交', async () => {
  for (const response of [{ ...fillAnswer, texts: [] }, { ...fillAnswer, texts: [''] }, fillAnswer]) {
    const { helper, dom } = fixture(fillQuiz.replace('type="text"', 'type="text" maxlength="2"'), async () => response);
    let count = 0; dom.window.document.querySelector('[role="dialog"] button').onclick = () => count++;
    await helper.tick(); assert.equal(helper.state, 'paused'); assert.equal(count, 0);
  }
});
test('填空响应到来前暂停，不填写答案', async () => {
  let finish;
  const { helper, dom } = fixture(fillQuiz, () => new Promise(resolve => { finish = resolve; }));
  const run = helper.tick(); helper.pause(); finish(fillAnswer); await run;
  assert.equal(dom.window.document.querySelector('[role="dialog"] input').value, '');
});
test('不覆盖用户已有的不同填空答案', async () => {
  const { helper, dom } = fixture(fillQuiz, async () => fillAnswer);
  const input = dom.window.document.querySelector('[role="dialog"] input'); input.value = '用户输入';
  await helper.tick(); assert.equal(helper.state, 'paused'); assert.equal(input.value, '用户输入');
});
test('模型无需返回置信度和解题说明即可直接填写提交', async () => {
  const direct = { abstain: false, indices: [], texts: ['通信子网'], evidence: '', reason: '' };
  const { helper, dom } = fixture(fillQuiz, question => solve(question, '', {
    apiKey: 'test', model: 'deepseek-flash', provider: 'deepseek', fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal('confidence' in body.text.format.schema.properties, false);
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(direct) }] }] }) };
    }
  }));
  const root = dom.window.document.querySelector('[role="dialog"]'); let count = 0;
  root.oninput = () => { root.querySelector('button').disabled = false; };
  root.querySelector('button').onclick = () => count++;
  await helper.tick(); assert.equal(count, 1); assert.equal(root.querySelector('input').value, '通信子网');
});
test('同页自动切换视频后更新面板、清空旧题状态并保持运行', async () => {
  const { helper, dom } = fixture();
  await helper.tick();
  const oldKey = helper.key;
  helper.pending = { id: 'old-question' }; helper.navigation = Date.now(); helper.retries = 3;
  const nextVideo = dom.window.document.createElement('video'); nextVideo.src = 'https://media.example/v2.mp4';
  Object.defineProperties(nextVideo, { readyState: { value: 4 }, duration: { value: 200 }, currentTime: { value: 5, writable: true }, paused: { value: false } });
  nextVideo.pause = () => {}; nextVideo.play = async () => {};
  dom.window.document.querySelector('video').replaceWith(nextVideo);
  dom.window.document.body.insertAdjacentHTML('beforeend', '<div role="tablist"><button role="tab" aria-selected="true"><span title="第二视频">第二视频</span></button></div>');
  let renders = 0; helper.render = () => renders++;
  await helper.tick();
  assert.equal(helper.state, 'running'); assert.equal(helper.video, nextVideo);
  assert.notEqual(helper.key, oldKey); assert.equal(helper.title, '第二视频');
  assert.equal(nextVideo.playbackRate, 2);
  assert.equal(helper.pending, null); assert.equal(helper.navigation, null); assert.equal(helper.retries, 0); assert.ok(renders > 0);
});
test('复用video时src属性更新早于currentSrc也能识别新视频', async () => {
  const { helper, video } = fixture(); await helper.tick(); const before = helper.key;
  Object.defineProperty(video, 'currentSrc', { value: 'https://media.example/v1.mp4' });
  video.setAttribute('src', 'https://media.example/v2.mp4');
  await helper.tick(); assert.notEqual(helper.key, before); assert.ok(helper.key.endsWith('/v2.mp4'));
});
test('页面跳转保留运行意图，新页面无需再点开始', async () => {
  const { helper, dom } = fixture();
  helper.start(); await Promise.resolve(); helper.suspend();
  assert.equal(helper.storage.getItem(helper.runKey), 'running');
  dom.reconfigure({ url: 'https://www.icourse163.org/mooc/learn/NJUPT-1001639008/content/2?tid=2' });
  const next = new helper.constructor(dom.window.document, helper.storage, async () => answer, { token: 'test' });
  assert.equal(next.runKey, helper.runKey); next.resumeSession();
  assert.equal(next.state, 'running'); assert.ok(next.logs.some(s => s.includes('自动继续')));
});
test('手动暂停或停止后页面切换不自动启动', async () => {
  for (const action of ['pause', 'stop']) {
    const { helper, dom } = fixture(); helper.start(); await Promise.resolve(); helper[action](); helper.suspend();
    const next = new helper.constructor(dom.window.document, helper.storage, async () => answer);
    next.resumeSession(); assert.equal(next.state, 'stopped');
  }
});
test('运行状态不跨课程学期恢复', async () => {
  const { helper, dom } = fixture(); helper.start(); await Promise.resolve(); helper.suspend();
  dom.reconfigure({ url: 'https://www.icourse163.org/mooc/learn/NJUPT-1001639008/content/2?tid=999' });
  const next = new helper.constructor(dom.window.document, helper.storage, async () => answer);
  next.resumeSession(); assert.equal(next.state, 'stopped');
});
test('暂停中也刷新新视频信息，但不恢复播放', async () => {
  const { helper, video, plays } = fixture(); await helper.tick(); helper.pause();
  const before = plays(); video.setAttribute('src', 'https://media.example/new.mp4'); video.currentTime = 8;
  let shown; helper.render = () => { shown = helper.video?.currentTime; };
  await helper.tick(); assert.equal(shown, 8); assert.equal(helper.state, 'paused'); assert.equal(plays(), before);
});
test('视频切换时旧题延迟响应不得提交到新视频', async () => {
  let finish;
  const { helper, video, dom } = fixture(quiz, () => new Promise(resolve => { finish = resolve; }));
  const run = helper.tick(); video.setAttribute('src', 'https://media.example/another.mp4');
  finish(answer); await run;
  assert.equal(helper.state, 'running'); assert.equal(dom.window.document.querySelector('input:checked'), null);
});
test('加载中和等待模型时也刷新面板，保留正在执行的任务锁', async () => {
  let finish;
  const { helper, video } = fixture(quiz, () => new Promise(resolve => { finish = resolve; }));
  let renders = 0; helper.render = () => renders++;
  const task = helper.tick(); video.currentTime = 23;
  await helper.tick(); assert.equal(helper.busy, true); assert.ok(renders > 0);
  helper.pause(); finish(answer); await task; assert.equal(helper.busy, false);
});
test('填写另一课程视频链接后识别目标课程和学期', async () => {
  const { helper, dom } = fixture();
  const target = 'https://www.icourse163.org/mooc/learn/OTHER-123456/content/98765?tid=888';
  assert.equal(helper.setCourseUrl(target), target);
  assert.equal(helper.courseAllowed(), false);
  dom.reconfigure({ url: target });
  const next = new helper.constructor(dom.window.document, helper.storage, async () => answer, helper.config);
  assert.equal(next.courseAllowed(), true); next.start(); await Promise.resolve();
  assert.equal(next.state, 'running'); assert.equal(next.config.token, 'test'); assert.equal(next.video.playbackRate, 2);
});
test('带学期的课程介绍链接规范化为课件入口，无学期保留介绍页', () => {
  const { helper } = fixture();
  assert.equal(helper.setCourseUrl(' https://icourse163.org/course/OTHER-123456?tid=888&utm_source=example '), 'https://www.icourse163.org/mooc/learn/OTHER-123456/content?tid=888');
  assert.equal(helper.setCourseUrl('https://www.icourse163.org/course/OTHER-123456'), 'https://www.icourse163.org/course/OTHER-123456');
});
test('拒绝第三方地址、脚本地址及测验页面', () => {
  const { helper } = fixture();
  for (const link of ['javascript:alert(1)', 'http://www.icourse163.org/course/OTHER-123', 'https://www.icourse163.org.evil.example/course/OTHER-123', 'https://user:pass@www.icourse163.org/course/OTHER-123', 'https://www.icourse163.org/mooc/learn/OTHER-123/exams?tid=1', 'https://www.icourse163.org/course/OTHER-123?tid=abc']) assert.throws(() => helper.setCourseUrl(link));
  assert.equal(helper.config.courseUrl, '');
});
test('目标课程不匹配时不能播放或请求答案', async () => {
  let requests = 0;
  const { helper, plays } = fixture(quiz, async () => { requests++; return answer; });
  helper.config.courseUrl = 'https://www.icourse163.org/course/OTHER-123456?tid=2';
  await helper.tick(); assert.equal(helper.state, 'paused'); assert.equal(plays(), 0); assert.equal(requests, 0);
});
test('同一目标课程可换视频，不能跨指定学期或进入测验自动操作', () => {
  const { helper, dom } = fixture();
  helper.config.courseUrl = 'https://www.icourse163.org/mooc/learn/NJUPT-1001639008/content?tid=2';
  dom.reconfigure({ url: 'https://www.icourse163.org/mooc/learn/NJUPT-1001639008/content/999?tid=2' });
  assert.equal(helper.courseAllowed(), true);
  dom.reconfigure({ url: 'https://www.icourse163.org/mooc/learn/NJUPT-1001639008/content/999?tid=3' });
  assert.equal(helper.courseAllowed(), false);
  dom.reconfigure({ url: 'https://www.icourse163.org/mooc/learn/NJUPT-1001639008/assessments?tid=2' });
  assert.equal(helper.courseAllowed(), false);
});
test('旧配置1倍速不会覆盖运行时固定2倍速', async () => {
  const { helper, dom, video } = fixture();
  const next = new helper.constructor(dom.window.document, helper.storage, async () => answer, { playbackRate: 1 });
  next.state = 'running'; await next.tick();
  assert.equal(next.config.playbackRate, 2); assert.equal(video.playbackRate, 2);
});
test('未找到播放器显示未确认，不用目标值冒充实际值', () => {
  const { helper } = fixture();
  assert.match(helper.rateStatus(), /未确认/); assert.doesNotMatch(helper.rateStatus(), /读数2/);
});
test('等待模型期间播放器重置倍速，事件仍恢复2倍速', async () => {
  const { helper, dom, video } = fixture(); await helper.tick(); helper.busy = true;
  video.playbackRate = 1; video.dispatchEvent(new dom.window.Event('ratechange'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(video.playbackRate, 2); helper.busy = false; helper.stop();
});
test('加载和开始播放事件恢复倍速，暂停停止时不强制修改', async () => {
  for (const event of ['loadedmetadata', 'playing']) {
    const { helper, dom, video } = fixture(); await helper.tick();
    video.playbackRate = 1; video.dispatchEvent(new dom.window.Event(event));
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(video.playbackRate, 2);
    helper.pause(); video.playbackRate = 1.5; video.dispatchEvent(new dom.window.Event(event));
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(video.playbackRate, 1.5);
    helper.stop(); video.playbackRate = 1; await helper.tick(); assert.equal(video.playbackRate, 1);
  }
});
test('切换新播放器后移除旧播放器倍速监听', async () => {
  const { helper, dom, video } = fixture(); await helper.tick();
  const next = video.cloneNode(); next.pause = () => {}; video.replaceWith(next); helper.selectVideo();
  video.playbackRate = 1; video.dispatchEvent(new dom.window.Event('ratechange'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(video.playbackRate, 1); assert.equal(helper.rateBinding.video, next);
  helper.stop();
});
test('实际计时区分1倍速和2倍速，不把属性值当作测量结果', async () => {
  const { helper, video } = fixture(); await helper.tick();
  await new Promise(resolve => setTimeout(resolve, 10));
  let now = 0; helper.now = () => now; helper.resetRateMeasurement();
  helper.measureRate(video); now = 3000; video.currentTime = 6; helper.measureRate(video);
  assert.equal(helper.measuredRate, 2); assert.match(helper.rateStatus(), /实测约2\.00/);
  now = 6000; video.currentTime = 9; helper.measureRate(video);
  assert.equal(video.playbackRate, 2); assert.match(helper.rateStatus(), /读数2倍速.*实测约1\.00/);
  helper.stop(); assert.equal(helper.measuredRate, null);
});
test('播放器拒绝设置时显示真实1倍速和未确认原因', async () => {
  const { helper, video } = fixture();
  Object.defineProperty(video, 'playbackRate', { get: () => 1, set: () => {} });
  await helper.tick();
  assert.match(helper.rateStatus(), /读数1倍速/); assert.match(helper.rateStatus(), /未确认/);
  assert.doesNotMatch(helper.rateStatus(), /读数2倍速/); helper.stop();
});
