import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { api, normalizeProductionPreparation, productionInputHash, productionPreparationInput, type Film, type PreparedProduction } from "./model";

type Prepared = { id:string; manifestHash:string; status:string; sceneCount:number; shotCount:number; durationSeconds:number; createdAt:string; issues:string[] };

export default function ProductionPreparation({film,operator=false,onPrepared,disabled=false}:{film?:Film;operator?:boolean;onPrepared?:(prepared:PreparedProduction)=>void;disabled?:boolean}) {
  const [consent,setConsent]=useState(false);
  const [localPrepared,setPrepared]=useState<PreparedProduction|null>(null);
  const prepared=operator?localPrepared:film?.productionPreparation || localPrepared;
  const [currentInputHash,setCurrentInputHash]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const lock=useRef(false);
  const request=useRef<{input:string;key:string}|null>(null);
  const input=useMemo(()=>operator?"fictional-operator-fixture":film?JSON.stringify(productionPreparationInput(film)):"",[film,operator]);
  useEffect(()=>{
    let active=true;setCurrentInputHash("");
    void productionInputHash(input).then(value=>{if(active)setCurrentInputHash(value);}).catch(()=>{});
    return()=>{active=false;};
  },[input]);
  async function prepare() {
    if(lock.current || disabled || (!operator && (!consent || !film))) return;
    lock.current=true;setBusy(true);setError("");
    try {
      const inputHash=await productionInputHash(input);
      if(request.current?.input!==input) request.current={input,key:prepared?.inputHash===inputHash?prepared.requestId:crypto.randomUUID()};
      const result=await api<Prepared>(operator?"/api/admin":"/api/studio",operator
        ?{action:"prepareProductionTest",idempotencyKey:request.current.key}
        :{action:"prepare",project:JSON.parse(input),preparationConsent:true,idempotencyKey:request.current.key});
      const saved=normalizeProductionPreparation({...result,inputHash,requestId:request.current.key});
      if(!saved) throw new Error("The saved production reference could not be verified. Retry this preparation request.");
      setPrepared(saved);if(!operator)onPrepared?.(saved);
    }catch(e){setError(e instanceof Error?e.message:"The production plan could not be prepared.");}
    finally{lock.current=false;setBusy(false);}
  }
  async function download() {
    if(!prepared || lock.current || disabled) return;
    lock.current=true;setBusy(true);setError("");
    try {
      const manifest=await api(`/api/studio?action=manifest&id=${encodeURIComponent(prepared.id)}`);
      const url=URL.createObjectURL(new Blob([JSON.stringify(manifest,null,2)],{type:"application/json"}));
      const link=document.createElement("a");link.href=url;link.download=`${operator?"SAMPLE-ONLY":"film"}-production-plan.json`;
      document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    }catch(e){setError(e instanceof Error?e.message:"The plan could not be downloaded.");}
    finally{lock.current=false;setBusy(false);}
  }
  return <section className="readiness-panel" aria-label={operator?"Production test preparation":"Prepare production plan"}>
    <h3>{operator?"Prepare a production test":"Prepare your production plan"}</h3>
    <p>{operator?"Use a fixed fictional screenplay to check private plan storage and download. This step does not send a render request or spend credits.":"Save a reviewed version of your screenplay and cast for production planning. This does not start rendering or take a payment."}</p>
    {!operator && <label className="check-label"><input type="checkbox" checked={consent} disabled={busy||disabled} onChange={e=>setConsent(e.target.checked)}/><span>Save this screenplay, cast, and production plan privately in Lineage Theatre with administrator access.</span></label>}
    <div className="action-group">
      <button className="button secondary small" disabled={busy||disabled||(!operator&&(!consent||!film?.scenes.length))} onClick={()=>void prepare()}>{busy?<Loader2 className="spin" size={16}/>:null}{operator?"Prepare fictional test plan":"Prepare production plan"}</button>
      {prepared && <button className="text-button" disabled={busy||disabled} onClick={()=>void download()}><Download size={15}/> Download prepared plan</button>}
    </div>
    {error && <p className="feedback error" role="alert">{error}</p>}
    {prepared && <div role="status"><p>Plan saved: {prepared.sceneCount} scenes, {prepared.shotCount} planned shots, {prepared.durationSeconds} seconds target.</p>
      <p className="field-note">Saved {new Date(prepared.createdAt).toLocaleString()}. {prepared.status==="prepared"?"Rendering has not started.":"Check your film's production status before starting another request."}</p>
      {currentInputHash && currentInputHash!==prepared.inputHash && <p className="feedback">Your screenplay has changed since this plan was saved. The download contains the saved version; prepare a new plan to include your edits.</p>}
      {prepared.issues.length>0 && <ul>{prepared.issues.map(issue=><li key={issue}>{issue}</li>)}</ul>}
    </div>}
  </section>;
}
