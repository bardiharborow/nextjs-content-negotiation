export default async function Page({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  return <h1>English docs: {slug.join("/")}</h1>;
}

// Prerendered, so the smoke test covers static pages as well as dynamic ones.
export function generateStaticParams() {
  return [{ slug: ["intro"] }];
}
