// Engine regression test: fake microphone plus a separate synthesized system track.
// Physical loopback routing and OS permission prompts remain hardware QA checks.
const {app,BrowserWindow,session}=require('electron');
const assert=require('node:assert/strict');
const http=require('node:http');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Recorder media regression</title>');});
let window;
const timeout=setTimeout(()=>{console.error('Media runtime timed out');app.exit(1)},30000);
app.whenReady().then(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 session.defaultSession.setPermissionRequestHandler((_contents,permission,callback)=>callback(permission==='media'));
 window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await window.loadURL(`http://127.0.0.1:${server.address().port}`);
 const result=await window.webContents.executeJavaScript(`(async()=>{
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  const context=new AudioContext();await context.resume();
  const oscillator=context.createOscillator();oscillator.frequency.value=440;
  const system=context.createMediaStreamDestination();oscillator.connect(system);oscillator.start();
  const mime=['audio/webm;codecs=opus','audio/webm'].find(m=>MediaRecorder.isTypeSupported(m));
  if(!mime)throw Error('WebM audio recording unavailable');
  async function record(stream){
   const recorder=new MediaRecorder(stream,{mimeType:mime});const chunks=[];
   recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
   const stopped=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=e=>reject(Error(e.error?.message||'encoding failed'))});
   recorder.start(100);await delay(350);recorder.pause();await delay(100);
   if(recorder.state!=='paused')throw Error('Pause did not hold');
   recorder.resume();await delay(350);recorder.stop();await stopped;
   const bytes=await new Blob(chunks,{type:mime}).arrayBuffer();
   const decoded=await context.decodeAudioData(bytes.slice(0));
   return {bytes:bytes.byteLength,chunks:chunks.length,duration:decoded.duration};
  }
  const tracks=await Promise.all([record(mic),record(system.stream)]);
  const room=await record(mic);
  oscillator.stop();mic.getTracks().forEach(t=>t.stop());system.stream.getTracks().forEach(t=>t.stop());await context.close();
  return {mime,tracks,room};
 })()`,true);
 for(const track of [...result.tracks,result.room]){assert.ok(track.bytes>100);assert.ok(track.chunks>=2);assert.ok(track.duration>0.4&&track.duration<2);}
 assert.equal(result.tracks.length,2);
 console.log(JSON.stringify({electron:process.versions.electron,platform:process.platform,...result}));
 clearTimeout(timeout);server.close();window.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timeout);server.close();app.exit(1)});
