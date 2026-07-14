// Minimal typing for Cordova's exec bridge. The module is provided at runtime by
// cordova.js inside the app (the bundle marks it external — see the `bundle`
// script), so no @types package is needed.
declare module "cordova/exec" {
  function exec(
    success: (result?: any) => void,
    error: (err?: any) => void,
    service: string,
    action: string,
    args?: unknown[]
  ): void;
  export = exec;
}
