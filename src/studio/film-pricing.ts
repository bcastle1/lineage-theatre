import {normalizeProductionPreparation,productionInputHash,type PreparedProduction} from "./model";

export type FilmPrice = {
  preparedId:string;manifestHash:string;filmId:string;filmTitle:string;currency:"USD";
  amountCents:number;expiresAt:string;sandbox:boolean;kind:"confirmed";note:string;
};
type Request=(path:string,body?:unknown)=>Promise<unknown>;
export function normalizeFilmPrice(value:unknown):FilmPrice|null {
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const v=value as Partial<FilmPrice>;
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.preparedId||"")
    || !/^[a-f0-9]{64}$/.test(v.manifestHash||"")||typeof v.filmId!=="string"||v.filmId.length>100
    || typeof v.filmTitle!=="string"||v.filmTitle.length>300||v.currency!=="USD"
    ||!Number.isSafeInteger(v.amountCents)||v.amountCents!<=0||v.amountCents!>100_000_000
    ||typeof v.expiresAt!=="string"||!Number.isFinite(Date.parse(v.expiresAt))||typeof v.sandbox!=="boolean"
    ||v.kind!=="confirmed"||typeof v.note!=="string"||v.note.length>2000)return null;
  return {preparedId:v.preparedId!,manifestHash:v.manifestHash!,filmId:v.filmId,filmTitle:v.filmTitle,currency:"USD",
    amountCents:v.amountCents!,expiresAt:v.expiresAt,sandbox:v.sandbox,kind:v.kind!,note:v.note};
}

// Preparation and pricing never depend on card entry. Persist the saved plan
// before requesting a price so a pricing failure cannot lose that preparation.
export async function prepareFilmPrice({request,input,filmId,existing,preparationKey,priceKey,preparationConsent,persist,now=Date.now}:{
  request:Request;input:string;filmId:string;existing?:PreparedProduction;preparationKey:string;priceKey:string;
  preparationConsent:boolean;persist:(value:PreparedProduction)=>void;now?:()=>number;
}):Promise<{prepared:PreparedProduction;price:FilmPrice}> {
  const inputHash=await productionInputHash(input);
  let prepared=existing?.inputHash===inputHash?existing:undefined;
  if(!prepared) {
    if(!preparationConsent)throw new Error("Allow your production plan to be saved before preparing pricing.");
    const result=await request("/api/studio",{action:"prepare",project:JSON.parse(input),preparationConsent:true,idempotencyKey:preparationKey});
    prepared=normalizeProductionPreparation({...result as object,inputHash,requestId:preparationKey});
    if(!prepared)throw new Error("The saved production reference could not be verified. Retry this preparation request.");
    persist(prepared);
  }
  const price=normalizeFilmPrice(await request("/api/studio",{action:"price",project:JSON.parse(input),preparedId:prepared.id,idempotencyKey:priceKey}));
  if(!price||price.preparedId!==prepared.id||price.manifestHash!==prepared.manifestHash||price.filmId!==filmId
    ||Date.parse(price.expiresAt)<=now())throw new Error("Your film price could not be verified against the saved plan. No payment has been requested.");
  return {prepared,price};
}
