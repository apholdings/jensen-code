import { registerAbandonTests, registerCancelTests, registerLifecycleTests } from "./continuation-cli.test-support.js";

registerLifecycleTests();
registerCancelTests();
registerAbandonTests();
