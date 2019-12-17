import format from 'string-format';
import { Framework, StylingFrameworks, TypingsSystem, DepsObject, DepsTypes } from './init-interactive-types';

export const TOP_MESSAGE = `This utility initialize an empty Bit workspace and walks you through creating a bit configuration.
You can later edit your configuration in your package.json or bit.json.
Press ^C at any time to quit.

After setting up the workspace, use 'bit add' to track components and modules.`;

export const ALREADY_INITIALIZED_Q = 'target workspace already exists. pick an action';
export const ALREADY_INITIALIZED_CHOICES = ['overwrite', 'cancel'];

export const PROJECT_TYPE_DETECTED_TEMPLATE_Q = '{type} project type detected';
export const PROJECT_TYPE_DETECTED_Q = type => format(PROJECT_TYPE_DETECTED_TEMPLATE_Q, type);
export const PROJECT_TYPE_Q = 'Select project framework';
export const PROJECT_TYPES_CHOICES = ['React', 'Angular', 'Vue', 'Node', 'Abort'];
export const MANUAL_SELECT_FRAMEWORK_OPTION = 'select different framework';
export const PROJECT_TYPE_DETECTED_CHOICES = ['proceed', MANUAL_SELECT_FRAMEWORK_OPTION];

export const PROJECT_TYPE_SYSTEM_DETECTED_TEMPLATE_Q = '{typeSystem} configuration detected';
export const PROJECT_TYPE_SYSTEM_DETECTED_Q = typeSystem => format(PROJECT_TYPE_SYSTEM_DETECTED_TEMPLATE_Q, typeSystem);
export const PROJECT_TYPE_SYSTEM_Q = 'Select typing';
export const PROJECT_TYPE_SYSTEM_CHOICES = answers => {
  if (answers.projectType === 'react') {
    // No support for react flow at the moment
    return ['Typescript', 'None'];
  }
  return ['Typescript', 'Flow', 'None'];
};
export const MANUAL_SELECT_TYPE_SYSTEM_OPTION = 'select different';
export const PROJECT_TYPE_SYSTEM_DETECTED_CHOICES = ['proceed', MANUAL_SELECT_TYPE_SYSTEM_OPTION];

export const PROJECT_STYLING_DETECTED_TEMPLATE_Q = '{styling} styling detected';
export const PROJECT_STYLING_DETECTED_Q = styling => format(PROJECT_STYLING_DETECTED_TEMPLATE_Q, styling);
export const PROJECT_STYLING_Q = 'Select styling framework';
const STYLED_COMPONENTS_CHOICE = { name: 'StyledComponents', value: 'styled-components' };
const EMOTION_CHOICE = { name: 'Emotion', value: 'emotion' };
export const PROJECT_STYLING_CHOICES = [
  STYLED_COMPONENTS_CHOICE,
  EMOTION_CHOICE,
  'CSS modules (SCSS, SASS)',
  'CSS',
  'None'
];
export const MANUAL_SELECT_STYLING_OPTION = 'select different styling framework';
export const PROJECT_STYLING_DETECTED_CHOICES = ['proceed', MANUAL_SELECT_STYLING_OPTION];

export const PACKAGE_MANAGER_Q = 'Which package manager would you like to use for installing components?';
export const PACKAGE_MANAGER_CHOICES = ['npm', 'yarn'];

export const CONFIG_LOCATION_Q = "Where to place Bit's configuration";
export const CONFIG_LOCATION_CHOICES = [
  { name: 'In dedicated config file', value: 'configFile' },
  { name: 'In package.json', value: 'packageJson' }
];

export function generateAlreadyInitializedQ(alreadyInitialized?: boolean) {
  const message = ALREADY_INITIALIZED_Q;
  const choices = ALREADY_INITIALIZED_CHOICES;
  const when = answers => {
    alreadyInitialized === true;
  };
  const question = {
    type: 'list',
    name: 'projectType',
    message,
    when,
    choices
  };
  return question;
}

export function generateProjectTypeQ(detectedType?: string, secondTime: boolean = false) {
  const message = detectedType ? PROJECT_TYPE_DETECTED_Q(detectedType) : PROJECT_TYPE_Q;
  const choices = detectedType ? PROJECT_TYPE_DETECTED_CHOICES : PROJECT_TYPES_CHOICES;
  const filter = defaultFilterFunction;
  const when = answers => {
    // Always show the question first time
    if (!secondTime) {
      return true;
    }
    // Only show the question again if the user asks for it
    if (answers.projectType === MANUAL_SELECT_FRAMEWORK_OPTION) {
      return true;
    }
  };
  const question = {
    type: 'list',
    name: 'projectType',
    message,
    filter,
    when,
    choices
  };
  return question;
}

export function generateProjectTypeSystemQ(detectedTypeSystem?: string, secondTime: boolean = false) {
  const message = detectedTypeSystem ? PROJECT_STYLING_DETECTED_Q(detectedTypeSystem) : PROJECT_STYLING_Q;
  const choices = detectedTypeSystem ? PROJECT_STYLING_DETECTED_CHOICES : PROJECT_STYLING_CHOICES;
  const filter = defaultFilterFunction;
  const when = answers => {
    // never ask about type system for angular project
    if (answers.projctType === 'angular') {
      return false;
    }

    if (!secondTime) {
      return true;
    }
    // Only show the question again if the user asks for it
    if (answers.typeSystem === MANUAL_SELECT_TYPE_SYSTEM_OPTION) {
      return true;
    }
  };
  const question = {
    type: 'list',
    name: 'typeSystem',
    message,
    filter,
    when,
    choices
  };
  return question;
}

export function generateProjectStylingQ(detectedStylings?: string, secondTime: boolean = false) {
  const message = detectedStylings ? PROJECT_TYPE_SYSTEM_DETECTED_Q(detectedStylings) : PROJECT_TYPE_Q;
  const choices = detectedStylings ? PROJECT_TYPE_SYSTEM_DETECTED_CHOICES : PROJECT_TYPE_SYSTEM_CHOICES;
  const when = answers => {
    // Always show the question first time
    if (!secondTime) {
      return true;
    }
    // Only show the question again if the user asks for it
    if (answers.styling === MANUAL_SELECT_STYLING_OPTION) {
      return true;
    }
  };
  const question = {
    type: 'list',
    name: 'styling',
    message,
    when,
    choices
  };
  return question;
}

export function generatePackageManagerQ() {
  const message = PACKAGE_MANAGER_Q;
  const choices = PACKAGE_MANAGER_CHOICES;
  const question = {
    type: 'list',
    name: 'pacakgeManager',
    message,
    choices
  };
  return question;
}

export function generateConfigurationLocationQ() {
  const message = CONFIG_LOCATION_Q;
  const choices = CONFIG_LOCATION_CHOICES;
  const question = {
    type: 'list',
    name: 'configLocation',
    message,
    choices
  };
  return question;
}

const defaultFilterFunction = val => {
  const lower = val.toLowerCase();
  if (lower === 'none') return undefined;
  return lower;
};

export default function getInitQuestions(
  alreadyInitialized: boolean = false,
  detectedFramework?: Framework,
  detectedTyping?: TypingsSystem,
  detectedStyling?: StylingFrameworks
) {
  return [
    generateAlreadyInitializedQ(alreadyInitialized),
    generateProjectTypeQ(detectedFramework),
    generateProjectTypeQ(undefined, true),
    generateProjectTypeSystemQ(detectedTyping),
    generateProjectTypeSystemQ(undefined, true),
    generateProjectStylingQ(detectedStyling),
    generateProjectStylingQ(undefined, true),
    generatePackageManagerQ(),
    generateConfigurationLocationQ()
  ];
}
