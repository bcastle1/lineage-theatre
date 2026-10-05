import {createHash} from 'node:crypto';
import {readRecord,writeRecord} from './auth.mjs';
import {createQuickBooksAccountingTransport} from './quickbooks.mjs';
import {readFinanceResponse} from './patrick-quickbooks.mjs';
import {validateQboWriteArguments,validateQboFile,QBO_WRITE_NAMES,qboPlain,qboUuid,qboId,qboFail as fail} from './pac-quickbooks-write-contract.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):qboPlain(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const key=id=>`integrations/quickbooks/pac-operations/${id}.json`;
const publicResult=row=>({source:'QuickBooks Online',operation_id:row.operation_id,action_digest:row.action_digest,state:row.state,read_only:false,
  ...(row.receipt?{receipt:row.receipt}:{}),...(row.error_code?{error_code:row.error_code}:{}),updated_at:row.updated_at});
async function bounded(response){
  const reader=response.body?.getReader();if(!reader)fail('QBO_RESPONSE_INVALID');let count=0;const chunks=[];
  for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>120000){await reader.cancel();fail('QBO_RESULT_TOO_LARGE');}chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createPacQuickBooksWrite({env=process.env,transport=createQuickBooksAccountingTransport({env,pacFinanceWrite:true}),read=readRecord,write=writeRecord,now=Date.now}={}){
  const stamp=()=>new Date(now()).toISOString();
  async function company(){
    const realm=env.PAC_QUICKBOOKS_REALM_ID;if(!qboId(realm))fail('QBO_SETUP_REQUIRED');
    const {binding}=await transport.readiness();if(binding.environment!=='production'||binding.realmId!==realm)fail('QBO_COMPANY_MISMATCH');
    const result=await readFinanceResponse(await transport.request(binding,{method:'GET',path:`/companyinfo/${realm}`}));
    if(String(result.data.CompanyInfo?.CompanyName??'').toLowerCase().replace(/[^a-z0-9]/g,'')!=='brocotech')fail('QBO_COMPANY_MISMATCH');
    return binding;
  }
  async function recordRead(binding,entity,id){
    const result=await readFinanceResponse(await transport.request(binding,{method:'GET',entity,path:`/${entity.toLowerCase()}/${id}`}));
    const row=result.data[entity];if(!qboPlain(row)||row.Id!==id||!qboId(row.SyncToken))fail('QBO_RESPONSE_INVALID');return row;
  }
  async function save(row,etag){await write(key(row.operation_id),row,etag);return publicResult(row);}
  async function verifyReceipt(record,binding){
    const row=record.value,r=row.receipt;
    if(row.binding.grantId!==binding.grantId||row.binding.realmId!==binding.realmId||row.binding.environment!==binding.environment)fail('QBO_COMPANY_MISMATCH');
    const verified=await recordRead(binding,r.entity,r.entity_id);
    if(r.entity==='Attachable'&&(verified.FileName!==r.file_name||verified.ContentType!==r.media_type||verified.Size!==r.size_bytes
      ||!verified.AttachableRef?.some(ref=>ref.EntityRef?.type===r.target_entity&&ref.EntityRef.value===r.target_id)))return publicResult(row);
    return save({...row,state:'succeeded',error_code:undefined,receipt:{...r,readback_at:stamp()},updated_at:stamp()},record.etag);
  }
  return {
    async status(input){
      const args=validateQboWriteArguments('quickbooks_operation_status',input),record=await read(key(args.operation_id));
      if(!record||record.value.action_digest!==args.action_digest)fail('QBO_OPERATION_NOT_FOUND');
      if(record.value.state==='pending_verification'){
        try{return await verifyReceipt(record,await company());}catch{return publicResult(record.value);}
      }
      return publicResult(record.value);
    },
    async readiness(){await company();return {source:'QuickBooks Online',read_only:true,connected:true,write_adapter_available:true,live_write_verified:false,checked_at:stamp()};},
    async execute(input){
      if(!qboPlain(input)||Object.keys(input).some(k=>!['name','arguments','operation_id','action_digest','file'].includes(k))||!qboUuid(input.operation_id)||!/^[a-f0-9]{64}$/.test(input.action_digest)||!QBO_WRITE_NAMES.includes(input.name))fail('QBO_ARGUMENTS_INVALID');
      const args=validateQboWriteArguments(input.name,input.arguments);
      if(input.name==='quickbooks_attach'){
        validateQboFile(input.file);if(hash(Buffer.from(input.file.base64,'base64'))!==input.file.sha256)fail('QBO_ATTACHMENT_INVALID');
      }else if(input.file!==undefined)fail('QBO_ARGUMENTS_INVALID');
      const digest=hash(JSON.stringify(canonical({name:input.name,arguments:args,...(input.file?{file:input.file}:{})})));
      const existing=await read(key(input.operation_id));
      if(existing){if(existing.value.action_digest!==input.action_digest||existing.value.input_digest!==digest)fail('QBO_OPERATION_CONFLICT');return publicResult(existing.value);}
      const binding=await company();
      if(args.id){const current=await recordRead(binding,args.entity,args.id);if(args.expected_version!==undefined&&current.SyncToken!==args.expected_version)fail('QBO_VERSION_CONFLICT');}
      const row={operation_id:input.operation_id,action_digest:input.action_digest,input_digest:digest,binding,state:'outcome_unknown',updated_at:stamp(),error_code:'QBO_WRITE_UNCONFIRMED'};
      // A crash from this point onward must not permit another provider POST.
      try{await write(key(input.operation_id),row);}catch{
        const raced=await read(key(input.operation_id));if(!raced)throw Error('QBO_RECEIPT_UNAVAILABLE');
        if(raced.value.input_digest!==digest||raced.value.action_digest!==input.action_digest)fail('QBO_OPERATION_CONFLICT');return publicResult(raced.value);
      }
      const claimed=await read(key(input.operation_id));if(!claimed||claimed.value.input_digest!==digest)fail('QBO_RECEIPT_UNAVAILABLE');
      let result;
      try{
        const op=input.name==='quickbooks_attach'?{method:'POST',path:'/upload',entity:args.entity,targetId:args.id,body:input.file,requestId:input.operation_id}
          :{method:'POST',path:`/${args.entity.toLowerCase()}`,entity:args.entity,body:{...args.data,...(args.id?{Id:args.id,SyncToken:args.expected_version,sparse:true}:{})},requestId:input.operation_id};
        const response=await transport.request(binding,op);
        if(!response.ok&&[400,401,403,404,422,429].includes(response.status)){
          let data;try{data=await bounded(response)}catch{}
          const stale=data?.Fault?.Error?.some(e=>String(e.code)==='5010');
          return save({...row,state:'failed',error_code:stale?'QBO_VERSION_CONFLICT':response.status===429?'QBO_RATE_LIMITED':[401,403].includes(response.status)?'QBO_ACCESS_DENIED':'QBO_REQUEST_REJECTED',updated_at:stamp()},claimed.etag);
        }
        if(!response.ok){await response.body?.cancel();return publicResult(row);}
        result=await bounded(response);
        const entity=input.name==='quickbooks_attach'?'Attachable':args.entity;
        const record=entity==='Attachable'?result?.AttachableResponse?.[0]?.Attachable:result?.[entity];
        if(result?.Fault||!qboPlain(record)||!qboId(record.Id)||!qboId(record.SyncToken)||args.id&&entity!=='Attachable'&&record.Id!==args.id)return publicResult(row);
        const receipt={entity,entity_id:record.Id,version:record.SyncToken,accepted_at:stamp(),...(input.file?{sha256:input.file.sha256,target_entity:args.entity,target_id:args.id,file_name:input.file.name,media_type:input.file.media_type,size_bytes:Buffer.from(input.file.base64,'base64').length}:{} )};
        const accepted={...row,state:'pending_verification',receipt,error_code:'QBO_READBACK_PENDING',updated_at:stamp()};
        await save(accepted,claimed.etag);
        const pending=await read(key(input.operation_id));
        return await verifyReceipt(pending,binding);
      }catch{
        // Do not turn an interrupted POST or receipt write into a safe-to-retry error.
        const latest=await read(key(input.operation_id));return publicResult(latest?.value??row);
      }
    }
  };
}
