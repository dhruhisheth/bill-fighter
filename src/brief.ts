import type { BillAnalysis } from "./analyze.js";

export type Customer = { name: string; phone: string };

// Who Fo actually dials. Test mode (the default) calls the customer's own phone
// so they can play the rep; live mode calls the number printed on the bill.
export function callTarget(analysis: BillAnalysis, customer: Customer, live: boolean): string {
  if (!live) return customer.phone;
  if (!analysis.providerPhone) throw new Error("No customer service number on the bill; can't call live");
  // 555-0100 to 555-0199 is the reserved fictional range our sample bills use.
  if (/555\D?01\d\d/.test(analysis.providerPhone)) throw new Error("That's a fictional sample number; use rehearsal mode");
  return analysis.providerPhone;
}

const list = (items: string[]) => items.map((s, i) => `${i + 1}. ${s}`).join("\n");

// One plain English request to Fo with everything it needs to run the call.
export function buildBrief(analysis: BillAnalysis, customer: Customer, live: boolean): string {
  const target = callTarget(analysis, customer, live);
  const who = live
    ? `${analysis.provider} customer service`
    : `${analysis.provider} customer service (this is a rehearsal: the number is my own phone standing in for theirs, so whoever answers is the ${analysis.provider} rep, not me. Don't greet them as me; open as you would with the real company)`;

  return `Please call ${target} now on my behalf. It's ${who}. I've reviewed this and approve the call, so you don't need to check with me before dialing.

Account details for verification (share only these):
- Account holder: ${analysis.accountHolder ?? customer.name}
- Account number: ${analysis.accountNumber ?? "not on the bill, ask them to look it up by name and phone"}
- Phone on file: ${customer.phone}

Goal: ${analysis.goal} my bill. ${analysis.summary}

Open with: "${analysis.script.opening}"

Ask for these in order:
${list(analysis.script.asks)}

If they say no, try:
${list(analysis.script.fallbackAsks)}

Useful leverage:
${list(analysis.script.leverage)}

Never agree to:
${list(analysis.script.doNotAgreeTo)}

Rule that overrides any targets above: there is no minimum. Accept every discount or credit that needs no new contract, however small (confirm "no contract?" if unsure), then keep going with the remaining asks. Before hanging up, repeat back what they agreed to and ask for a reference number.

When to wrap up: ${analysis.script.walkAway}

If they ask for anything you don't have (a PIN, security answer, SSN digits), don't guess. Say I'll call back, end politely and tell me.

When the call ends, reply with: what they agreed to, the new monthly price, any one time credits or refunds, and the reference number.`;
}
