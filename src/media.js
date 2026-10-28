import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const FFMPEG = process.env.FFMPEG_PATH || (await import('ffmpeg-static')).default;
export const FFPROBE = process.env.FFPROBE_PATH || (await import('ffprobe-static')).default.path;

export class MediaError extends Error {}

export function mediaFile(message) {
  if (message.voice) return { kind: 'audio', file: message.voice };
  if (message.audio) return { kind: 'audio', file: message.audio };
  if (message.video) return { kind: 'video', file: message.video };
  if (message.video_note) return { kind: 'video', file: message.video_note };
  if (message.animation) return { kind: 'video', file: message.animation };
  if (message.photo?.length) return { kind: 'image', file: message.photo.at(-1) };
  return null;
}

export function validateMedia({ kind, file }) {
  if (file.file_size > 20 * 1024 * 1024) throw new MediaError('файл больше 20 мб сожми и пришли заново');
  if (kind === 'video' && file.duration > 120) throw new MediaError('видео длиннее двух минут скинь кусок до 120 секунд');
  if (kind === 'audio' && file.duration > 600) throw new MediaError('аудио длиннее десяти минут давай частями');
}

export function runMedia(executable, args, timeout = 30000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new MediaError('медиа слишком тяжёлое попробуй сжать')); }, timeout);
    child.stdout.on('data', chunk => { if (output.length < 200000) output += chunk.toString(); });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new MediaError('инструменты медиа недоступны проверь установку ffmpeg')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolvePromise(output) : reject(new MediaError('не смогла разобрать файл пришли обычное видео или голосовое')); });
  });
}

export async function withMediaTemp(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'aisylu-media-'));
  try { return await fn(directory); }
  finally {
    const target = resolve(directory);
    const prefix = resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/');
    if (!target.startsWith(prefix) || !target.slice(prefix.length).startsWith('aisylu-media-')) throw new Error('небезопасный временный путь');
    await rm(target, { recursive: true, force: true });
  }
}

export async function prepareMediaBytes(bytes, descriptor) {
  validateMedia(descriptor);
  if (descriptor.kind === 'image') return [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }];
  return withMediaTemp(async directory => {
    const input = join(directory, 'input');
    await writeFile(input, bytes);
    const metadata = JSON.parse(await runMedia(FFPROBE, ['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json', input]));
    const duration = Number(metadata.format?.duration);
    const max = descriptor.kind === 'video' ? 120 : 600;
    if (!Number.isFinite(duration) || duration <= 0) throw new MediaError('не удалось проверить длительность файла');
    if (duration > max) throw new MediaError(descriptor.kind === 'video' ? 'видео длиннее двух минут скинь кусок до 120 секунд' : 'аудио длиннее десяти минут давай частями');
    const parts = [];
    if (descriptor.kind === 'video') {
      if (!metadata.streams?.some(s => s.codec_type === 'video')) throw new MediaError('в файле нет видеодорожки');
      await runMedia(FFMPEG, ['-nostdin','-v','error','-threads','1','-filter_threads','1','-protocol_whitelist','file,pipe','-i',input,'-an','-vf','fps=1/4,scale=640:640:force_original_aspect_ratio=decrease','-frames:v','30','-threads','1','-q:v','4',join(directory,'frame-%03d.jpg')]);
      const frames = (await readdir(directory)).filter(name => name.startsWith('frame-')).sort();
      if (!frames.length) {
        await runMedia(FFMPEG, ['-nostdin','-v','error','-threads','1','-filter_threads','1','-protocol_whitelist','file,pipe','-i',input,'-frames:v','1','-vf','scale=640:640:force_original_aspect_ratio=decrease','-threads','1',join(directory,'frame-001.jpg')]);
        frames.push('frame-001.jpg');
      }
      parts.push({ type: 'text', text: `Видео длится ${duration.toFixed(1)} секунд. Ниже выборка кадров по порядку с интервалом около 4 секунд и полная аудиодорожка если она есть. Можешь пропустить быстрое событие между кадрами не выдумывай детали.` });
      for (const name of frames) parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${(await readFile(join(directory,name))).toString('base64')}` } });
    }
    if (metadata.streams?.some(s => s.codec_type === 'audio')) {
      const audio = join(directory, 'audio.mp3');
      await runMedia(FFMPEG, ['-nostdin','-v','error','-threads','1','-filter_threads','1','-protocol_whitelist','file,pipe','-i',input,'-vn','-ac','1','-ar','16000','-b:a','48k','-threads','1',audio]);
      parts.push({ type: 'input_audio', input_audio: { data: (await readFile(audio)).toString('base64'), format: 'mp3' } });
    } else if (descriptor.kind === 'audio') throw new MediaError('в файле нет аудиодорожки');
    else parts.push({ type: 'text', text: 'В видео нет аудиодорожки. Не утверждай что слышала речь.' });
    return parts;
  });
}

export async function prepareMedia(telegram, message) {
  const descriptor = mediaFile(message);
  if (!descriptor) return [];
  validateMedia(descriptor);
  return prepareMediaBytes(await telegram.download(descriptor.file), descriptor);
}
