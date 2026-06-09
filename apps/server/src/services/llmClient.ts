import { config } from "../config.js";

export async function chatWithLlm(userMessage: string): Promise<string> {
  if (!config.LLM_API_BASE || !config.LLM_API_KEY || config.LLM_API_KEY === "replace-me-locally") {
    return [
      "LLM provider is not configured yet.",
      "Set LLM_API_BASE, LLM_API_KEY, and LLM_MODEL in .env using the same OpenAI-compatible provider you use in VSCode Continue.",
      "You can still use /api/vm/status to verify Sentaurus VM connectivity."
    ].join("\n");
  }

  const base = config.LLM_API_BASE.replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: config.LLM_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a Sentaurus TCAD web agent. Be concise. For destructive or long-running jobs, ask for confirmation. Do not reveal secrets."
        },
        { role: "user", content: userMessage }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content?.trim() || "No response from LLM.";
}
