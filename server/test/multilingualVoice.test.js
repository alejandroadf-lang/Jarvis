// Everything in the voice path worked except the part that decides which
// language to answer in — and that part was a coin flip nobody had spun.
//
// transcribeAudio labelled its result "ISO-639-1 where Whisper is confident".
// whisper-1's verbose_json returns an English word: "spanish", not "es". The
// consumer read the first two characters. French, Thai, Japanese, Korean,
// Italian, Russian and Arabic passed by accident, because their English names
// begin with their own ISO codes. Spanish became "sp", German "ge",
// Portuguese and Polish both "po", Chinese "ch", Dutch "du" — none in the
// table, so the instruction came back empty and the team answered in English.
//
// Every test in the suite fed it 'es' and 'en', so every test agreed with the
// label rather than with the API. Same class of error as the opus container,
// and this one shipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageName, replyLanguageInstruction, truncationNotice, spokenLanguage } from '../language.js';
import { spokenExcerpt } from '../speech.js';

// The six that silently fell back to English, named individually so a
// regression says which language broke rather than that a loop failed.
const SILENTLY_BROKEN = [
  ['spanish', 'Spanish'],
  ['german', 'German'],
  ['portuguese', 'Portuguese'],
  ['chinese', 'Chinese'],
  ['dutch', 'Dutch'],
  ['polish', 'Polish'],
];

for (const [whisperSays, expected] of SILENTLY_BROKEN) {
  test(`whisper's "${whisperSays}" resolves to ${expected}, not silence`, () => {
    assert.equal(languageName(whisperSays), expected);
    const said = replyLanguageInstruction({ detected: whisperSays });
    assert.match(said, new RegExp(`Reply in ${expected}`), 'and produces a real instruction');
  });
}

test('the ISO codes still work, so the fix adds a form rather than swapping one', () => {
  for (const [code, name] of [['es', 'Spanish'], ['de', 'German'], ['zh', 'Chinese'], ['th', 'Thai']]) {
    assert.equal(languageName(code), name);
  }
});

test('"no" is Norwegian, not a truthiness accident', () => {
  // A two-letter code that is also an English word, and the one most likely
  // to be mangled by a helpful normalisation.
  assert.equal(languageName('no'), 'Norwegian');
});

test("whisper's own alternative spellings resolve", () => {
  assert.equal(languageName('mandarin'), 'Chinese');
  assert.equal(languageName('mandarin_chinese'), 'Chinese');
  assert.equal(languageName('castilian'), 'Spanish');
  assert.equal(languageName('norwegian_bokmal'), 'Norwegian');
});

test('an unknown language is still silence, not a guess', () => {
  // The original safety property, which the fix must not trade away: a model
  // told "reply in Klingon" will try.
  for (const value of ['klingon', 'zz', '', null, undefined, 'a language we do not name']) {
    assert.equal(languageName(value), '', `${JSON.stringify(value)} names nothing`);
    assert.equal(replyLanguageInstruction({ detected: value }), '');
  }
});

test('a long word is not mistaken for a code by reading its first two letters', () => {
  // The bug in one line. "spinach" must not become Spanish via "sp".
  assert.equal(languageName('spinach'), '');
  assert.equal(languageName('german-ish'), '');
});

// --- What the voice actually says -------------------------------------------------------

test('the truncation notice is spoken in the language being spoken', () => {
  // A Thai voice note that ended with an English sentence broke the illusion
  // at exactly the wrong moment — the one point the reply admits it is cut.
  assert.equal(truncationNotice('spanish'), 'El resto está en el mensaje.');
  assert.match(truncationNotice('th'), /ข้อความ/);
  assert.match(truncationNotice('zh'), /消息/);
});

test('a language with no translated notice falls back to English rather than inventing one', () => {
  assert.equal(truncationNotice('klingon'), 'The rest is in the message.');
  assert.equal(truncationNotice(''), 'The rest is in the message.');
});

test('a pinned language decides what the voice speaks, not what was heard', (t) => {
  // The translation case, and the one the old code got backwards: with
  // REPLY_LANGUAGE=es the text reply is Spanish while Whisper reports
  // "english", so the voice was told to speak the wrong one of the two.
  const saved = process.env.REPLY_LANGUAGE;
  t.after(() => {
    if (saved === undefined) delete process.env.REPLY_LANGUAGE;
    else process.env.REPLY_LANGUAGE = saved;
  });

  process.env.REPLY_LANGUAGE = 'es';
  assert.equal(spokenLanguage({ detected: 'english' }), 'Spanish');
  assert.equal(truncationNotice(spokenLanguage({ detected: 'english' })), 'El resto está en el mensaje.');

  delete process.env.REPLY_LANGUAGE;
  assert.equal(spokenLanguage({ detected: 'english' }), 'English');
});

// --- Cutting a reply in a script that has no spaces --------------------------------------

test('Chinese is cut at a sentence mark, which carries no trailing space', () => {
  const zh = '定价是每月二十九美元。我们还没有核实他们的接口条款。团队今天会去查。'.repeat(30);
  const { text, truncated } = spokenExcerpt(zh, 700);
  assert.equal(truncated, true);
  assert.ok(text.endsWith('。'), `ended at "${text.slice(-12)}"`);
});

test('a script with no spaces is cut at the budget rather than thrown away', () => {
  // lastIndexOf(' ') is -1 for the whole string in Thai. The old fallback
  // chain reached that -1 and there was nothing after it.
  const th = 'ราคาคือยี่สิบเก้าดอลลาร์ต่อเดือนและทีมยังไม่ได้ตรวจสอบเงื่อนไข'.repeat(25);
  const { text, truncated } = spokenExcerpt(th, 700);
  assert.equal(truncated, true);
  assert.ok(text.length > 100, 'a real excerpt, not a fragment');
});

test('the budget is a listening budget, so CJK gets fewer characters for the same airtime', () => {
  // 700 Chinese characters is minutes of speech; 700 English characters is
  // about forty seconds. A flat character count silently meant the first.
  const zh = '团'.repeat(2000);
  const en = 'word '.repeat(400);
  const zhOut = spokenExcerpt(zh, 700).text.length;
  const enOut = spokenExcerpt(en, 700).text.length;
  assert.ok(zhOut < enOut / 2, `Chinese ${zhOut} should be far shorter than English ${enOut}`);
});

test('a Latin decimal and an abbreviation are not sentence ends', () => {
  const en = 'The price is 29.00 per month and Dr. Vega asked about it. '.repeat(30);
  const { text } = spokenExcerpt(en, 700);
  assert.ok(!text.endsWith('29.'), 'not cut inside a number');
  assert.ok(!text.endsWith('Dr.'), 'not cut after an abbreviation');
});

test('a short reply in any script is untouched', () => {
  for (const s of ['Short answer.', '好的。', 'ตกลง']) {
    const { text, truncated } = spokenExcerpt(s, 700);
    assert.equal(truncated, false);
    assert.equal(text, s);
  }
});

test('a region or script subtag still resolves, without reopening the prefix trap', () => {
  // pt-BR worked under the old slice(0, 2) and had to keep working. It is
  // matched by shape — two letters, a separator, a subtag — which is what
  // makes the first two characters a code here and meaningless in "spanish".
  assert.equal(languageName('pt-BR'), 'Portuguese');
  assert.equal(languageName('zh-Hans'), 'Chinese');
  assert.equal(languageName('en_US'), 'English');
  // And the trap stays shut.
  assert.equal(languageName('german-ish'), '');
  assert.equal(languageName('xx-YY'), '');
});
