// Built-in drivers register themselves on import.
import "./acp.js";
import "./terminal.js";
import "./chat-api.js";
import "./a2a.js";

export { acpDriver, acpDriverFactory } from "./acp.js";
export type { AcpDriverOptions } from "./acp.js";
export { terminalDriver } from "./terminal.js";
export { chatApiDriverFactory } from "./chat-api.js";
export { a2aDriverFactory } from "./a2a.js";
export { buildDrivers, driverFactory, driverFor, registerDriver, registeredDriverKinds } from "./registry.js";
export type { Driver, DriverContext, DriverFactory } from "./registry.js";
