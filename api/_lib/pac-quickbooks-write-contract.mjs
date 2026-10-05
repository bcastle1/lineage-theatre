// Shared with the MCP Worker. Provider fields are bounded data, never URLs or SQL.
export const QBO_WRITE_ENTITIES=Object.freeze(['Account','Bill','BillPayment','Class','CreditMemo','Customer','Department','Deposit','Estimate','Invoice','Item','JournalEntry','Payment','Purchase','PurchaseOrder','RefundReceipt','SalesReceipt','Term','TimeActivity','Transfer','Vendor','VendorCredit']);
export const QBO_ATTACHMENT_MAX_BYTES=3*1024*1024;
export const QBO_WRITE_NAMES=Object.freeze(['quickbooks_create','quickbooks_update','quickbooks_attach']);
export const QBO_WRITE_READ_NAMES=Object.freeze(['quickbooks_write_status','quickbooks_operation_status']);
export const QBO_WRITE_ALL_NAMES=Object.freeze([...QBO_WRITE_NAMES,...QBO_WRITE_READ_NAMES]);
export const qboFail=code=>{throw new Error(code)};
export const qboPlain=value=>value&&Object.getPrototypeOf(value)===Object.prototype;
export const qboId=value=>typeof value==='string'&&/^\d{1,30}$/.test(value);
export const qboUuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const fields=(value,keys)=>qboPlain(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
function boundedData(value,depth=0){
  if(depth>12)qboFail('QBO_ARGUMENTS_INVALID');
  if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
  if(typeof value==='string'&&value.length<=16000&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))return;
  if(Array.isArray(value)&&value.length<=750){value.forEach(v=>boundedData(v,depth+1));return;}
  if(qboPlain(value)&&Object.keys(value).length<=100){for(const [k,v] of Object.entries(value)){if(!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(k)||['constructor','prototype','__proto__'].includes(k))qboFail('QBO_ARGUMENTS_INVALID');boundedData(v,depth+1);}return;}
  qboFail('QBO_ARGUMENTS_INVALID');
}
export function validateQboWriteArguments(name,args){
  const keys={quickbooks_create:['entity','data'],quickbooks_update:['entity','id','expected_version','data'],quickbooks_attach:['entity','id','file_id','file_version'],quickbooks_write_status:[],quickbooks_operation_status:['operation_id','action_digest']}[name];
  if(!keys||!fields(args,keys))qboFail('QBO_ARGUMENTS_INVALID');
  if(args.entity!==undefined&&!QBO_WRITE_ENTITIES.includes(args.entity))qboFail('QBO_ENTITY_INVALID');
  if(args.id!==undefined&&!qboId(args.id))qboFail('QBO_ARGUMENTS_INVALID');
  if(args.expected_version!==undefined&&!qboId(args.expected_version))qboFail('QBO_ARGUMENTS_INVALID');
  if(args.data!==undefined){
    if(!qboPlain(args.data)||!Object.keys(args.data).length||['Id','SyncToken','sparse','MetaData','domain','status'].some(k=>Object.hasOwn(args.data,k))||JSON.stringify(args.data).length>64000)qboFail('QBO_ARGUMENTS_INVALID');
    boundedData(args.data);
  }
  for(const key of ['file_id','file_version'])if(args[key]!==undefined&&(typeof args[key]!=='string'||!args[key].length||args[key].length>512||/[\x00-\x1f\x7f]/.test(args[key])))qboFail('QBO_ARGUMENTS_INVALID');
  if(args.operation_id!==undefined&&(!qboUuid(args.operation_id)||!/^([a-f0-9]{64})$/.test(args.action_digest)))qboFail('QBO_ARGUMENTS_INVALID');
  return structuredClone(args);
}
export function validateQboFile(file){
  if(!fields(file,['name','media_type','base64','sha256'])||typeof file.name!=='string'||!file.name.length||file.name.length>200||/[\\/\x00-\x1f\x7f]/.test(file.name)
    ||!['application/pdf','image/png','image/jpeg','image/gif','text/plain','text/csv','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(file.media_type)
    ||typeof file.base64!=='string'||!file.base64.length||file.base64.length>Math.ceil(QBO_ATTACHMENT_MAX_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)
    ||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))qboFail('QBO_ATTACHMENT_INVALID');
  return file;
}
