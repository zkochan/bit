import type { ServiceDescriptor } from './service-descriptor';
/**
 * definition of the service handler.
 */
export type ServiceHandler = Omit<ServiceDescriptor, 'version' | 'config'> & {
  /**
   * serialized config of the tester.
   */
  displayConfig?(): string;

  /**
   * return the tester version.
   */
  version(): string;
};
