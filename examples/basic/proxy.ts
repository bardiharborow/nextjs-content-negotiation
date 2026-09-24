import { createNegotiationProxy } from "nextjs-content-negotiation/proxy";
import negotiation from "./negotiation.config";

export const proxy = createNegotiationProxy(negotiation);

export const config = {
  matcher: ["/docs/:path*", "/data/:id"],
};
