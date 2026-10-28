import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FFMPEG, runMedia, withMediaTemp, prepareMediaBytes } from '../src/media.js';

test('video preprocessing produces real frames and a complete MP3 track', async () => {
  await withMediaTemp(async directory => {
    const path = join(directory,'fixture.mp4');
    await runMedia(FFMPEG,['-nostdin','-v','error','-f','lavfi','-i','color=c=red:s=160x120:d=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',path]);
    const parts = await prepareMediaBytes(await readFile(path),{ kind:'video',file:{ duration:4 } });
    const frames = parts.filter(p => p.type === 'image_url');
    assert.ok(frames.length >= 1 && frames.length <= 30);
    const image = Buffer.from(frames[0].image_url.url.split(',')[1],'base64');
    assert.equal(image.readUInt16BE(0),0xffd8);
    assert.ok(parts.some(p => p.type === 'input_audio' && p.input_audio.format === 'mp3'));
  });
});
test('Telegram OGG voice is converted to supported MP3 input', async () => {
  await withMediaTemp(async directory => {
    const path = join(directory,'fixture.ogg');
    await runMedia(FFMPEG,['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libopus',path]);
    const parts = await prepareMediaBytes(await readFile(path),{ kind:'audio',file:{ duration:1 } });
    assert.equal(parts.length,1);
    assert.equal(parts[0].type,'input_audio');
    assert.equal(parts[0].input_audio.format,'mp3');
    assert.ok(Buffer.from(parts[0].input_audio.data,'base64').length > 100);
  });
});
test('actual duration overrides Telegram metadata and blocks clips longer than 120 seconds', async () => {
  await withMediaTemp(async directory => {
    const path = join(directory,'long.mp4');
    await runMedia(FFMPEG,['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=16x16:r=1:d=121','-c:v','libx264','-pix_fmt','yuv420p',path]);
    await assert.rejects(prepareMediaBytes(await readFile(path),{ kind:'video',file:{ duration:1 } }),/двух минут/);
  });
});
test('damaged media is rejected without being sent to the model', async () => {
  await assert.rejects(prepareMediaBytes(Buffer.from('broken data'),{ kind:'audio',file:{ duration:1 } }),/разобрать файл/);
});
