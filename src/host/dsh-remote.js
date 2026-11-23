import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

// The Host supplies the invocation-bound peer. Member IDs and other payload fields
// are business inputs and can never establish who made a request.
export function requireOwner(invocation) {
  if (invocation?.peer?.principal?.kind !== 'owner') {
    throw new RemoteError('remote-access/denied', 'Only the dsh profile owner can control NativeCrew', {
      action: 'godbot/' + (invocation?.request?.method ?? 'unknown'), reason: 'no-allow',
    })
  }
}

// DSH discovers JavaScript Remote markers through the standard decorator
// initializer. Parameter names are used by the Gateway's source-mode dispatcher.
export function createNativeCrewRemote(service) {
  const initializers = []
  class NativeCrewRemote extends TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'godbot')
      for (const initialize of initializers) initialize.call(this)
    }
    async snapshot() {
      requireOwner(this.ctx.invocation)
      return service.snapshot()
    }
    async slashCommands(target) {
      requireOwner(this.ctx.invocation)
      return service.slashCommands(target)
    }
    async claudeReportSession(target) {
      requireOwner(this.ctx.invocation)
      return service.claudeReportSession(target)
    }
    async claudeStats(target) {
      requireOwner(this.ctx.invocation)
      return service.claudeStats(target)
    }
    async machine(request) {
      requireOwner(this.ctx.invocation)
      return service.machine(request, this.ctx.invocation.peer, this.ctx.invocation.signal)
    }
    async terminalStatus(request) {
      requireOwner(this.ctx.invocation)
      return service.terminalStatus(request)
    }
    async terminalOpen(request) {
      requireOwner(this.ctx.invocation)
      return service.terminalOpen(request)
    }
    async terminalRead(request) {
      requireOwner(this.ctx.invocation)
      return service.terminalRead(request, this.ctx.invocation.signal)
    }
    async terminalWrite(request) {
      requireOwner(this.ctx.invocation)
      return service.terminalWrite(request)
    }
    async terminalResize(request) {
      requireOwner(this.ctx.invocation)
      return service.terminalResize(request)
    }
    async terminalClose(request) {
      requireOwner(this.ctx.invocation)
      return service.terminalClose(request)
    }
    async dispatch(request) {
      requireOwner(this.ctx.invocation)
      if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') {
        throw new RemoteError('gateway/bad-request', 'A NativeCrew action is required', {})
      }
      return service.dispatch(request)
    }
  }
  for (const name of ['snapshot', 'machine', 'slashCommands', 'claudeStats', 'claudeReportSession', 'terminalStatus', 'terminalOpen', 'terminalRead', 'terminalWrite', 'terminalResize', 'terminalClose', 'dispatch']) {
    Remote(NativeCrewRemote.prototype[name], {
      kind: 'method', name, static: false, private: false, metadata: {},
      addInitializer: initialize => initializers.push(initialize),
    })
  }
  return NativeCrewRemote
}
