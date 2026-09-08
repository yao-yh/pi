import type { RemoteServiceTransport } from "../types.ts";
import type { RemoteServiceProvider } from "./provider.ts";

/** 在不改变远程服务语义的情况下，将提供方连接到绑定。 */
export function createLoopbackServiceTransport(provider: RemoteServiceProvider): RemoteServiceTransport {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = provider.subscribe(serviceId, mode, listener);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}
