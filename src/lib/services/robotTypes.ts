import type { RobotType, RobotTypeSpec } from "./types";

/**
 * Registry of supported robot types and their onboarding defaults.
 * Add a new entry here to support another platform end-to-end.
 */
export const ROBOT_TYPES: RobotTypeSpec[] = [
  {
    id: "unitree-g1",
    name: "Unitree G1",
    vendor: "Unitree",
    platform: "humanoid",
    defaultEthernetIp: "192.168.123.164",
    defaultSshUser: "unitree",
  },
  {
    id: "engineai-t800",
    name: "EngineAI T800",
    vendor: "EngineAI",
    platform: "humanoid",
    defaultEthernetIp: "192.168.1.100",
    defaultSshUser: "root",
    note: "Default IP unconfirmed — verify the T800's wired address before scanning.",
    comingSoon: true, // temporarily disabled across the app
  },
];

export function robotTypeSpec(id: RobotType): RobotTypeSpec {
  return ROBOT_TYPES.find((t) => t.id === id) ?? ROBOT_TYPES[0];
}
