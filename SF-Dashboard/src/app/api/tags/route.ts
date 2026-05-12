import { NextRequest, NextResponse } from "next/server";
import { loadTags, saveTags, type ProductTag } from "@/lib/store";

export async function GET(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({});
  return NextResponse.json(await loadTags(username));
}

export async function POST(req: NextRequest) {
  const username = req.cookies.get("sf_user")?.value;
  if (!username) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { project, tag } = await req.json() as { project: string; tag: ProductTag | null };
  const tags = await loadTags(username);
  if (!tag) delete tags[project];
  else tags[project] = tag;
  await saveTags(tags, username);
  return NextResponse.json({ ok: true });
}
