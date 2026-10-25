// Additive ShopDesk exploration extension. All output stays under userData/finance.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function createFinanceExtension({app, current, safeURL, close}) {
  const states = new Map();
  const root = path.join(app.getPath('userData'), 'business-data', 'finance');
  function folder(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid exploration id');
    const out = path.join(root, id); fs.mkdirSync(out, {recursive:true}); return out;
  }
  function cleanup(id) {
    const state = states.get(id);
    if (state?.listener) state.session.removeListener('will-download', state.listener);
    if (state?.timer) clearTimeout(state.timer);
    for (const item of state?.handles || []) {try{if (!item.isDone()) item.cancel()}catch{}}
    states.delete(id);
  }
  async function command(id, method, params={}) {
    const owner = current(id);
    if (!owner || owner.id !== id) throw Error('Finance exploration is not owned or expired');
    const wc = owner.window.webContents;
    if (method === 'finance_capabilities') return {version:3,capture:true,downloads:true,download_report:true,owned_close:true};
    if (method === 'finance_close') { cleanup(id); close({id}); return {closed:true}; }
    // Page.navigate/Runtime.evaluate remain subject to the original bridge allowlist.
    if (method === 'finance_capture') {
      safeURL(wc.getURL(),owner.shop);
      owner.window.setContentSize?.(1920,1080);
      // A hidden renderer/GPU can leave capturePage pending indefinitely. Bound
      // it so one screenshot cannot block the bridge's serial request queue.
      let deadline;
      const image = await Promise.race([
        wc.capturePage(),
        new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('Finance screenshot timed out')),8000)}),
      ]).finally(()=>clearTimeout(deadline));
      const output = path.join(folder(id), 'capture-'+randomUUID()+'.png');
      fs.writeFileSync(output,image.toPNG());
      return {path:output,shop_id:owner.shop.id,captured_at:new Date().toISOString(),
              width:image.getSize().width,height:image.getSize().height};
    }
    if (method === 'finance_arm_download') {
      cleanup(id);
      const state={session:wc.session,items:[],handles:[],timer:null,listener:null};
      state.listener = (_event,item,source) => {
        if (!source || source.id !== wc.id) return;
        const name=path.basename(item.getFilename()).replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');
        const ext=path.extname(name).toLowerCase();
        if (!['.xlsx','.csv','.zip','.xls','.tsv'].includes(ext)) { item.cancel(); return; }
        const output=path.join(folder(id), randomUUID()+'-'+name);
        const record={id:randomUUID(),name,path:output,state:'progressing',received:0,total:item.getTotalBytes()};
        state.items.push(record);state.handles.push(item);item.setSavePath(output);
        item.on('updated',()=>{record.received=item.getReceivedBytes()});
        item.once('done',(_e,result)=>{
          record.state=result;record.received=item.getReceivedBytes();
          if (result!=='completed') {try{fs.unlinkSync(output)}catch{}}
        });
      };
      wc.session.on('will-download',state.listener);
      state.timer=setTimeout(()=>cleanup(id),180000);state.timer.unref?.();states.set(id,state);
      return {armed:true};
    }
    if (method === 'finance_download_report') {
      if (!states.has(id)) throw Error('Arm the owned download listener first');
      const downloadId=String(params.download_id||'');
      if (!/^DL[0-9]{16,40}$/.test(downloadId)) throw Error('Invalid official report ID');
      safeURL(wc.getURL(),owner.shop);
      // The signed URL remains inside Electron; Python only sees file progress and paths.
      const script='(async()=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),6000);try{'+
        'const r=await fetch("/settlement/settlement/downloadFileFromId?download_id="+'+JSON.stringify(downloadId)+
        ',{credentials:"include",signal:c.signal});const j=await r.json();'+
        'if(!r.ok||j.code!==0||!j.data?.url)throw Error("Official file link unavailable");return j.data.url;'+
        '}finally{clearTimeout(t)}})()';
      const signedURL=await wc.executeJavaScript(script);
      const target=new URL(signedURL);
      if(target.protocol!=='https:'||!/^lf[0-9]+-tos-bill-center-sign\.bytetos\.com$/.test(target.hostname))
        throw Error('Unverified official file host');
      wc.downloadURL(signedURL);
      return {started:true,download_id:downloadId};
    }
    if (method === 'finance_downloads') return {items:states.get(id)?.items || []};
    if (method === 'finance_finish_download') { const items=states.get(id)?.items || []; cleanup(id);return {items}; }
    throw Error('Unsupported finance extension command');
  }
  return {command,cleanup};
}
module.exports={createFinanceExtension};
