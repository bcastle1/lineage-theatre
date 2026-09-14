import { json, readBody, sameOrigin, getSession, digest, readRecord, limitAction } from "./_lib/auth.mjs";
import { generateStory, STORY_MODEL } from "./_lib/story.mjs";
import { productionReadiness } from "./_lib/production.mjs";
import { readPricingSettings } from "./_lib/admin.mjs";

export async function connections({fetchImpl=fetch,key=process.env.OPENAI_API_KEY,pricingSettings}={}) {
  let story={available:false,reason:"Connect the existing OpenAI project to enable GPT-6 Astra story development."};
  if(key) {
    try {
      const response=await fetchImpl(`https://api.openai.com/v1/models/${STORY_MODEL}`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(10_000)});
      story={available:response.ok,reason:response.ok?"GPT-6 Astra is connected. Generation remains subject to the project's quota.":"The connected OpenAI project cannot access GPT-6 Astra. Check model access and the server credential."};
    } catch {story={available:false,reason:"The Astra connection could not be checked. Your materials remain saved."};}
  }
  const production=productionReadiness({pricingSettings});
  return {story:story.available,storyModel:STORY_MODEL,...production,connections:{story,...production.connections}};
}

const productionUnavailable="Film production is not available yet. You can continue writing and saving your screenplay. No payment has been taken.";
const storyUnavailable="Story development is temporarily unavailable. Your sources and previous draft are saved. Try again later.";
// Only known source and screenplay validation feedback may cross the customer boundary.
const customerValidationMessages=new Set([
  "Add your family materials before developing the film.",
  "This draft supports 200 sources. Split this archive into related films; no sources were sent or silently omitted.",
  "Add valid source details before developing the film.",
  "Each family source needs a unique reference. Reimport duplicated or invalid sources.",
  "Use up to three selected themes for one film.",
  "Add the ancestor or family at the heart of the film.",
  "This draft exceeds one million characters. Divide the archive into chapters or remove unrelated sources. Nothing was truncated or sent.",
  "Use up to 40 earlier titles of at most 500 characters each. No family material was sent.",
  "This draft has unusually long source descriptions or film details. Shorten these descriptions; no family material was truncated or sent.",
  "Use up to 12 reference photos per story request. Add context notes for other photos.",
  "A photo reference does not match this film's sources.",
  "A reference photo is too large or unreadable. Resize it before retrying.",
  "The cast's evidence references could not be verified. Please develop the screenplay again.",
  "The screenplay has invalid scene references. Please develop it again.",
  "The dramatization ledger is incomplete. Please develop the screenplay again.",
  "The documentary draft included an invented or inferred character. Please retry; it has not replaced your saved draft.",
  "The screenplay must explain its invented or inferred characters before review.",
  "The screenplay must label scenes with reconstructed characters or missing evidence as dramatization before review.",
]);

function customerCapabilities(ready) {
  return {
    story:ready.story===true,
    production:ready.magiclight===true,
    billing:ready.billing===true,
    pricing:{currency:"USD",estimate:{status:"unavailable",amountCents:null,reason:"Your film's price will be confirmed before you approve a payment."},chargeReady:false},
    quality:{label:ready.quality?.verified===true?"Animation quality confirmed":"Animation quality will be confirmed before production",verified:ready.quality?.verified===true},
  };
}

function customerStory(result,action) {
  const fields=action==="themes"?["themes"]:["logline","selectedThemes","characters","assumptions","scenes"];
  const coverageFields=["totalSources","readSources","textCharacters","photoSources","photosRead","notesOnlySources","warnings"];
  return {
    ...Object.fromEntries(fields.map(key=>[key,result[key]])),
    sourceCoverage:Object.fromEntries(coverageFields.map(key=>[key,result.sourceCoverage?.[key]])),
    generatedBy:"Lineage Theatre",
    generatedAt:result.generatedAt,
  };
}

export function createStudioHandler(overrides={}) {
 const dependencies={getSession,readRecord,limitAction,connections,readPricingSettings,generateStory,...overrides};
 return async function handler(req,res) {
  const {getSession,readRecord,limitAction,connections,readPricingSettings,generateStory}=dependencies;
  let storyRequest=false;
  try {
    const session=await getSession(req);
    if(!session) return json(res,401,{message:"Sign in and set your password to use the studio."});
    const email=session.user.email;
    const url=new URL(req.url,`https://${req.headers.host}`);
    if(req.method==="GET") {
      const action=url.searchParams.get("action");
      if(action==="capabilities") return json(res,200,customerCapabilities(await connections({pricingSettings:await readPricingSettings()})));
      if(!["status","media"].includes(action)) return json(res,400,{message:"Unknown studio request."});
      const id=url.searchParams.get("id");
      if(!/^[a-z0-9-]{20,80}$/i.test(id??"")) return json(res,400,{message:"Invalid production reference."});
      const record=await readRecord(`jobs/${digest(email)}/${id}.json`);
      if(!record) return json(res,404,{message:"This production does not belong to your account."});
      return json(res,409,{message:"This is a previous studio production. Downloaded films remain in your library."});
    }
    if(req.method!=="POST") return json(res,405,{message:"Method not allowed."});
    if(!sameOrigin(req)) return json(res,403,{message:"Begin this action inside Lineage Theatre."});
    const body=await readBody(req);
    if(["themes","plan"].includes(body.action)) {
      storyRequest=true;
      if(body.storyConsent!==true) return json(res,400,{message:"Confirm that Lineage Theatre may use your family materials for AI-assisted story development."});
      if(!(await limitAction(`story:${email}`,20,3600_000))) return json(res,429,{message:"Your hourly story-development limit is reached. Your current draft is saved."});
      return json(res,200,customerStory(await generateStory(body),body.action));
    }
    if(["generate","quote","checkout"].includes(body.action)) {
      // Never accept payment or invent a provider job before integration.
      return json(res,503,{code:"PRODUCTION_UNAVAILABLE",message:productionUnavailable,charged:false});
    }
    return json(res,400,{message:"Unknown studio action."});
  } catch(e) {
    return json(res,503,{message:e instanceof Error&&customerValidationMessages.has(e.message)?e.message:storyRequest?storyUnavailable:"The studio could not complete this action. Your saved film is unchanged."});
  }
 };
}

export default createStudioHandler();
