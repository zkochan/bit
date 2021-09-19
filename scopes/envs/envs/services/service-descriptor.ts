/**
 * definition of the service descriptor.
 */
export interface ServiceDescriptor {
  /**
   * id of the service handler.
   */
  id: string;

  /**
   * display name of the service handler.
   */
  displayName?: string;

  /**
   * icon of the service handler.
   */
  icon?: string;

  /**
   * serialized config of the service handler.
   */
  config: string;

  /**
   * return the service handler version.
   */
  version: string;
}
