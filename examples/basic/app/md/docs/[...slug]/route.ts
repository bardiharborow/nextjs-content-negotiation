export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  return new Response(`# Docs: ${slug.join("/")}\n`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
