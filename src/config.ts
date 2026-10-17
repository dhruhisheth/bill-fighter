import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in .env (see .env.example)`);
  return value;
}

export const config = {
  foUrl: process.env.FO_MCP_URL?.trim() || "https://mcp.api.wajo.ai/fo",
  customerName: () => required("CUSTOMER_NAME"),
  customerPhone: () => required("CUSTOMER_PHONE"),
};
