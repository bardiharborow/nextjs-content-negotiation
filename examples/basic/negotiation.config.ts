import { defineNegotiation } from "nextjs-content-negotiation";

export default defineNegotiation({
  rules: [
    {
      source: "/docs/:path*",
      variants: [
        { type: "text/html", language: "en" },
        { type: "text/html", language: "fr", destination: "/fr/docs/:path*" },
        { type: "text/markdown", destination: "/md/docs/:path*" },
      ],
    },
    {
      source: "/data/:id",
      variants: [
        { type: "application/json" },
        { type: "text/csv", destination: "/csv/data/:id" },
      ],
      onNoMatch: 406,
    },
  ],
  // The language-neutral Markdown variant would win `Accept: */*` for
  // browsers whose language is not offered.
  skipProxyUrlNormalize: true,
});
