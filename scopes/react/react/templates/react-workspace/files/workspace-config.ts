import { WorkspaceContext } from '@teambit/generator';
import { getWorkspaceConfigTemplateParsed, stringifyWorkspaceConfig } from '@teambit/config';

export async function workspaceConfig({ name, defaultScope, empty }: WorkspaceContext) {
  const configParsed = await getWorkspaceConfigTemplateParsed();
  configParsed['teambit.workspace/workspace'].name = name;
  configParsed['teambit.workspace/workspace'].defaultScope = empty
    ? defaultScope || 'company.scope'
    : defaultScope || 'company.demo';
  configParsed['teambit.dependencies/dependency-resolver'].packageManager = 'teambit.dependencies/pnpm';
  configParsed['teambit.dependencies/dependency-resolver'].policy = {
    dependencies: {},
    peerDependencies: {
      '@testing-library/react': '11.2.6',
      react: '16.13.1',
      'react-dom': '16.13.1',
    },
  };

  configParsed['teambit.workspace/variants'] = empty
    ? {
        '*': {
          // all components use the default react env by teambit
          'teambit.react/react': {},
        },
      }
    : {
        '{**/ui/**}, {**/pages/**}': {
          // all the components using the ui and pages namespace will use the customized react environment in the workspace
          'company.demo/templates/envs/my-react': {},
          // to use the default react env by teambit instead of the custom env uncomment the following line and remove the line above:
          // "teambit.harmony/react": {},
        },
        '{**/envs/**}, {**/extensions/**}': {
          // all the components using the envs and extensions namespace will use the aspect environment in the workspace
          'teambit.harmony/aspect': {},
        },
        '{**/content/**}': {
          // all the components using the content namespace will use the mdx environment in the workspace
          'teambit.mdx/mdx': {},
        },
      };

  return stringifyWorkspaceConfig(configParsed);
}
