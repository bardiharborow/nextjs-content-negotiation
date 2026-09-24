import { createNegotiationProxy } from "nextjs-content-negotiation/proxy";
import negotiation from "./negotiation.config";

export const proxy = createNegotiationProxy(negotiation);

// The variants' own URLs link back to the negotiated URL.
export const config = {
  matcher: [
    "/docs/:path*",
    "/data/:id",
    "/fr/docs/:path*",
    "/md/docs/:path*",
    "/csv/data/:id",
  ],
};
