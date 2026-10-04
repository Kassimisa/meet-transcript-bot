const report = $json.message?.content || '(no content returned by Ollama)';
const meta = $('Build Ollama Request').first().json;

return [{
  json: {
    meeting_id: meta.meeting_id,
    participants: meta.participants,
    started_at: meta.started_at,
    ended_at: meta.ended_at,
    lang: meta.lang,
    report,
  },
}];
