const fs = require('node:fs');
const {randomUUID}=require('node:crypto');
function valid(input) {
 const name=String(input.name||'').trim(); if(!name || name.length>80) throw Error('店铺名称须为 1–80 个字');
 let u; try{u=new URL(input.url)}catch{throw Error('请输入完整的 HTTPS 店铺后台网址')}
 if(u.protocol!=='https:' || u.username || u.password) throw Error('请使用不包含账号密码的 HTTPS 网址');
 return {name,url:u.href,platform:String(input.platform||'自定义').trim().slice(0,40)||'自定义',group:String(input.group||'未分组').trim().slice(0,40)||'未分组',note:String(input.note||'').slice(0,500)};
}
class Store {
 constructor(file){this.file=file;this.items=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];if(!Array.isArray(this.items))throw Error('店铺数据格式错误');}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.items,null,2),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file)}
 get(id){const s=this.items.find(x=>x.id===id);if(!s)throw Error('店铺不存在');return s}
 upsert(data){const fields=valid(data);if(data.id){Object.assign(this.get(data.id),fields)}else{this.items.push({...fields,id:randomUUID(),favorite:false,createdAt:Date.now(),lastOpened:null})}this.save();return this.items}
}
module.exports={Store,valid};
