const text = { type: 'string', minLength: 1 }
const requestId = { type: 'string', description: 'Optional stable ID for retries of this exact operation.' }
const spec = (name, description, properties = {}, required = []) => ({
  name,
  description,
  parameters: { type: 'object', properties, required, additionalProperties: false },
})

export const teamTools = [
  spec('list_members', 'List members and their current activity in your NativeCrew team.'),
  spec('list_tasks', 'Read tasks, owners, dependencies and acceptance criteria in your team.'),
  spec(
    'send_message',
    'Send a message directly to a teammate by member name or ID.',
    { to: text, text, replyTo: text, requestId },
    ['to', 'text'],
  ),
  spec(
    'assign_task',
    'Delegate work to a teammate. The result returns to the requester.',
    { to: text, title: text, criteria: text, dependsOn: { type: 'array', items: text }, requestId },
    ['to', 'title', 'criteria'],
  ),
  spec(
    'report_result',
    'Submit evidence for an assigned task. Acceptance is a separate decision.',
    {
      taskId: text,
      requestId,
      evidence: text,
      assignmentId: text,
      expectedEvidenceRevision: { type: 'integer', minimum: 0 },
    },
    ['taskId', 'evidence'],
  ),
]
