const { WorkspaceAspect } = require('@teambit/workspace');
class ForkBatchBarrier {
  static dependencies = [WorkspaceAspect];
  static async provider([workspace]) {
    workspace.registerOnComponentAdd(async (component) => {
      if (component.id.scope === 'fixture.tools') return;
      // The actual tracker bitmap write precedes onAdd. Separate that backup
      // from the next copy's write without changing clocks or history data.
      await new Promise(resolve => setTimeout(resolve, 1100));
    });
    return new ForkBatchBarrier();
  }
}
module.exports = { default: ForkBatchBarrier };
