import { NextResponse } from "next/server";
import { loadTags, saveTags, type ProductTag } from "@/lib/store";

export async function GET() {
  return NextResponse.json(await loadTags());
}

export async function POST(req: Request) {
  const { project, tag } = await req.json() as { project: string; tag: ProductTag | null };
  const tags = await loadTags();
  if (!tag) delete tags[project];
  else tags[project] = tag;
  await saveTags(tags);
  return NextResponse.json({ ok: true });
}
