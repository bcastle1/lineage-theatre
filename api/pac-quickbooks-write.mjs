import {createHash,timingSafeEqual} from 'node:crypto';
import {json,readBody,limitAction} from './_lib/auth.mjs';
import {audit} from './_lib/admin.mjs';
import {createPacQuickBooksWrite} from './_lib/pac-quickbooks-write.mjs';
const hash=s=>createHash('sha256').update(s).digest();
export function createPacQuickBooksWriteHandler({env=process.env,service=createPacQuickBooksWrite({env}),limiter=limitAction,auditImpl=audit}={}){
  return async function handler(req,res){
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return json(res,405,{error_code:'QBO_METHOD_INVALID'});
    const secret=env.PAC_QUICKBOOKS_WRITE_KEY;
    if(typeof secret!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(secret))return json(res,503,{error_code:'QBO_WRITE_NOT_CONFIGURED'});
    const auth=req.headers?.authorization;
    if(typeof auth!=='string'||auth.length>1024||!timingSafeEqual(hash(auth),hash(`Bearer ${secret}`)))return json(res,401,{error_code:'QBO_AUTHORIZATION_REQUIRED'});
    try{
      if(!await limiter('pac-quickbooks-write',40,60000))return json(res,429,{error_code:'QBO_RATE_LIMITED'});
      const body=await readBody(req,4250000);
      let result;
      if(body?.name==='quickbooks_write_status'&&JSON.stringify(body.arguments)==='{}'&&Object.keys(body).length===2)result=await service.readiness();
      else if(body?.name==='quickbooks_operation_status'&&Object.keys(body).length===2)result=await service.status(body.arguments);
      else result=await service.execute(body);
      // A log failure after a committed write cannot erase its durable receipt.
      try{await auditImpl('private-ai-core','quickbooks.accounting.operation',body.name,{operationId:result.operation_id??null,state:result.state??'checked'});}catch{}
      return json(res,200,result);
    }catch(error){
      const code=/^QBO_[A-Z_]+$/.test(error.message)?error.message:'QBO_CONNECTION_UNAVAILABLE';
      return json(res,/INVALID$/.test(code)?400:code==='QBO_VERSION_CONFLICT'||code==='QBO_OPERATION_CONFLICT'?409:503,{error_code:code});
    }
  };
}
export default createPacQuickBooksWriteHandler();
