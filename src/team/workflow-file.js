import { normalizeWorkflow } from './workflow-graph.js'

export const workflowFormat = 'godbot-workflows/v1'

export function mapWorkflow(flow, owners, clean = text => text) {
  return {
    name: clean(flow.name),
    nodes: flow.nodes.map(({ id, title, criteria, ownerId, join }) => {
      const mapped = owners.get(ownerId)
      if (!mapped) throw new Error('请选择每个工作流节点的负责人。')
      return { id, title: clean(title), criteria: clean(criteria), ownerId: mapped, join }
    }),
    edges: flow.edges.map(({ from, to, when, value }) =>
      when === 'accepted' ? { from, to, when } : { from, to, when, value: clean(value) }),
  }
}

export function workflowFile(flow, members) {
  const used = new Set(flow.nodes.map(node => node.ownerId))
  const owners = new Map()
  const bots = []
  for (const member of members) {
    if (!used.has(member.id)) continue
    const ref = 'bot-' + bots.length
    owners.set(member.id, ref)
    bots.push({ ref, name: member.name })
  }
  return { format: workflowFormat, bots, workflows: [mapWorkflow(flow, owners)] }
}

export function readWorkflowFile(text) {
  const data = JSON.parse(text)
  if (![workflowFormat, 'godbot-team/v1'].includes(data?.format)) throw new Error('请选择 NativeCrew 工作流或团队模板文件。')
  if (!Array.isArray(data.bots) || !data.bots.length || data.bots.length > 256) throw new Error('模板缺少有效的成员清单。')
  const owners = new Set()
  const bots = data.bots.map(({ ref, name }) => {
    if (typeof ref !== 'string' || !/^[a-z][a-z0-9-]{0,45}$/.test(ref) || owners.has(ref) ||
        typeof name !== 'string' || !name.trim()) throw new Error('模板包含重复或无效的成员。')
    owners.add(ref)
    return { ref, name }
  })
  if (!Array.isArray(data.workflows) || !data.workflows.length || data.workflows.length > 100) {
    throw new Error('请选择包含工作流的模板文件。')
  }
  return { bots, workflows: data.workflows.map(flow => normalizeWorkflow(flow, owners)) }
}
