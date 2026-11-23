import http from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { solve, modelConfig, validQuestion } from './solver.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const ai = modelConfig();
ai.answerMode = process.env.ANSWER_MODE || 'knowledge';
if (!['knowledge', 'materials'].includes(ai.answerMode)) throw new Error('ANSWER_MODE 仅支持 knowledge 或 materials');
const configFile = path.join(root, 'helper.local.json');
let config;
try { config = JSON.parse(await readFile(configFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  config = { token: randomBytes(32).toString('hex') };
  await writeFile(configFile, JSON.stringify(config, null, 2), { flag: 'wx' });
}
if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('helper.local.json 中 token 无效');
await mkdir(path.join(root, 'materials'), { recursive: true });
const cache = new Map();
let busy = false;
const server = http.createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (req.headers.host !== '127.0.0.1:17363') return send(403, { error: 'Invalid host' });
  const auth = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${config.token}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(401, { error: '本地 token 不匹配' });
  if (req.method !== 'POST' || req.url !== '/solve') return send(404, { error: 'Not found' });
  if (busy) return send(429, { error: '已有题目正在处理' });
  busy = true;
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 32000) { send(413, { error: '题目过长' }); return; } }
    const q = JSON.parse(body);
    if (!validQuestion(q)) return send(400, { error: '题目结构不受支持' });
    const dir = path.join(root, 'materials');
    const files = (await readdir(dir)).filter(f => /\.(txt|md)$/i.test(f)).sort();
    const context = (await Promise.all(files.map(f => readFile(path.join(dir, f), 'utf8')))).join('\n\n');
    if (context.length > 120000) return send(400, { error: '课程资料超过12万字符，请仅保留当前章节' });
    const key = JSON.stringify([q, context, ai.provider, ai.model, ai.answerMode]);
    if (cache.has(key)) return send(200, cache.get(key));
    const answer = await solve(q, context, ai);
    if (!answer.abstain) { if (cache.size >= 100) cache.delete(cache.keys().next().value); cache.set(key, answer); }
    send(200, answer);
  } catch (error) { send(502, { error: error instanceof SyntaxError ? '无效的 JSON 响应或请求' : error.message }); }
  finally { busy = false; }
});
server.requestTimeout = 60000;
server.listen(17363, '127.0.0.1', () => console.log(`本地答题服务：http://127.0.0.1:17363\n将 ${configFile} 中的 token 填入油猴脚本设置。\n当前模型服务：${ai.provider}，模型：${ai.model || '未配置'}\n答题模式：${ai.answerMode === 'knowledge' ? '自身知识作答（课程资料可选）' : '仅依据课程资料'}\n密钥仅从对应服务的环境变量读取；不记录题目或密钥。`));
