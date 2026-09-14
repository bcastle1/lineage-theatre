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

export default async function handler(req,res) {
  try {
    const session=await getSession(req);
    if(!session) return json(res,401,{message:"Sign in and set your password to use the studio."});
    const email=session.user.email;
    const url=new URL(req.url,`https://${req.headers.host}`);
    if(req.method==="GET") {
      const action=url.searchParams.get("action");
      if(action==="capabilities") return json(res,200,await connections({pricingSettings:await readPricingSettings()}));
      if(!["status","media"].includes(action)) return json(res,400,{message:"Unknown studio request."});
      const id=url.searchParams.get("id");
      if(!/^[a-z0-9-]{20,80}$/i.test(id??"")) return json(res,400,{message:"Invalid production reference."});
      const record=await readRecord(`jobs/${digest(email)}/${id}.json`);
      if(!record) return json(res,404,{message:"This production does not belong to your account."});
      return json(res,409,{message:"This is a previous studio production. Downloaded films remain in your library; new films use MagicLight only."});
    }
    if(req.method!=="POST") return json(res,405,{message:"Method not allowed."});
    if(!sameOrigin(req)) return json(res,403,{message:"Begin this action inside Lineage Theatre."});
    const body=await readBody(req);
    if(["themes","plan"].includes(body.action)) {
      if(body.storyConsent!==true) return json(res,400,{message:"Confirm that OpenAI may read your family materials to develop this film."});
      if(!(await limitAction(`story:${email}`,20,3600_000))) return json(res,429,{message:"Your hourly story-development limit is reached. Your current draft is saved."});
      return json(res,200,await generateStory(body));
    }
    if(["generate","quote","checkout"].includes(body.action)) {
      if(body.provider!=="magiclight") return json(res,400,{message:"MagicLight is the only video generation provider available in Lineage Theatre."});
      // Never accept payment or invent a provider job before integration.
      return json(res,503,{code:"MAGICLIGHT_SETUP_REQUIRED",message:productionReadiness().connections.magiclight.reason,charged:false});
    }
    return json(res,400,{message:"Unknown studio action."});
  } catch(e) {
    return json(res,503,{message:e instanceof Error&&/^(GPT-6|Astra|The connected OpenAI|Confirm that OpenAI|Add |This draft|Each family|A photo|A reference|Use up to|The cast|The screenplay|The documentary|The dramatization)/.test(e.message)?e.message:"The studio could not complete this action. Your saved film is unchanged."});
  }
}
