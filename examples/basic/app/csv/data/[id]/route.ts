export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return new Response(`id,name\n${id},Item ${id}\n`, {
    headers: { "Content-Type": "text/csv; charset=utf-8" },
  });
}
