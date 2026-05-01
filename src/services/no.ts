import { createGroq } from "@ai-sdk/groq";
import { generateText } from "ai";

const MODEL = "llama-3.3-70b-versatile";

const QUOTE_SYSTEM_PROMPT = `You write one congratulatory line for a competitive programmer who just improved their rating. Think: a brilliant friend who's genuinely proud of you but absolutely will not let you get comfortable about it.

Rules:
- One sentence. Max 20 words.
- Use their handle naturally. Make it feel written for them specifically.
- Sassy, sharp, a little cocky on their behalf. Inspiring because it's real, not because it's nice.
- No emojis. No "keep grinding". No "you got this". No inspirational poster garbage.

Examples:
"tourist just went up 47 — someone tell the rest of the leaderboard to start worrying."
"rng_58 on AtCoder didn't ask for permission to climb, and it shows."
"Up 60 points. Benq is not here to participate, apparently."
"That's a Grandmaster rating now. Act like you've been there before — oh wait, you haven't. Yet."
"The algorithm didn't stand a chance. Neither will the next one."`;

export async function generateMotivationalQuote(
  groqApiKey: string,
  handle: string,
  platform: string,
  delta: number | null,
  newRating: number,
  newRank: string | null,
): Promise<string> {
  try {
    const context = [
      `Handle: ${handle}`,
      `Platform: ${platform}`,
      delta != null ? `Rating delta: +${delta}` : null,
      `New rating: ${newRating}`,
      newRank ? `New rank: ${newRank}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    const groq = createGroq({ apiKey: groqApiKey });
    const { text } = await generateText({
      model: groq(MODEL),
      system: QUOTE_SYSTEM_PROMPT,
      prompt: `Write a congratulatory line for: ${context}`,
      maxTokens: 50,
      temperature: 1.0,
    });
    return text.trim();
  } catch (error) {
    console.error(
      "[Quote] AI call failed:",
      error instanceof Error ? error.message : error,
    );
    return "";
  }
}

const NO_RESPONSES = [
  "No, and I'm judging you for asking.",
  "No.",
  "I've consulted with the council. They all said no.",
  "That's gonna be a no from me, dawg.",
  "Nope. Not today, not tomorrow, not ever.",
  "No. And that's my final answer. Don't @ me.",
  "I'm going to stop you right there. No.",
  "Nice try, but no.",
  "Hard no.",
  "Did you really think I'd say yes? Cute. But no.",
  "Error 403: Permission Denied. Also, no.",
  "The answer is no. It was no yesterday, it's no today, and spoiler alert: it'll be no tomorrow.",
  "My answer is no. My lawyer's answer is also no.",
  "No-pe, no-pe, no-pe.",
  "You could offer me a million dollars and the answer would still be no.",
  "The audacity to even ask... No.",
  "I ran it through my sophisticated algorithm. Result: NO.",
  "Not just no, but NO with capital letters and an exclamation point. NO!",
  "The prophecy foretold this moment. It said: No.",
  "Absolutely not.",
  "No, and I didn’t even hesitate.",
  "Respectfully? No. Disrespectfully? Still no.",
  "I checked twice just to be sure. Still no.",
  "That’s gonna be a firm no with zero wiggle room.",
  "No. Not even in an alternate universe.",
  "I’d explain why, but no.",
  "Short answer: no. Long answer: also no.",
  "I considered it for 0.3 seconds. No.",
  "Denied. With enthusiasm.",
  "No, and I’m closing the case.",
  "I’m gonna pretend you didn’t ask that. No.",
  "That request has been rejected with extreme prejudice.",
  "I would, but no.",
  "No, and I’ve muted this idea.",
  "Let me put it gently: absolutely not.",
  "No. Take it up with someone who says yes.",
  "That’s outside my job description. Also, no.",
  "I tried to find a yes. Couldn’t. So no.",
  "This ain’t it. No.",
  "No, and I’m doubling down on it.",
  "I regret to inform you… actually I don’t. No.",
  "Hard pass. Which is just a fancy no.",
  "No. Next question.",
  "I ran a simulation. Every outcome said no.",
  "I’m allergic to that idea. No.",
  "No, and I’m standing by that decision.",
  "I could say maybe, but I won’t. No.",
  "That’s a negative, chief.",
  "No, and I didn’t even blink.",
  "Even my backup answer is no.",
  "I asked my future self. Still no.",
  "No. Let’s not circle back to this.",
  "I’m gonna veto that immediately. No.",
  "That idea expired the moment it was asked. No.",
  "No, and I’ve archived this conversation.",
  "I’d need a miracle to say yes. Didn’t happen. No.",
  "No. Please proceed to accept it.",
  "My final answer? Still no.",
  "I considered optimism. Then I said no.",
  "No, but with extra emphasis.",
  "I hear you. Counterpoint: no.",
  "Not happening. No.",
  "I’ve reviewed the evidence. Verdict: no.",
  "No, and I’ve locked that in.",
  "I would say yes, but I value honesty. So no.",
  "No, and that’s me being generous.",
  "I tried to negotiate with myself. Lost. No.",
  "No. Let’s keep expectations realistic.",
  "That’s a no with premium certainty.",
];

export function generateShameExcuse(): string {
  return NO_RESPONSES[Math.floor(Math.random() * NO_RESPONSES.length)]!;
}

