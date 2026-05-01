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

