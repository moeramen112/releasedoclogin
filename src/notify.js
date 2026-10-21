// Slack summary. buildSlackMessage is pure so it can be tested; sendSlack does the POST.

const EMOJI = { "NO-GO": ":no_entry:", HOLD: ":large_yellow_circle:", GO: ":white_check_mark:" };

export function buildSlackMessage({ release, result, dashboardUrl }) {
  const { verdict, criteria } = result;
  const holding = criteria.filter((c) => verdict.holding.includes(c.id));
  const lines = holding.length
    ? holding.map((c) => `• *${c.name}* (${c.effective}): ${c.detail}`).join("\n")
    : "Nothing is holding the release.";
  const waived = criteria.filter((c) => c.effective === "waived");
  const waivedLines = waived.length
    ? "\n\n*Waived*\n" + waived.map((c) => `• ${c.name}: approved by ${c.waiver.approver}. ${c.waiver.reason}`).join("\n")
    : "";
  const text = `${release.name}: ${verdict.call}. ${verdict.reason}`;
  return {
    text,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `${release.name}: ${verdict.call}` } },
      { type: "section", text: { type: "mrkdwn", text: `${EMOJI[verdict.call] || ""} ${verdict.reason}` } },
      { type: "section", text: { type: "mrkdwn", text: `*What is holding the release*\n${lines}${waivedLines}` } },
      ...(dashboardUrl ? [{ type: "context", elements: [{ type: "mrkdwn", text: `<${dashboardUrl}|Open the dashboard>` }] }] : []),
    ],
  };
}

export async function sendSlack(webhookUrl, payload, fetchImpl = fetch) {
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Slack returned ${res.status}.`);
}
