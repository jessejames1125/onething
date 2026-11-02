/**
 * Every module, listed once.
 */
import type { ModuleDef } from "../core/types";
import capture from "./capture/index";
import planner from "./planner/index";

const MODULES: ModuleDef[] = [capture, planner];

let override: ModuleDef[] | null = null;

export function getModules(): ModuleDef[] {
  return override ?? MODULES;
}

export function getModule(name: string): ModuleDef | undefined {
  return getModules().find((m) => m.name === name);
}

/** Tests: swap the module list (pass null to restore). */
export function setModulesForTest(mods: ModuleDef[] | null): void {
  override = mods;
}
