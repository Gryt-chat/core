/* For the apps' own tests: the in-memory delivery service and state store the driver's tests
   use, so a session can run the real driver against it. Not for app code. */

export { FakeDeliveryService, MemoryMlsStore } from "./mls/deliveryService.fake.js";
