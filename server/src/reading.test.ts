import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DB_PATH, MODEL_PROFILES_PATH } from "./config.js";
import { db } from "./db.js";
import { chapterNumberWarnings, cleanBookTitle, detectBookType, parseEpub, readChapterIndex, type TocNode } from "./epub.js";
import { app } from "./http.js";
import { locateQuote, stripVerdicts, verifyQuotes } from "./reading-quotes.js";
import { setReadingModelForTests, type ReadingPrompt } from "./reading-model.js";
import { setReadingChunkSizeForTests } from "./reading-notes.js";
import {
  confirmReading,
  continueReading,
  importEpubBuffer,
  mergeReadingChapter,
  recoverInterruptedReading,
  removeReading,
  renameReadingChapter,
  reopenReading,
  startReading,
  switchReadingLevel,
  updateReading,
} from "./reading-service.js";
import { getBookDetail, listChaptersWithText } from "./reading-db.js";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const calls: ReadingPrompt[] = [];
let failTitle = "";
let failedOnce = false;

function resetModel(): void {
  calls.length = 0;
  failTitle = "";
  failedOnce = false;
  setReadingChunkSizeForTests(null);
  setReadingModelForTests(async (prompt) => {
    calls.push(prompt);
    if (prompt.system.includes("汇总")) {
      return JSON.stringify({
        overview: "这本书值得一读。它把零散的材料收成一条可以复述的线索。",
        corePoints: ["材料需要先被收束。", "值得推荐阅读"],
        characters: ["林深：把话说完的人"],
        themes: ["选择比口号更难"],
        quoteIndexes: [0],
      });
    }
    if (prompt.user.includes("各部分的笔记")) {
      return JSON.stringify({
        summary: "这一章前后两段说的是同一件事。",
        corePoints: ["先看见材料", "再决定留下什么", "最后写成可以核对的句子"],
        plot: "人物把话说完，又把决定留到了下一章。",
        characters: ["林深：把话说完的人"],
        themes: ["选择比口号更难"],
        outline: "这一章把前后两段收成一件事。",
      });
    }
    const title = prompt.user.match(/章节标题：(.+)/)?.[1]?.split("\n")[0] || "";
    if (failTitle && title.includes(failTitle) && !failedOnce) {
      failedOnce = true;
      throw new Error("模型暂时不可用");
    }
    const body = prompt.user.match(/<<<CHAPTER\n([\s\S]*?)\nCHAPTER>>>/)?.[1] || "";
    const sentence = body.match(/[^。！？\n]{12,80}[。！？]/u)?.[0] || "";
    return JSON.stringify({
      summary: `${title}讲了一件可以核对的事。`,
      corePoints: ["先看原文", "再写观点", "原句必须能找到"],
      plot: `${title}里的人把一件事说完了。`,
      characters: ["林深：出现在这一章"],
      themes: ["把话说清楚"],
      quotes: [sentence, "这是模型编造的一句并不存在的话。"],
      outline: `${title}可以用一句话带过。`,
    });
  });
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}

function zip(entries: { name: string; data: Buffer; method: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = entry.method === 8 ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.name === "mimetype" ? 0 : 0x800, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);
    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.name === "mimetype" ? 0 : 0x800, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt32LE(crc32(entry.data), 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);
    central.push(header);
    offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

function xhtml(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>章节</title></head><body>${body}</body></html>`;
}

function ncx(nodes: TocNode[]): string {
  const render = (node: TocNode, id: { n: number }): string => {
    const current = id.n++;
    const children = node.children.map((child) => render(child, id)).join("");
    const src = `${node.href || ""}${node.fragment ? `#${node.fragment}` : ""}`;
    return `<navPoint id="n${current}"><navLabel><text>${node.title}</text></navLabel><content src="${src}"/>${children}</navPoint>`;
  };
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${nodes.map((node) => render(node, { n: 1 })).join("")}</navMap></ncx>`;
}

function opf(input: { title: string; author?: string; subject?: string; spine: string[]; ncx?: boolean }): string {
  const items = input.spine.map((href, index) => `<item id="c${index}" href="${href}" media-type="application/xhtml+xml"/>`).join("");
  const ncxItem = input.ncx === false ? "" : `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;
  const spine = input.spine.map((_, index) => `<itemref idref="c${index}"/>`).join("");
  const tocAttr = input.ncx === false ? "" : ` toc="ncx"`;
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${input.title}</dc:title>
    <dc:creator>${input.author || ""}</dc:creator>
    <dc:language>zh</dc:language>
    <dc:subject>${input.subject || ""}</dc:subject>
  </metadata>
  <manifest>${items}${ncxItem}</manifest>
  <spine${tocAttr}>${spine}</spine>
</package>`;
}

function pack(files: Record<string, string>, extra: Record<string, string> = {}): Buffer {
  return packBuffers({
    ...Object.fromEntries(Object.entries({ ...files, ...extra }).map(([name, data]) => [name, Buffer.from(data)])),
  });
}

function packBuffers(files: Record<string, Buffer>): Buffer {
  const entries = [
    { name: "mimetype", data: Buffer.from("application/epub+zip"), method: 0 },
    { name: "META-INF/container.xml", data: Buffer.from(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`), method: 8 },
    ...Object.entries(files).map(([name, data]) => ({ name, data, method: 8 })),
  ];
  return zip(entries);
}

function chapterBook(input: {
  title: string;
  author?: string;
  subject?: string;
  toc: TocNode[];
  files: Record<string, string>;
  spine: string[];
  ncx?: boolean;
}): Buffer {
  const files: Record<string, string> = {
    "OEBPS/content.opf": opf({ title: input.title, author: input.author, subject: input.subject, spine: input.spine, ncx: input.ncx }),
  };
  if (input.ncx !== false) files["OEBPS/toc.ncx"] = ncx(input.toc);
  for (const [name, html] of Object.entries(input.files)) files[`OEBPS/${name}`] = html;
  return pack(files);
}

function countRows(table: string, bookId: string): number {
  const column = table === "books" ? "id" : "book_id";
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(bookId) as { count: number };
  return Number(row.count);
}

function freshDetail(bookId: string) {
  db.exec("PRAGMA wal_checkpoint(FULL)");
  const script = join(tmpdir(), `reading-restart-${process.pid}.mts`);
  const moduleUrl = pathToFileURL(join(serverRoot, "src/reading-db.ts")).href;
  writeFileSync(script, `import { getBookDetail } from ${JSON.stringify(moduleUrl)};
const detail = getBookDetail(process.env.BOOK_ID || "");
if (!detail) process.exit(2);
process.stdout.write(JSON.stringify({
  title: detail.title,
  author: detail.author,
  status: detail.status,
  confirmed: detail.confirmed,
  chapters: detail.chapters.map((chapter) => ({ title: chapter.title, outline: chapter.note?.outline || null, quote: chapter.note?.quotes[0]?.text || null })),
  overview: detail.report?.overview || null,
}));
`);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: serverRoot,
    env: { ...process.env, BOOK_ID: bookId },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as {
    title: string;
    author: string;
    status: string;
    confirmed: boolean;
    chapters: { title: string; outline: string | null; quote: string | null }[];
    overview: string | null;
  };
}

const nested = () => chapterBook({
  title: "随便一本笔记",
  author: "测试",
  toc: [
    {
      title: "第1章 开端",
      href: "a.xhtml",
      fragment: null,
      children: [
        { title: "小节甲", href: "b.xhtml", fragment: null, children: [] },
        { title: "小节乙", href: "c.xhtml", fragment: null, children: [] },
      ],
    },
    { title: "第2章 收束", href: "d.xhtml", fragment: null, children: [] },
  ],
  spine: ["a.xhtml", "b.xhtml", "c.xhtml", "d.xhtml"],
  files: {
    "a.xhtml": xhtml("<p>第1章 开端</p><p>开端这一句会留在合并后的第一章里面，用来核对原句。</p>"),
    "b.xhtml": xhtml("<p>小节甲</p><p>小节甲把一个可以核对的句子放在这里，后面还补了一句。</p>"),
    "c.xhtml": xhtml("<p>小节乙</p><p>小节乙也有一句必须能在原文里找到的话，后面还补了一句。</p>"),
    "d.xhtml": xhtml("<p>第2章 收束</p><p>收束这一句单独留在第二章，不被上一章吞掉，后面还补了一句。</p>"),
  },
});

const parts = () => chapterBook({
  title: "笔记样本",
  toc: [
    { title: "引言", href: "intro.xhtml", fragment: null, children: [] },
    {
      title: "第一篇",
      href: "part.xhtml",
      fragment: null,
      children: [
        { title: "第一章 聚集", href: "ch1.xhtml", fragment: null, children: [] },
        { title: "第二章 分散", href: "ch2.xhtml", fragment: null, children: [] },
      ],
    },
  ],
  spine: ["intro.xhtml", "part.xhtml", "ch1.xhtml", "ch2.xhtml"],
  files: {
    "intro.xhtml": xhtml("<p>引言</p><p>引言先把阅读的范围说清楚，后面才进入正文。</p>"),
    "part.xhtml": xhtml("<p>第一篇</p><p>篇首只有这一句交代，应该跟在后面的章一起走。</p>"),
    "ch1.xhtml": xhtml("<p>第一章 聚集</p><p>聚集这一章写出一句可以核对的原话。</p>"),
    "ch2.xhtml": xhtml("<p>第二章 分散</p><p>分散这一章也写出一句可以核对的原话。</p>"),
  },
});

describe("reading epub", () => {
  before(() => {
    assert.ok(process.env.WORKBENCH_HOME && !process.env.WORKBENCH_HOME.includes("/.workbench"));
    resetModel();
  });

  after(() => {
    setReadingModelForTests(null);
    setReadingChunkSizeForTests(null);
  });

  it("cleans marketing titles and keeps a real subtitle", () => {
    assert.equal(cleanBookTitle("作家榜经典：乌合之众(新版！《乌合之众》原版原意终于恢复！译者荣获法国三任总理授骑士勋章！) (大星文化出品)"), "乌合之众");
    assert.equal(cleanBookTitle("定位:有史以来对美国营销影响最大的观念"), "定位");
    assert.equal(cleanBookTitle("遥远的救世主：根据本书改编的电视剧《天道》正在全国掀起极大反响"), "遥远的救世主");
    assert.equal(cleanBookTitle("人类简史：从动物到上帝"), "人类简史：从动物到上帝");
  });

  it("detects fiction from bare chapter titles or subject metadata", () => {
    const bare = Array.from({ length: 8 }, (_, index) => `第${index + 1}章`);
    assert.equal(detectBookType(bare, ""), "fiction");
    assert.equal(detectBookType(["第1章 到底何为定位", "第2章 心智备受骚扰"], ""), "nonfiction");
    assert.equal(detectBookType(["第一章 聚集", "第二章 分散"], "长篇小说"), "fiction");
  });

  it("merges subsection files into the parent chapter and can switch level", () => {
    const parsed = parseEpub(nested());
    assert.equal(parsed.title, "随便一本笔记");
    assert.equal(parsed.bookType, "nonfiction");
    assert.equal(parsed.splitSource, "toc");
    assert.equal(parsed.selectedLevel, 0);
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["第1章 开端", "第2章 收束"]);
    assert.match(parsed.chapters[0].text, /小节乙也有一句/);
    assert.equal(parsed.chapters[0].text.includes("收束这一句"), false);
    const finer = parsed.levels.find((level) => level.depth === 1);
    assert.ok(finer);
    assert.equal(finer.chapterCount > parsed.chapters.length, true);
  });

  it("does not collapse a flat toc just because the title is a known book", () => {
    const parsed = parseEpub(chapterBook({
      title: "定位:有史以来对美国营销影响最大的观念",
      author: "阿尔·里斯(Al Ries)",
      toc: [
        { title: "传播过度的社会", href: "s1.xhtml", fragment: null, children: [] },
        { title: "过度简化的心智", href: "s2.xhtml", fragment: null, children: [] },
        { title: "尽量简化信息", href: "s3.xhtml", fragment: null, children: [] },
      ],
      spine: ["s1.xhtml", "s2.xhtml", "s3.xhtml"],
      files: {
        "s1.xhtml": xhtml("<p>传播过度的社会里，这句话必须留在自己的章节，不能并进别的章。</p>"),
        "s2.xhtml": xhtml("<p>过度简化的心智里，另一句话不能并进上一节，要单独成章。</p>"),
        "s3.xhtml": xhtml("<p>尽量简化信息这一节仍然是独立的一章，正文写得足够长。</p>"),
      },
    }));
    assert.equal(parsed.title, "定位");
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["传播过度的社会", "过度简化的心智", "尽量简化信息"]);
  });

  it("prefers 章 over 篇 when both levels exist", () => {
    const parsed = parseEpub(parts());
    assert.equal(parsed.selectedLevel, 1);
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["引言", "第一章 聚集", "第二章 分散"]);
    assert.match(parsed.chapters[1].text, /篇首只有这一句/);
    assert.match(parsed.chapters[1].text, /聚集这一章/);
    assert.equal(parsed.chapters[0].text.includes("篇首只有这一句"), false);
  });

  it("falls back to in-text headings when the toc is missing", () => {
    const parsed = parseEpub(chapterBook({
      title: "没有目录的书",
      toc: [],
      ncx: false,
      spine: ["all.xhtml"],
      files: {
        "all.xhtml": xhtml(`<h1>第三章 海边</h1><p>${"海风把这句可以核对的话留在岸边，这段写得足够长。".repeat(12)}</p><h1>第四章 山里</h1><p>${"山路把另一句可以核对的话藏进雾里，这段也写得足够长。".repeat(12)}</p>`),
      },
    }));
    assert.equal(parsed.splitSource, "spine");
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["第三章 海边", "第四章 山里"]);
    assert.match(parsed.chapters[0].text, /海风把这句/);
    assert.equal(parsed.chapters[0].text.includes("山路把另一句"), false);
  });

  it("splits a chapter title that sits on its own line at the end of the previous paragraph", () => {
    const parsed = parseEpub(chapterBook({
      title: "回目粘在上一段",
      toc: [],
      ncx: false,
      spine: ["body.xhtml"],
      files: {
        "body.xhtml": xhtml(`<p>版权留在正文里。${"开头这段要单独成章，所以写得比后面的回目更铺得开。".repeat(8)}</p>
<p>上一回的人说到这里。要知端的，下回分解。
第一回 甄士隐遇见贾雨村</p>
<p>${"海风把这句可以核对的话留在原处，这段写得足够长，不能被切掉。".repeat(8)}</p>
<p>这一回也到了结尾。下回分解。
第二回</p>
<p>${"冷子兴把荣国府的事说完，这段同样写得足够长，不能并进上一回。".repeat(8)}</p>
<p>第四回中既将薛家母子寄居的事略已表明，此回则接着写林黛玉，这段是正文不是新的一回。</p>
<p>下回分解。
第三回 贾雨村复职，话说雨村刚欲过渡，就遇见了故人，这段写得足够长。</p>
<p>${"雨村过了河又遇见故人，这一回因此也能单独成章。".repeat(8)}</p>`),
      },
    }));
    assert.equal(parsed.splitSource, "spine");
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["开头", "第一回 甄士隐遇见贾雨村", "第二回", "第三回 贾雨村复职"]);
    assert.match(parsed.chapters[0].text, /版权留在正文里/);
    assert.equal(parsed.chapters[0].text.includes("海风把这句"), false);
    assert.match(parsed.chapters[1].text, /海风把这句/);
    assert.match(parsed.chapters[2].text, /冷子兴/);
    assert.match(parsed.chapters[2].text, /第四回中既将/);
    assert.match(parsed.chapters[3].text, /遇见了故人/);
    assert.ok(coverageRatio(parsed) >= 0.9);
  });

  it("falls back when toc hrefs do not match the spine", () => {
    const parsed = parseEpub(chapterBook({
      title: "目录对不上",
      toc: [
        { title: "不存在的章", href: "missing.xhtml", fragment: null, children: [] },
        { title: "也不存在", href: "gone.xhtml", fragment: null, children: [] },
      ],
      spine: ["body.xhtml"],
      files: {
        "body.xhtml": xhtml(`<p>第五章 城里</p><p>${"城里这一句是正文里真实的章节标题，这段写得足够长。".repeat(12)}</p><p>第六章 郊外</p><p>${"郊外这一句跟在后面，不能丢，这段也写得足够长。".repeat(12)}</p>`),
      },
    }));
    assert.equal(parsed.splitSource, "spine");
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["第五章 城里", "第六章 郊外"]);
  });

  it("rejects corrupt and encrypted epubs with a clear error", () => {
    assert.throws(() => parseEpub(Buffer.from("this is not a zip")), /不是有效的 epub|损坏/);
    assert.throws(() => parseEpub(nested().subarray(0, 40)), /不是有效的 epub|损坏/);
    const encrypted = pack({
      "OEBPS/content.opf": opf({ title: "加密样本", spine: ["ch.xhtml"] }),
      "OEBPS/toc.ncx": ncx([{ title: "第一章", href: "ch.xhtml", fragment: null, children: [] }]),
      "OEBPS/ch.xhtml": xhtml("<p>正文其实在，但是文件被加密保护，不能导入。</p>"),
    }, {
      "META-INF/encryption.xml": `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="OEBPS/ch.xhtml"/></CipherData></EncryptedData></encryption>`,
    });
    assert.throws(() => parseEpub(encrypted), /加密/);
    const fontsOnly = pack({
      "OEBPS/content.opf": opf({ title: "只有字体混淆", spine: ["ch.xhtml"] }),
      "OEBPS/toc.ncx": ncx([{ title: "第一章 正文", href: "ch.xhtml", fragment: null, children: [] }]),
      "OEBPS/ch.xhtml": xhtml("<p>字体被混淆时正文仍然可以读，这句话留在章节里，后面还有一句。</p>"),
    }, {
      "META-INF/encryption.xml": `<?xml version="1.0"?><encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="OEBPS/font.otf"/></CipherData></EncryptedData></encryption>`,
    });
    assert.equal(parseEpub(fontsOnly).chapters.length, 1);
  });

  it("marks eight bare chapters as fiction from the toc itself", () => {
    const spine = Array.from({ length: 8 }, (_, index) => `c${index}.xhtml`);
    const parsed = parseEpub(chapterBook({
      title: "一本没写类型的书",
      toc: spine.map((href, index) => ({ title: `第${index + 1}章`, href, fragment: null, children: [] })),
      spine,
      files: Object.fromEntries(spine.map((href, index) => [href, xhtml(`<p>第${index + 1}章把这一句写得足够长，用来当成可以阅读的正文。</p>`)])),
    }));
    assert.equal(parsed.bookType, "fiction");
    assert.equal(parsed.chapters.length, 8);
  });

  it("keeps only quotes that exist in the chapter text", () => {
    const chapter = "群体 一旦形成，个人的理性就会被淹没。后面还有别的话。";
    const located = locateQuote("群体一旦形成，个人的理性就会被淹没。", chapter);
    assert.match(located || "", /群体\s*一旦形成/);
    assert.equal(locateQuote("这句话从来没有出现在原文里面。", chapter), null);
    const verified = verifyQuotes(["群体一旦形成，个人的理性就会被淹没。", "这是编出来的句子，原文里没有。"], chapter);
    assert.equal(verified.quotes.length, 1);
    assert.equal(verified.dropped, 1);
    assert.equal(stripVerdicts("它讨论群体。这本书值得一读。后面还有一句。"), "它讨论群体。后面还有一句。");
    assert.equal(locateQuote("群体一旦形成……个人的理性就会被淹没。", chapter), null);
    assert.equal(locateQuote("个人的理性就会被淹没……群体一旦形成", chapter), null);
    assert.equal(locateQuote("群体一旦形成...后面还有别的话。", chapter), null);
    assert.equal(locateQuote("群体一旦形成…后面还有别的话。", chapter), null);
    const ellipsis = verifyQuotes(["群体一旦形成……后面还有别的话。"], chapter);
    assert.deepEqual(ellipsis.quotes, []);
    assert.equal(ellipsis.dropped, 1);
  });
});

describe("reading robustness", () => {
  it("decodes a gbk chapter instead of importing mojibake", () => {
    const parsed = parseEpub(packBuffers({
      "OEBPS/content.opf": Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>编码样本</dc:title><dc:language>zh</dc:language></metadata>
<manifest><item id="c0" href="c.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
<spine toc="ncx"><itemref idref="c0"/></spine></package>`),
      "OEBPS/toc.ncx": Buffer.from(`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint id="n1"><navLabel><text>第一章</text></navLabel><content src="c.xhtml"/></navPoint></navMap></ncx>`),
      "OEBPS/c.xhtml": Buffer.from("PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iZ2JrIj8+PGh0bWwgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWwiPjxoZWFkPjx0aXRsZT50PC90aXRsZT48L2hlYWQ+PGJvZHk+PGgyPrXa0rvVwiC6o7HfPC9oMj48cD66o7fnsNHV4r7kv8nS1LrLttS1xLuwwfTU2rC2sd+jrNXits7QtLXD1+O5u7OkoaM8L3A+PC9ib2R5PjwvaHRtbD4=", "base64"),
    }));
    assert.equal(parsed.chapters[0]?.title.includes("第一章"), true);
    assert.match(parsed.chapters[0]?.text || "", /海风把这句/);
    assert.equal((parsed.chapters[0]?.text || "").includes("\uFFFD"), false);
  });

  it("imports a book that contains one oversized image", () => {
    const parsed = parseEpub(packBuffers({
      "OEBPS/content.opf": Buffer.from(opf({ title: "大图样本", spine: ["ch.xhtml"] })),
      "OEBPS/toc.ncx": Buffer.from(ncx([{ title: "第一章 正文", href: "ch.xhtml", fragment: null, children: [] }])),
      "OEBPS/ch.xhtml": Buffer.from(xhtml("<p>第一章 正文里这句写得足够长，图片再大也不该挡住导入。</p>")),
      "OEBPS/images/cover.jpg": Buffer.alloc(9 * 1024 * 1024, 7),
    }));
    assert.equal(parsed.chapters.length, 1);
    assert.match(parsed.chapters[0].text, /图片再大/);
  });
});

describe("reading flow", () => {
  before(() => resetModel());
  after(() => {
    setReadingModelForTests(null);
    setReadingChunkSizeForTests(null);
  });

  it("previews chapters, persists merge and level edits, and does not call the model", async () => {
    const beforeCalls = calls.length;
    const book = importEpubBuffer(parts());
    assert.equal(book.status, "preview");
    assert.equal(book.confirmed, false);
    assert.equal(calls.length, beforeCalls);
    assert.deepEqual(book.chapters.map((chapter) => chapter.title), ["引言", "第一章 聚集", "第二章 分散"]);
    const renamed = updateReading(book.id, { title: "改过的书名", author: "改过的作者" });
    assert.equal(renamed.title, "改过的书名");
    renameReadingChapter(book.id, renamed.chapters[1].id, "第一章 改名");
    const merged = mergeReadingChapter(book.id, getBookDetail(book.id)!.chapters[1].id);
    assert.deepEqual(merged.chapters.map((chapter) => chapter.title), ["引言", "第一章 改名"]);
    assert.match(listChaptersWithText(book.id)[1].text, /分散这一章/);
    const switched = switchReadingLevel(book.id, 0);
    assert.deepEqual(switched.chapters.map((chapter) => chapter.title), ["引言", "第一篇"]);
    assert.match(listChaptersWithText(book.id)[1].text, /聚集这一章/);
    assert.match(listChaptersWithText(book.id)[1].text, /分散这一章/);
    assert.equal(calls.length, beforeCalls);
    const restarted = freshDetail(book.id);
    assert.equal(restarted.title, "改过的书名");
    assert.equal(restarted.author, "改过的作者");
    assert.deepEqual(restarted.chapters.map((chapter) => chapter.title), ["引言", "第一篇"]);
    assert.equal(restarted.confirmed, false);
  });

  it("resumes the confirmed chapter set without redoing finished chapters", async () => {
    resetModel();
    const book = importEpubBuffer(chapterBook({
      title: "续跑样本",
      toc: [
        { title: "第一章", href: "c1.xhtml", fragment: null, children: [] },
        { title: "第二章", href: "c2.xhtml", fragment: null, children: [] },
        { title: "第三章", href: "c3.xhtml", fragment: null, children: [] },
      ],
      spine: ["c1.xhtml", "c2.xhtml", "c3.xhtml"],
      files: {
        "c1.xhtml": xhtml("<p>第一章留下一句可以核对的原话，用来证明没有重跑，后面还有一句。</p>"),
        "c2.xhtml": xhtml("<p>第二章留下一句可以核对的原话，失败后还要再试，后面还有一句。</p>"),
        "c3.xhtml": xhtml("<p>第三章留下一句可以核对的原话，合并后仍在同一章，后面还有一句。</p>"),
      },
    }));
    const merged = mergeReadingChapter(book.id, book.chapters[1].id);
    assert.equal(merged.chapters.length, 2);
    assert.match(listChaptersWithText(book.id)[1].text, /第三章留下一句/);
    failTitle = "第二章";
    confirmReading(book.id);
    await startReading(book.id);
    const paused = getBookDetail(book.id)!;
    assert.equal(paused.status, "error");
    assert.equal(paused.chapters[0].noteStatus, "done");
    assert.equal(paused.chapters[1].noteStatus, "error");
    assert.equal(paused.report, null);
    assert.equal(calls.filter((prompt) => prompt.user.includes("章节标题：第一章")).length, 1);
    assert.equal(calls.filter((prompt) => prompt.user.includes("章节标题：第三章")).length, 0);
    const quote = paused.chapters[0].note?.quotes[0]?.text || "";
    assert.match(quote, /第一章留下一句/);
    assert.equal(paused.chapters[0].note?.quotes.some((item) => item.text.includes("编造")), false);
    assert.ok((paused.chapters[0].note?.droppedQuoteCount || 0) >= 1);
    failTitle = "";
    continueReading(book.id);
    await startReading(book.id);
    const done = getBookDetail(book.id)!;
    assert.equal(done.status, "done");
    assert.equal(done.chapters.every((chapter) => chapter.noteStatus === "done"), true);
    assert.equal(calls.filter((prompt) => prompt.user.includes("章节标题：第一章")).length, 1);
    assert.match(done.chapters[1].note?.quotes.map((item) => item.text).join("\n") || listChaptersWithText(book.id)[1].text, /第三章留下一句|第二章留下一句/);
    assert.equal(done.report?.chapterOutlines.length, 2);
    assert.match(done.report?.overview || "", /线索/);
    assert.equal((done.report?.overview || "").includes("值得一读"), false);
    assert.equal(done.report?.corePoints.some((point) => point.includes("推荐阅读")), false);
    assert.equal(done.report?.quotes.length > 0, true);
    for (const quoteItem of done.report?.quotes || []) {
      const source = listChaptersWithText(book.id).find((chapter) => chapter.position === quoteItem.chapterIndex);
      assert.ok(source && locateQuote(quoteItem.text, source.text));
    }
    const restarted = freshDetail(book.id);
    assert.equal(restarted.status, "done");
    assert.equal(restarted.chapters.length, 2);
    assert.ok(restarted.chapters[0].outline);
    assert.match(restarted.overview || "", /线索/);
    assert.equal((restarted.overview || "").includes("值得一读"), false);
  });

  it("chunks a long chapter and still verifies quotes against the full text", async () => {
    resetModel();
    setReadingChunkSizeForTests(28);
    const book = importEpubBuffer(chapterBook({
      title: "长章节",
      toc: [{ title: "第一章 长短", href: "long.xhtml", fragment: null, children: [] }],
      spine: ["long.xhtml"],
      files: {
        "long.xhtml": xhtml("<p>海风把这句可以核对的话完整地留在了岸边。</p><p>山路把另一句可以核对的话藏进了夜里。</p>"),
      },
    }));
    confirmReading(book.id);
    await startReading(book.id);
    const detail = getBookDetail(book.id)!;
    assert.equal(detail.status, "done");
    const noted = detail.chapters[0].note?.quotes.map((quote) => quote.text).join("\n") || "";
    assert.match(noted, /山路把另一句/);
    assert.equal(noted.includes("编造"), false);
    assert.ok(calls.filter((prompt) => prompt.user.includes("CHAPTER") || prompt.user.includes("各部分的笔记")).length >= 3);
    setReadingChunkSizeForTests(null);
  });

  it("reports a missing key and an invalid key without losing the confirmed chapters", async () => {
    setReadingModelForTests(null);
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    writeFileSync(MODEL_PROFILES_PATH, JSON.stringify({
      version: 1,
      activeId: "p1",
      profiles: [{
        id: "p1", name: "DeepSeek", type: "builtin", providerId: "deepseek", modelId: "deepseek-chat",
        baseUrl: null, createdAt: 1, updatedAt: 1,
      }],
    }));
    try {
      const book = importEpubBuffer(nested());
      const confirmed = confirmReading(book.id);
      assert.equal(confirmed.status, "error");
      assert.match(confirmed.error || "", /API Key/);
      assert.equal(confirmed.confirmed, true);
      assert.equal(confirmed.chapters.every((chapter) => chapter.noteStatus === "pending"), true);
      const reopened = reopenReading(book.id);
      assert.equal(reopened.status, "preview");
      assert.equal(reopened.confirmed, false);
      assert.equal(mergeReadingChapter(book.id, reopened.chapters[0].id).chapters.length, 1);
    } finally {
      if (saved === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = saved;
      resetModel();
    }

    setReadingModelForTests(null);
    writeFileSync(MODEL_PROFILES_PATH, JSON.stringify({
      version: 1,
      activeId: "p1",
      profiles: [{
        id: "p1", name: "DeepSeek", type: "builtin", providerId: "deepseek", modelId: "deepseek-chat",
        baseUrl: null, apiKey: "sk-invalid", createdAt: 1, updatedAt: 1,
      }],
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("invalid api key", { status: 401 })) as typeof fetch;
    try {
      const book = importEpubBuffer(nested());
      confirmReading(book.id);
      await startReading(book.id);
      const failed = getBookDetail(book.id)!;
      assert.equal(failed.status, "error");
      assert.match(failed.error || "", /API Key 无效/);
      assert.equal(failed.chapters[0].noteStatus, "error");
      assert.equal(failed.chapters[1]?.noteStatus, "pending");
    } finally {
      globalThis.fetch = originalFetch;
      resetModel();
    }
  });

  it("deletes a book and every related row", () => {
    const book = importEpubBuffer(nested());
    assert.equal(countRows("book_chapters", book.id) > 0, true);
    assert.equal(countRows("book_documents", book.id) > 0, true);
    removeReading(book.id);
    assert.equal(countRows("books", book.id), 0);
    assert.equal(countRows("book_chapters", book.id), 0);
    assert.equal(countRows("book_documents", book.id), 0);
    assert.equal(countRows("book_notes", book.id), 0);
    assert.equal(getBookDetail(book.id), null);
  });

  it("skips front matter when generating notes and the report", async () => {
    resetModel();
    const book = importEpubBuffer(chapterBook({
      title: "跳过样本",
      toc: [
        { title: "目录", href: "toc.xhtml", fragment: null, children: [] },
        { title: "第一章 正文", href: "ch.xhtml", fragment: null, children: [] },
      ],
      spine: ["toc.xhtml", "ch.xhtml"],
      files: {
        "toc.xhtml": xhtml("<p>目录</p><p>这里列出后面的章节，正文足够长，但默认应该跳过。</p>"),
        "ch.xhtml": xhtml("<p>第一章 正文</p><p>正文这一句可以核对，生成时只能看到这一章。</p>"),
      },
    }));
    assert.equal(book.chapters[0]?.skipped, true);
    assert.equal(book.chapterCount, 1);
    confirmReading(book.id);
    await startReading(book.id);
    const detail = getBookDetail(book.id)!;
    assert.equal(detail.status, "done");
    assert.equal(calls.some((prompt) => prompt.user.includes("章节标题：目录")), false);
    assert.equal(calls.some((prompt) => prompt.user.includes("章节标题：第一章 正文")), true);
    assert.equal(detail.report?.chapterOutlines.some((item) => item.title === "目录"), false);
    assert.equal(detail.chapters[0]?.note, null);
  });

  it("erases deleted chapter text from the database file", () => {
    const marker = "真空标记甲乙丙丁戊己庚辛这句只出现在将被删除的书里。";
    const book = importEpubBuffer(chapterBook({
      title: "待删除",
      toc: [{ title: "第一章", href: "c.xhtml", fragment: null, children: [] }],
      spine: ["c.xhtml"],
      files: { "c.xhtml": xhtml(`<p>${marker}</p>`) },
    }));
    removeReading(book.id);
    const database = readFileSync(DB_PATH);
    const walPath = `${DB_PATH}-wal`;
    const wal = existsSync(walPath) ? readFileSync(walPath) : Buffer.alloc(0);
    assert.equal(database.includes(marker), false);
    assert.equal(wal.includes(marker), false);
  });

  it("turns an interrupted run back into a resumable error", () => {
    const book = importEpubBuffer(nested());
    db.prepare("UPDATE books SET confirmed = 1, status = 'reading', error = NULL WHERE id = ?").run(book.id);
    db.prepare("UPDATE book_chapters SET note_status = 'done' WHERE book_id = ? AND position = 0").run(book.id);
    db.prepare("UPDATE book_chapters SET note_status = 'running' WHERE book_id = ? AND position = 1").run(book.id);
    recoverInterruptedReading();
    const recovered = getBookDetail(book.id)!;
    assert.equal(recovered.status, "error");
    assert.match(recovered.error || "", /中断/);
    assert.equal(recovered.chapters[0].noteStatus, "done");
    assert.equal(recovered.chapters[1].noteStatus, "pending");
  });
});

describe("reading http", () => {
  let server: Server;
  let baseUrl = "";

  before(async () => {
    resetModel();
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("无法确定测试端口");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    setReadingModelForTests(null);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function postEpub(body: Buffer) {
    const response = await fetch(`${baseUrl}/api/books`, {
      method: "POST",
      headers: { "Content-Type": "application/epub+zip" },
      body: new Uint8Array(body),
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }

  it("imports for preview, edits the split, confirms, and deletes through the API", async () => {
    const created = await postEpub(parts());
    assert.equal(created.response.status, 201);
    assert.equal(created.body.status, "preview");
    assert.equal(created.body.chapters.length, 3);
    const level = await fetch(`${baseUrl}/api/books/${created.body.id}/level`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: 0 }),
    });
    const leveled = await level.json();
    assert.equal(level.status, 200);
    assert.equal(leveled.chapters.length, 2);
    const merge = await fetch(`${baseUrl}/api/books/${created.body.id}/chapters/${leveled.chapters[0].id}/merge`, { method: "POST" });
    const merged = await merge.json();
    assert.equal(merged.chapters.length, 1);
    const callsBefore = calls.length;
    const confirm = await fetch(`${baseUrl}/api/books/${created.body.id}/confirm`, { method: "POST" });
    assert.equal(confirm.status, 200);
    let detail: any = null;
    const started = Date.now();
    while (Date.now() - started < 4000) {
      detail = await (await fetch(`${baseUrl}/api/books/${created.body.id}`)).json();
      if (detail.status === "done" || detail.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(detail.status, "done");
    assert.equal(detail.chapters.length, 1);
    assert.ok(detail.report?.overview);
    assert.equal(String(detail.report.overview).includes("值得一读"), false);
    assert.ok(calls.length > callsBefore);
    const removed = await fetch(`${baseUrl}/api/books/${created.body.id}`, { method: "DELETE" });
    assert.equal((await removed.json()).ok, true);
    assert.equal(countRows("book_chapters", created.body.id), 0);
    assert.equal(countRows("book_notes", created.body.id), 0);
    const missing = await fetch(`${baseUrl}/api/books/${created.body.id}`);
    assert.equal(missing.status, 404);
  });

  it("returns clear API errors for a corrupt epub", async () => {
    const response = await postEpub(Buffer.from("still not an epub"));
    assert.equal(response.response.status, 400);
    assert.match(response.body.error, /不是有效的 epub|损坏/);
  });
});

const realBooksDir = [
  process.env.READING_BOOKS_DIR,
  join(serverRoot, "fixtures", "private-books"),
  "/tmp/books",
].find((dir) => dir && existsSync(join(dir, "定位.epub")) && existsSync(join(dir, "乌合之众.epub")) && existsSync(join(dir, "遥远的救世主.epub")));

const readingFixtures = join(serverRoot, "fixtures", "reading");

function coverageRatio(parsed: { documents: { text: string }[]; chapters: { text: string }[] }): number {
  const total = parsed.documents.reduce((sum, document) => sum + [...document.text].length, 0);
  const covered = parsed.chapters.reduce((sum, chapter) => sum + [...chapter.text].length, 0);
  return total === 0 ? 0 : covered / total;
}

describe("reading public fixtures", () => {
  it("keeps all one hundred chapters of the journey to the west", () => {
    const parsed = parseEpub(readFileSync(join(readingFixtures, "gut_23962.epub")));
    const hui = parsed.chapters.filter((chapter) => /第.+回/.test(chapter.title));
    const numbers = hui.map((chapter) => readChapterIndex(chapter.title)?.number ?? 0).sort((left, right) => left - right);
    assert.equal(parsed.splitSource, "spine");
    assert.equal(hui.length, 100);
    assert.deepEqual(numbers, Array.from({ length: 100 }, (_, index) => index + 1));
    assert.deepEqual(parsed.numberingWarnings, []);
    assert.ok(coverageRatio(parsed) >= 0.9, `覆盖率 ${coverageRatio(parsed)}`);
  });

  it("imports a gapped chapter sequence and warns without failing", () => {
    const body = chapterBook({
      title: "缺了一章",
      toc: [],
      ncx: false,
      spine: ["a.xhtml", "b.xhtml", "c.xhtml"],
      files: {
        "a.xhtml": xhtml(`<h1>第一章 开始</h1><p>${"这章正文写得足够长，用来确认导入没有因为缺号而失败。".repeat(8)}</p>`),
        "b.xhtml": xhtml(`<h1>第二章 中间</h1><p>${"这章正文也写得足够长，缺的是后面的号而不是这一章。".repeat(8)}</p>`),
        "c.xhtml": xhtml(`<h1>第四章 跳过了三</h1><p>${"这章正文同样写得足够长，第三章没有出现在正文里。".repeat(8)}</p>`),
      },
    });
    const parsed = parseEpub(body);
    assert.equal(parsed.chapters.length, 3);
    assert.deepEqual(parsed.numberingWarnings, ["第三章可能缺失"]);
    const book = importEpubBuffer(body);
    assert.equal(book.status, "preview");
    assert.equal(book.chapters.length, 3);
    assert.deepEqual(book.numberingWarnings, ["第三章可能缺失"]);
    assert.deepEqual(chapterNumberWarnings(book.chapters.map((chapter) => chapter.title)), ["第三章可能缺失"]);
  });

  it("keeps a contents page out of the body-heading split", () => {
    const labels = ["一", "二", "三", "四", "五", "六", "七", "八"];
    const parsed = parseEpub(chapterBook({
      title: "带目录页",
      toc: [],
      ncx: false,
      spine: ["toc.xhtml", "c1.xhtml", "c2.xhtml", "copy.xhtml"],
      files: {
        "toc.xhtml": xhtml(`<h1>目录</h1>${labels.map((label) => `<p>第${label}章</p>`).join("")}`),
        "c1.xhtml": xhtml(`<h2>第一章</h2><p>${"海边这一章写得很长，海风把这句可以核对的话留在岸边。".repeat(8)}</p>`),
        "c2.xhtml": xhtml(`<h2>第二章</h2><p>${"山里这一章同样写得很长，山路把另一句可以核对的话藏进雾里。".repeat(8)}</p>`),
        "copy.xhtml": xhtml("<p>图书在版编目（CIP）数据</p><p>示例 / 作者 著。ISBN 7-0000-0000-0</p><p>版权所有，翻印必究。</p>"),
      },
    }));
    assert.equal(parsed.splitSource, "spine");
    assert.equal(parsed.chapters.filter((chapter) => chapter.title === "第一章").length, 1);
    assert.equal(parsed.chapters.filter((chapter) => chapter.title === "第二章").length, 1);
    assert.equal(parsed.chapters.find((chapter) => chapter.title === "目录")?.skipped, true);
    assert.equal(parsed.chapters.find((chapter) => chapter.title === "版权页")?.skipped, true);
    const first = parsed.chapters.find((chapter) => chapter.title === "第一章");
    assert.match(first?.text || "", /海风把这句/);
    assert.ok([...(first?.text || "")].length > 200);
    assert.equal(parsed.chapters.some((chapter) => !chapter.skipped && [...chapter.text].length < 200), false);
  });

  it("falls back when toc anchors miss or the toc is a single cover entry", () => {
    const anchors = parseEpub(readFileSync(join(readingFixtures, "04_toc_same_file_bad_anchors.epub")));
    const cover = parseEpub(readFileSync(join(readingFixtures, "05_toc_single_entry.epub")));
    assert.equal(anchors.splitSource, "spine");
    assert.equal(anchors.chapters.length, 5);
    assert.ok(coverageRatio(anchors) >= 0.9);
    assert.equal(cover.splitSource, "spine");
    assert.equal(cover.chapters.length, 5);
    assert.equal(cover.chapters.some((chapter) => chapter.title === "封面"), false);
    assert.ok(coverageRatio(cover) >= 0.9);
  });

  it("splits a no-toc book at chapter headings and keeps sections inside them", () => {
    const parsed = parseEpub(readFileSync(join(readingFixtures, "06_no_toc_with_sections.epub")));
    assert.equal(parsed.splitSource, "spine");
    assert.deepEqual(parsed.chapters.map((chapter) => chapter.title), ["第一章 标题1", "第二章 标题2", "第三章 标题3", "第四章 标题4"]);
    assert.match(parsed.chapters[0].text, /第一节 小节1/);
    assert.equal(parsed.chapters.some((chapter) => chapter.title.includes("第一节")), false);
    assert.ok(coverageRatio(parsed) >= 0.9);
  });
});

describe("reading real epubs", { skip: realBooksDir ? false : "本地没有三本测试 epub，跳过" }, () => {
  it("splits the three source books from their own toc", () => {
    const positioning = parseEpub(readFileSync(join(realBooksDir!, "定位.epub")));
    const crowd = parseEpub(readFileSync(join(realBooksDir!, "乌合之众.epub")));
    const novel = parseEpub(readFileSync(join(realBooksDir!, "遥远的救世主.epub")));
    assert.equal(positioning.title, "定位");
    assert.equal(positioning.bookType, "nonfiction");
    assert.equal(positioning.splitSource, "toc");
    assert.equal(crowd.title, "乌合之众");
    assert.equal(crowd.bookType, "nonfiction");
    assert.equal(novel.title, "遥远的救世主");
    assert.equal(novel.bookType, "fiction");
    assert.equal(novel.chapters.some((chapter) => chapter.title === "第一章"), true);
    assert.ok(positioning.chapters.findIndex((chapter) => chapter.title.includes("到底何为定位")) >= 0);
    assert.equal(positioning.chapters.some((chapter) => chapter.title === "传播过度的社会"), false);
    const first = positioning.chapters.findIndex((chapter) => /第\s*1\s*章/.test(chapter.title));
    const second = positioning.chapters.findIndex((chapter) => /第\s*2\s*章/.test(chapter.title));
    assert.ok(first >= 0 && second > first);
    const crowdChapter = crowd.chapters.findIndex((chapter) => chapter.title.includes("群体的普遍特征"));
    assert.ok(crowdChapter >= 0);
    assert.equal(crowd.chapters.some((chapter) => chapter.title.startsWith("第一篇")), false);
    const novelFirst = novel.chapters.findIndex((chapter) => chapter.title === "第一章");
    const novelSecond = novel.chapters.findIndex((chapter) => chapter.title === "第二章");
    assert.ok(novelSecond > novelFirst);
    assert.equal(positioning.selectedLevel, 0);
    assert.equal(positioning.chapters.length, 28);
    assert.equal(crowd.selectedLevel, 1);
    assert.equal(crowd.chapters.length, 17);
    assert.equal(novel.selectedLevel, 0);
    assert.equal(novel.chapters.length, 48);
    assert.deepEqual(novel.chapters.filter((chapter) => chapter.skipped).map((chapter) => chapter.title), ["目录", "版权页"]);
    assert.equal(novel.chapters.filter((chapter) => !chapter.skipped && /^第.+章$/.test(chapter.title)).length, 46);
  });
});
