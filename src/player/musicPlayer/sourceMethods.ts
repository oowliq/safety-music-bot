import { trackFactoryMethods } from './trackFactoryMethods.ts';
import { urlResolverMethods } from './urlResolverMethods.ts';

export const sourceMethods = {
  ...trackFactoryMethods,
  ...urlResolverMethods,
};
