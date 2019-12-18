import format from 'string-format';
import { Framework, StylingFrameworks, TypingsSystem, DepsObject, DepsTypes } from './init-interactive-types';

export const TOP_MESSAGE = `This utility initialize an empty Bit workspace and walks you through creating a bit configuration.
You can later edit your configuration in your package.json or bit.json.
Press ^C at any time to quit.

After setting up the workspace, use 'bit add' to track components and modules.`;

export const ALREADY_INITIALIZED_Q = 'target workspace already exists. pick an action';
export const ALREADY_INITIALIZED_CANCEL_OPTION = 'cancel';
export const ALREADY_INITIALIZED_CHOICES = ['overwrite', ALREADY_INITIALIZED_CANCEL_OPTION];

export const PROJECT_TYPE_DETECTED_TEMPLATE_Q = '{type} project type detected';
export const PROJECT_TYPE_DETECTED_Q = type => format(PROJECT_TYPE_DETECTED_TEMPLATE_Q, { type });
export const PROJECT_TYPE_Q = 'Select project framework';
export const PROJECT_TYPES_CHOICES = ['React', 'Angular', 'Vue', 'Node', 'Abort'];
export const MANUAL_SELECT_FRAMEWORK_OPTION = 'select different framework';
export const PROJECT_TYPE_DETECTED_CHOICES = type =>
  getAutoDetectedChoicesWithValue(type, [MANUAL_SELECT_FRAMEWORK_OPTION]);

export const PROJECT_TYPE_SYSTEM_DETECTED_TEMPLATE_Q = '{typeSystem} configuration detected';
export const PROJECT_TYPE_SYSTEM_DETECTED_Q = typeSystem =>
  format(PROJECT_TYPE_SYSTEM_DETECTED_TEMPLATE_Q, { typeSystem });
export const PROJECT_TYPE_SYSTEM_Q = 'Select typing';
export const PROJECT_TYPE_SYSTEM_CHOICES = answers => {
  if (answers.projectType === 'react') {
    // No support for react flow at the moment
    return ['Typescript', 'None'];
  }
  return ['Typescript', 'Flow', 'None'];
};
export const MANUAL_SELECT_TYPE_SYSTEM_OPTION = 'select different';
export const PROJECT_TYPE_SYSTEM_DETECTED_CHOICES = typeSystem =>
  getAutoDetectedChoicesWithValue(typeSystem, [MANUAL_SELECT_TYPE_SYSTEM_OPTION]);

export const PROJECT_STYLING_DETECTED_TEMPLATE_Q = '{styling} styling detected';
export const PROJECT_STYLING_DETECTED_Q = styling => format(PROJECT_STYLING_DETECTED_TEMPLATE_Q, { styling });
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
export const PROJECT_STYLING_DETECTED_CHOICES = styling =>
  getAutoDetectedChoicesWithValue(styling, [MANUAL_SELECT_STYLING_OPTION]);

export const PACKAGE_MANAGER_Q = 'Which package manager would you like to use for installing components?';
export const PACKAGE_MANAGER_CHOICES = ['npm', 'yarn'];

export const CONFIG_LOCATION_Q = "Where to place Bit's configuration";
export const CONFIG_LOCATION_CHOICES = [
  { name: 'In dedicated config file', value: 'configFile' },
  { name: 'In package.json', value: 'packageJson' }
];

/**
 * A function that create an array of choices when the proceed option value is set to specific value
 * For example when react project detected and we click proceed we want the project type value to be react
 * @param proceedValue Value to enter in the answers object in case of proceed choosed
 * @param extraChoices Extra options to show in the list
 */
function getAutoDetectedChoicesWithValue(proceedValue: string, extraChoices: string[]) {
  const proceedOptionLabel = 'proceed';
  return [{ name: proceedOptionLabel, value: proceedValue }, ...extraChoices];
}

export function generateAlreadyInitializedQ(alreadyInitialized?: boolean) {
  const message = ALREADY_INITIALIZED_Q;
  const choices = ALREADY_INITIALIZED_CHOICES;
  const when = answers => {
    return alreadyInitialized === true;
  };
  const question = {
    type: 'list',
    name: 'handleAlreadyInitialized',
    message,
    when,
    choices
  };
  return question;
}

export function generateProjectTypeQ(detectedType?: string, secondTime: boolean = false) {
  const message = detectedType ? PROJECT_TYPE_DETECTED_Q(detectedType) : PROJECT_TYPE_Q;
  const choices = detectedType ? PROJECT_TYPE_DETECTED_CHOICES(detectedType) : PROJECT_TYPES_CHOICES;
  const filter = defaultFilterFunction;
  const specificWhen = answers => {
    // Always show the question first time
    if (!secondTime) {
      return true;
    }
    // Only show the question again if the user asks for it
    if (answers.projectType === MANUAL_SELECT_FRAMEWORK_OPTION) {
      return true;
    }
    return false;
  };
  const when = wrapWhenWithCancelCheck(specificWhen);
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
  const message = detectedTypeSystem ? PROJECT_TYPE_SYSTEM_DETECTED_Q(detectedTypeSystem) : PROJECT_TYPE_Q;
  const choices = detectedTypeSystem
    ? PROJECT_TYPE_SYSTEM_DETECTED_CHOICES(detectedTypeSystem)
    : PROJECT_TYPE_SYSTEM_CHOICES;
  const filter = defaultFilterFunction;
  const specificWhen = answers => {
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
    return false;
  };
  const when = wrapWhenWithCancelCheck(specificWhen);

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
  const message = detectedStylings ? PROJECT_STYLING_DETECTED_Q(detectedStylings) : PROJECT_STYLING_Q;
  const choices = detectedStylings ? PROJECT_STYLING_DETECTED_CHOICES(detectedStylings) : PROJECT_STYLING_CHOICES;
  const specificWhen = answers => {
    // Always show the question first time
    if (!secondTime) {
      return true;
    }
    // Only show the question again if the user asks for it
    if (answers.styling === MANUAL_SELECT_STYLING_OPTION) {
      return true;
    }
    return false;
  };
  const when = wrapWhenWithCancelCheck(specificWhen);

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
  const when = wrapWhenWithCancelCheck();

  const question = {
    type: 'list',
    name: 'pacakgeManager',
    message,
    when,
    choices
  };
  return question;
}

export function generateConfigurationLocationQ() {
  const message = CONFIG_LOCATION_Q;
  const choices = CONFIG_LOCATION_CHOICES;
  const when = wrapWhenWithCancelCheck();

  const question = {
    type: 'list',
    name: 'configLocation',
    message,
    when,
    choices
  };
  return question;
}

const defaultFilterFunction = val => {
  const lower = val.toLowerCase();
  if (lower === 'none') return undefined;
  return lower;
};

/**
 * Wrap a specific when function of a question with a check if the user press cancel in case the project was already
 * initialized by bit.
 * It will also generate a when with this check only if there is no specific when
 * This will return a new when function to pass to inquirer
 * @param specificWhen The when function of the specific question
 */
const wrapWhenWithCancelCheck = (specificWhen?: (answers) => boolean): ((answers) => boolean) => (answers): boolean => {
  if (answers.handleAlreadyInitialized === ALREADY_INITIALIZED_CANCEL_OPTION) {
    return false;
  }
  if (!specificWhen) {
    return true;
  }
  return specificWhen(answers);
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
