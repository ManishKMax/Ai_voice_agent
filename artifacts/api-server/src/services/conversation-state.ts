export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ConversationSession {
  leadId: number;
  leadName: string;
  callSid: string;
  messages: ConversationMessage[];
  transcript: string;
  turnCount: number;
}

const sessions = new Map<string, ConversationSession>();

export function createSession(
  callSid: string,
  leadId: number,
  leadName: string,
  systemPrompt: string
): ConversationSession {
  const session: ConversationSession = {
    leadId,
    leadName,
    callSid,
    messages: [{ role: "system", content: systemPrompt }],
    transcript: "",
    turnCount: 0,
  };
  sessions.set(callSid, session);
  // Auto-cleanup after 30 minutes
  setTimeout(() => sessions.delete(callSid), 30 * 60 * 1000);
  return session;
}

export function getSession(callSid: string): ConversationSession | undefined {
  return sessions.get(callSid);
}

/** Append a user turn and an agent response to the session. */
export function addTurn(callSid: string, userText: string, agentText: string): void {
  const session = sessions.get(callSid);
  if (!session) return;
  session.messages.push({ role: "user", content: userText });
  session.messages.push({ role: "assistant", content: agentText });
  session.transcript += `Lead: ${userText}\nAgent: ${agentText}\n`;
  session.turnCount++;
}

/** Record the agent's opening greeting in the transcript only (not as an API message). */
export function addAgentOpening(callSid: string, agentText: string): void {
  const session = sessions.get(callSid);
  if (!session) return;
  // Do NOT add to session.messages — adding an assistant message before the first
  // user message confuses some chat models. The greeting is embedded in the system prompt.
  session.transcript += `Agent: ${agentText}\n`;
}

/** Remove session and return its final state. */
export function endSession(callSid: string): ConversationSession | undefined {
  const session = sessions.get(callSid);
  if (session) sessions.delete(callSid);
  return session;
}
