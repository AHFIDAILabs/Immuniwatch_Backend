/**
 * groqService — RAG counter-narrative generator using Groq AI.
 *
 * When the ML service counter-narrative endpoint is not yet live, this service
 * generates fact-based counter-narratives using:
 *   - The misinformation post content
 *   - The ML classification label (misinformation / disinformation)
 *   - KB evidence from the Classification document (already retrieved by ML)
 *   - Additional KB documents from MongoDB (text similarity via $text search)
 *
 * Requires GROQ_API_KEY in .env. Returns null silently if key is absent.
 * Get a free key at: https://console.groq.com
 */

import axios from 'axios';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { config }        from '../config';
import { logger }        from '../utils/logger';

export interface CounterNarrativeVersions {
  short:  string;  // ≤280 characters — social-media ready
  medium: string;  // ≤200 words — detailed
  long:   string;  // ≤500 words — comprehensive with call-to-action
}

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';

/** Fetch KB documents related to the post content (simple full-text search). */
async function fetchKbContext(
  postContent: string,
  orgId?: string | null,
): Promise<string> {
  try {
    // MongoDB $text search on the KB collection — indexed on content + title
    const docs = await KnowledgeBase.find(
      {
        $text: { $search: postContent.slice(0, 200) },
        ...(orgId ? { $or: [{ organizationId: orgId }, { organizationId: { $exists: false } }] } : {}),
      },
      { score: { $meta: 'textScore' } },
    )
      .sort({ score: { $meta: 'textScore' } })
      .select('title content source')
      .limit(4)
      .lean();

    if (docs.length === 0) {
      // Fallback: grab any KB docs (most recent global ones)
      const fallback = await KnowledgeBase.find({})
        .select('title content source')
        .limit(3)
        .lean();
      return fallback.map((d) => `[${d.source}] ${d.title}:\n${d.content.slice(0, 300)}`).join('\n\n');
    }

    return docs.map((d) => `[${d.source}] ${d.title}:\n${d.content.slice(0, 400)}`).join('\n\n');
  } catch {
    return '';
  }
}

const LANG_NAMES: Record<string, string> = {
  en: 'English', pcm: 'Nigerian Pidgin', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo',
};

/**
 * Generate counter-narratives in 3 lengths using Groq AI with KB context (RAG).
 *
 * @param postContent   The full misinformation post text
 * @param label         ML classification label ('misinformation' | 'disinformation')
 * @param language      Post language code ('en' | 'pcm' | 'ha' | 'yo' | 'ig')
 * @param kbEvidence    Evidence snippets from the Classification (from ML classify response)
 * @param orgId         Organization ID for KB scoping (optional)
 */
/** Template-based fallback used when Groq is unavailable or no API key is set. */
async function templateFallback(
  postContent: string,
  label:       string,
  language:    string,
  orgId?:      string | null,
): Promise<CounterNarrativeVersions> {
  const langName = LANG_NAMES[language] ?? 'English';

  // Fetch the most relevant KB doc for context
  let kbRef = '';
  try {
    const docs = await KnowledgeBase.find({
      $text: { $search: postContent.slice(0, 150) },
      ...(orgId ? { $or: [{ organizationId: orgId }, { organizationId: { $exists: false } }] } : {}),
    }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .select('title source content')
      .limit(1)
      .lean();

    if (docs.length > 0) {
      kbRef = `${docs[0].title} (${docs[0].source})`;
    } else {
      // Generic fallback
      const any = await KnowledgeBase.findOne({}).select('title source').lean();
      if (any) kbRef = `${any.title} (${any.source})`;
    }
  } catch { /* ignore */ }

  const sourceNote = kbRef ? `Source: ${kbRef}. ` : 'Source: WHO/NPHCDA vaccine safety guidelines. ';

  const short = label === 'misinformation'
    ? `This claim is not accurate. Vaccines approved by NAFDAC and recommended by WHO have been thoroughly tested for safety and efficacy. ${sourceNote}Visit your nearest health center for verified information.`
    : `This post contains potentially misleading health information. Please consult a qualified health professional or visit your nearest NPHCDA health center for accurate vaccine information.`;

  const medium = `${short}\n\nVaccines go through extensive clinical trials before approval. Nigeria's NAFDAC, WHO, and NPHCDA continuously monitor vaccine safety. If you have concerns, please speak with a registered health worker in your area rather than relying on unverified social media posts.\n\n${sourceNote}`;

  const long = `${medium}\n\nCommon vaccine misconceptions often spread rapidly on social media, but they are rarely supported by scientific evidence. Here is what you should know:\n\n1. All vaccines used in Nigeria are reviewed and approved by NAFDAC before use.\n2. The WHO and NPHCDA monitor vaccine safety on an ongoing basis.\n3. Serious adverse events are extremely rare and are carefully tracked.\n4. Getting vaccinated protects not only you, but also vulnerable members of your community.\n\nIf you or someone you know has questions or concerns about vaccines, please:\n• Visit your nearest Primary Health Care center\n• Call the NPHCDA hotline\n• Speak with a registered nurse or doctor\n\nDo not make health decisions based on unverified information. Your health and the health of your community matters.`;

  return { short: short.slice(0, 280), medium, long };
}

export async function generateCounterNarrative(
  postContent: string,
  label:       string,
  language:    string,
  kbEvidence?: Array<{ title: string; snippet: string }>,
  orgId?:      string | null,
): Promise<CounterNarrativeVersions | null> {
  // If no Groq key, use template fallback so the textarea always has content
  if (!config.groq.apiKey) {
    logger.debug('groqService: GROQ_API_KEY not set — using template fallback');
    return templateFallback(postContent, label, language, orgId);
  }

  const langName = LANG_NAMES[language] ?? 'English';

  // 1. Build context from Classification kbEvidence + MongoDB KB search
  const evidenceFromClassifier = kbEvidence
    ?.filter((e) => e.snippet || e.title)
    .map((e) => `${e.title}: ${e.snippet}`)
    .join('\n\n') ?? '';

  const evidenceFromDb = await fetchKbContext(postContent, orgId);
  const context = [evidenceFromClassifier, evidenceFromDb].filter(Boolean).join('\n\n---\n\n');

  // 2. Build the prompt
  const systemPrompt = `You are a public health communication expert at NPHCDA (Nigeria's National Primary Health Care Development Agency).
Your job is to write accurate, respectful, culturally sensitive counter-narratives that correct vaccine misinformation for Nigerian communities.
Always base your responses strictly on the provided knowledge base evidence.
Use a warm, factual, and empathetic tone. Avoid condescension.
If the post is in ${langName}, write your response in ${langName}.`;

  const userPrompt = `A social media post has been classified as "${label}".

POST:
"${postContent}"

KNOWLEDGE BASE EVIDENCE:
${context || 'Use NPHCDA and WHO guidelines on vaccine safety for Nigerian communities.'}

Generate THREE counter-narrative responses at different lengths.
Return ONLY a valid JSON object with these exact keys:

{
  "short": "A reply ≤280 characters, suitable as a direct social media response. Cite the source (WHO/NPHCDA/NCDC) briefly.",
  "medium": "A reply ≤200 words. Acknowledge the concern, provide factual evidence, cite sources.",
  "long": "A reply ≤500 words. Full explanation with context, evidence, sources, and a call to action (visit a health center, talk to a health worker)."
}`;

  // 3. Call Groq API
  try {
    const { data } = await axios.post(
      GROQ_API,
      {
        model:           config.groq.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        temperature:     0.35,  // slightly creative but mostly factual
        max_tokens:      1800,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization:  `Bearer ${config.groq.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
    );

    const raw     = data.choices?.[0]?.message?.content ?? '{}';
    const parsed  = JSON.parse(raw) as Record<string, string>;

    const short  = (parsed.short  ?? '').trim();
    const medium = (parsed.medium ?? '').trim();
    const long   = (parsed.long   ?? '').trim();

    if (!short && !medium && !long) {
      logger.warn('groqService: response parsed but all versions empty');
      return null;
    }

    logger.info(`groqService: counter-narrative generated (${config.groq.model}, lang=${language})`);

    return {
      short:  short  || medium || long,
      medium: medium || long   || short,
      long:   long   || medium || short,
    };
  } catch (err) {
    logger.warn(`groqService.generateCounterNarrative failed: ${(err as Error).message} — using template fallback`);
    return templateFallback(postContent, label, language, orgId);
  }
}
