// What the simulated Alexa makes of something said to it. A real Alexa+ understands requests with
// its language model; the simulator uses these rules instead. They have to tell a request
// ("test my knowledge", "help me revise pricing") from an answer ("spot"), because anything that
// isn't a request is taken as the answer to the question on screen, and a request mistaken for an
// answer would count as a miss.

const STUDY = String.raw`(?:quiz(?:zes)?|tests?|questions?|flash ?cards?|study session|revision|review session)`;
const VERB = String.raw`(?:study|revise|practi[cs]e|review|drill|learn|go over)`;
const LEAD = String.raw`(?:(?:can|could|would|will) you |please |i want to |i'?d like to |can we |let'?s |help me |time to |i need to |i have to )*`;

const RULES = [
  ['stop', /^(?:please )?(?:stop|that'?s (?:all|enough|it)|i'?m (?:done|finished)|exit|cancel|enough|end (?:the )?(?:quiz|session))\b/],
  ['progress', /how am i doing|how'?s my (?:progress|studying|revision)|\bmy (?:progress|score|stats|streak)\b|\bstreak\b|weak spots?|what (?:did|have) i (?:get|got|gotten) wrong|what (?:do|should) i (?:need to )?(?:review|revise|study)\b/],
  ['hint', /\b(?:hint|clue)\b/],
  ['repeat', /\brepeat (?:the |that )?(?:question|it|that)\b|\bsay (?:that|it) again\b|what (?:was|is) the question/],
  ['quiz', new RegExp(String.raw`^${LEAD}(?:quiz|test)\b|\b(?:quiz|test) (?:me|my|myself|us)\b|\btest my (?:knowledge|memory)\b`)],
  ['quiz', new RegExp(String.raw`\b(?:start|begin|do|take|have|run|give me|try)\b.*\b${STUDY}\b`)],
  ['quiz', /\b(?:ask|give) me (?:a |an |another |some |more |the next )?(?:question|questions|one)\b|\b(?:next|another|new|one more) (?:question|one)\b/],
  ['quiz', new RegExp(String.raw`^${LEAD}${VERB}\b`)],
];

// Words around a topic that don't name it: "quiz me on my pricing notes, please".
const FILLER = /^(?:my|the|our|some|a few|of)\s+|\s+(?:notes?|notebook|section|page|highlights?|cards?|stuff|again|now|please|today|for me)$/;
const NO_TOPIC = new Set(['', 'it', 'this', 'that', 'them', 'everything', 'anything', 'all', 'all of it', 'all of them', 'knowledge', 'memory',
  'notes', 'note', 'highlights', 'stuff', 'notebooks', 'everything i highlighted']);

function topicOf(low) {
  const m = /\b(?:on|about|from|for|in|over)\s+(.+)$/.exec(low)
    || new RegExp(String.raw`\b${VERB}\s+(?!for\b|on\b|about\b)(.+)$`).exec(low);
  if (!m) return null;
  let t = m[1].replace(/[,.!?]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(FILLER, '').trim(); }
  return NO_TOPIC.has(t) ? null : t;
}

/**
 * The intent of an utterance: { kind: 'quiz' | 'hint' | 'progress' | 'stop' | 'repeat' | 'answer',
 * topic, text }. `pending` says whether a question is waiting for an answer: a lone study word
 * ("review") is then an answer rather than a request.
 */
export function intentOf(utterance, { pending = false } = {}) {
  const text = String(utterance || '').trim();
  const low = text.toLowerCase().replace(/^(?:hey |ok |okay )?alexa\b[,.]?\s*/, '').replace(/[.!?]+$/, '').replace(/[‘’]/g, "'").trim();
  for (const [kind, re] of RULES) {
    if (!re.test(low)) continue;
    if (kind === 'quiz' && pending && !/\s/.test(low) && !/^(?:quiz|test)$/.test(low)) break;   // "review" alone, mid-quiz: an answer
    return { kind, topic: kind === 'quiz' ? topicOf(low) : null, text };
  }
  return { kind: 'answer', topic: null, text };
}
