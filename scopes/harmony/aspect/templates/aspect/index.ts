import { ComponentContext, ComponentTemplate } from '@teambit/generator';
import { indexFile } from './files/index';
import { aspectFile } from './files/aspect-file';
import { mainRuntime, MainRuntimeFragments } from './files/main-runtime';

export {
  MainRuntimeFragments as MainRuntimeTemplateFragments,
  PartialMainRuntimeFragments as PartialMainRuntimeTemplateFragments,
} from './files/main-runtime';

export const aspectTemplate: ComponentTemplate = {
  name: 'aspect',
  description: 'extend Bit capabilities',
  generateFiles: (context: ComponentContext, mainRuntimeFragments?: MainRuntimeFragments) => {
    return [
      {
        relativePath: 'index.ts',
        content: indexFile(context),
        isMain: true,
      },
      {
        relativePath: `${context.name}.aspect.ts`,
        content: aspectFile(context),
      },
      {
        relativePath: `${context.name}.main.runtime.ts`,
        content: mainRuntime(context, mainRuntimeFragments),
      },
    ];
  },
};
