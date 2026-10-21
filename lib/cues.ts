// What each speech model can do with delivery cues, so the app only sends what a model understands.
//
//   tone  how a tone direction ("warm", "late-night") reaches the voice:
//         "text"          written into the spoken text ("Say in a warm tone: ...")   Gemini speech models
//         "instructions"  the API's separate `instructions` field                    OpenAI gpt-4o-mini-tts
//         "none"          not steerable per request; the delivery comes from the voice itself
//   tags  whether inline cues such as [whispers], [laughs] or [short pause] are performed rather than read aloud.
//         true / false, or "unknown" for models nobody has checked (the text is then left alone).
//
// Sources are public model docs and write-ups (see docs/CUES.md); `basis` says how solid each entry is. Anything marked
// "assumed" should be confirmed by listening: generate a clip with a [laughs] and a tone and compare.

export type ToneMode = "text" | "instructions" | "none";
export type Basis = "documented" | "assumed" | "unknown";

export interface Cues {
  tone: ToneMode;
  tags: boolean | "unknown";
  basis: Basis;
  /** One line for the UI. */
  note: string;
}

const TABLE: Array<{ match: RegExp; cues: Cues }> = [
  {
    match: /^google\/gemini-.*tts/i,
    cues: { tone: "text", tags: true, basis: "documented", note: "Performs inline tags such as [whispers], [laughs], [sigh] and [short pause], and follows a written tone direction." },
  },
  {
    match: /^openai\/gpt-4o-mini-tts/i,
    cues: { tone: "instructions", tags: false, basis: "assumed", note: "Follows a tone direction (style, pace, accent) but does not perform inline tags; they are removed before speaking." },
  },
  {
    match: /^mistralai\/voxtral/i,
    cues: { tone: "none", tags: false, basis: "assumed", note: "Takes its delivery from the chosen voice, not from a tone direction. Inline tags are removed before speaking." },
  },
  {
    match: /^elevenlabs\/eleven_v3/i,
    cues: { tone: "none", tags: true, basis: "assumed", note: "ElevenLabs v3 performs audio tags such as [whispers] and [laughs] (per ElevenLabs' documentation, not tested here); tone is carried by the voice and the tags." },
  },
  {
    match: /^elevenlabs\//i,
    cues: { tone: "none", tags: false, basis: "assumed", note: "Your ElevenLabs voice, including clones. Delivery comes from the voice itself: tone is ignored and inline tags are removed before speaking." },
  },
  {
    match: /^hexgrad\/kokoro/i,
    cues: { tone: "none", tags: false, basis: "assumed", note: "Fixed voices with no tone control or inline tags; tone is ignored and tags are removed before speaking." },
  },
];

const UNKNOWN: Cues = {
  tone: "instructions", tags: "unknown", basis: "unknown",
  note: "Not checked: the tone is sent as an instruction and tags are left in the text, so listen to the result.",
};

export function cuesFor(model: string): Cues {
  return TABLE.find((row) => row.match.test(model))?.cues ?? UNKNOWN;
}

// Direct Gemini (no OpenRouter) is the Gemini speech model.
export const GEMINI_DIRECT_CUES: Cues = TABLE[0].cues;

// [sfx:...] is handled separately; anything else in square brackets is a delivery cue.
const DELIVERY_TAG = /\[[^\[\]\n]{1,40}\]/g;

export function stripDeliveryTags(text: string): { text: string; removed: boolean } {
  const removed = new RegExp(DELIVERY_TAG.source).test(text);
  return { text: removed ? text.replace(DELIVERY_TAG, " ").replace(/\s+([,.!?])/g, "$1").replace(/\s{2,}/g, " ").trim() : text, removed };
}
