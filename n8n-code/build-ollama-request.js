const b = $('Webhook').first().json.body;

let formDocs = [];
try {
  formDocs = $('Extract Document Text').first().json.documents || [];
} catch (e) {
  /* no upload */
}
const docs = [...(b.documents || []), ...formDocs];
const docsText = docs.length
  ? docs.map((d) => `### ${d.name}\n${d.text}`).join('\n\n')
  : '(no documents were shared in this meeting)';

// Detect the transcript language so the report (and its section titles) match it.
const FR_WORDS = new Set('le la les des du et est que pour nous vous je une dans sur avec pas qui au aux en ce cette mais ou par sont ont être avoir plus tout très bien oui non merci bonjour'.split(' '));
const EN_WORDS = new Set('the and is are to of that for we you i in with it this not have will be was were they there what which but so if do does did can would should hello thanks yes no'.split(' '));
const tokens = (b.raw_transcript_text || '').toLowerCase().split(/[^a-zàâçéèêëîïôùûüÿœ']+/).filter(Boolean);
const fr = tokens.filter((t) => FR_WORDS.has(t)).length;
const en = tokens.filter((t) => EN_WORDS.has(t)).length;
const lang = fr >= 2 && fr > en * 1.2 ? 'fr' : en >= 2 && en > fr * 1.2 ? 'en' : 'other';

const LANGS = {
  fr: {
    name: 'French',
    titles: ['Résumé', 'Décisions clés', 'Actions à mener', 'Informations issues des documents', 'Questions ouvertes'],
    none: 'Rien à signaler.',
  },
  en: {
    name: 'English',
    titles: ['Summary', 'Key Decisions', 'Action Items', 'Information from Documents', 'Open Questions'],
    none: 'Nothing noted.',
  },
  other: {
    name: 'the same language as the transcript',
    titles: ['Summary', 'Key Decisions', 'Action Items', 'Information from Documents', 'Open Questions'],
    none: 'Nothing noted.',
  },
}[lang];

const prompt = `You are an assistant that writes meeting reports. Use BOTH sources below: the meeting transcript (auto-captions, may contain errors) and the documents shared during the meeting (if any). Cross-reference them: use the documents to clarify names, figures and terms mentioned in the discussion.

Meeting ID: ${b.meeting_id}
Participants: ${(b.participants || []).join(', ') || 'unknown'}
Started: ${b.started_at}
Ended: ${b.ended_at}

## SOURCE 1 - TRANSCRIPT
"""
${b.raw_transcript_text || ''}
"""

## SOURCE 2 - SHARED DOCUMENTS
${docsText}

Write the ENTIRE report in ${LANGS.name}. Use Markdown with exactly these section titles, in this order:
${LANGS.titles.map((t) => `## ${t}`).join('\n')}

Under "${LANGS.titles[2]}", list each action with its owner and deadline when mentioned.
If a section has nothing relevant, write: ${LANGS.none}
Do not invent anything that is not supported by the sources.`;

return [{
  json: {
    meeting_id: b.meeting_id,
    participants: b.participants,
    started_at: b.started_at,
    ended_at: b.ended_at,
    lang,
    requestBody: {
      model: 'qwen3.5:9b',
      stream: false,
      think: false,
      messages: [{ role: 'user', content: prompt }],
    },
  },
}];
