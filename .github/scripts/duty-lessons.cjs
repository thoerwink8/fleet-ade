// LESSONS.md ledger. Each lesson keeps `Seen N\u00d7` and the dates it showed up.
// The same lesson on 3 different days is a promote candidate. This file never edits rules.
const HEADING = "# \u503c\u73ed\u590d\u76d8";
const INTRO =
  "\u591c\u95f4\u590d\u76d8\u5199\u5728\u8fd9\u91cc\u3002\u6bcf\u6761\u5e26\u51fa\u73b0\u6b21\u6570\u548c\u65e5\u671f\u3002\u540c\u4e00\u6761\u5728 3 \u4e2a\u4e0d\u540c\u65e5\u5b50\u51fa\u73b0\uff0c\u503c\u73ed\u53e6\u5f00\u4e00\u5f20\u300c\u5347\u89c4\u77e9\u300d\u5355\u7ed9\u6307\u6325\u5b98\u5ba1\uff0c\u4e0d\u81ea\u52a8\u6539\u89c4\u77e9\u3002";

const ENTRY = /^## ([a-z0-9][a-z0-9-]*)\s*$/;
const SEEN = /^Seen (\d+)× \u00b7 (.+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseLessons(text) {
  const lessons = [];
  let current = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const heading = ENTRY.exec(line);
    if (heading) {
      current = { id: heading[1], title: "", summary: "", seen: 0, dates: [] };
      lessons.push(current);
      continue;
    }
    if (!current) continue;
    const seen = SEEN.exec(line);
    if (seen) {
      current.seen = Number(seen[1]);
      current.dates = seen[2]
        .split(",")
        .map((part) => part.trim())
        .filter((part) => DATE.test(part));
      continue;
    }
    if (line.startsWith("\u6807\u9898\uff1a")) current.title = line.slice(3).trim();
    else if (line.startsWith("\u6458\u8981\uff1a")) current.summary = line.slice(3).trim();
  }
  return lessons.filter((lesson) => lesson.title);
}

function renderLessons(lessons) {
  const body = lessons
    .map((lesson) => {
      const dates = [...lesson.dates].sort();
      return [
        `## ${lesson.id}`,
        `\u6807\u9898\uff1a${lesson.title}`,
        `\u6458\u8981\uff1a${lesson.summary}`,
        `Seen ${dates.length}\u00d7 \u00b7 ${dates.join(", ")}`,
        "",
      ].join("\n");
    })
    .join("\n");
  return `${HEADING}\n\n${INTRO}\n\n${body}`.replace(/\n+$/, "\n");
}

function observeLessons(existing, incoming, day, promoteDays) {
  const lessons = existing.map((lesson) => ({
    ...lesson,
    dates: [...lesson.dates],
  }));
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const promotions = [];
  for (const item of incoming) {
    let lesson = byId.get(item.id);
    if (!lesson) {
      lesson = { id: item.id, title: item.title, summary: item.summary, seen: 0, dates: [] };
      lessons.push(lesson);
      byId.set(item.id, lesson);
    }
    if (item.title) lesson.title = item.title;
    if (item.summary) lesson.summary = item.summary;
    const before = lesson.dates.length;
    if (!lesson.dates.includes(day)) lesson.dates.push(day);
    lesson.dates.sort();
    lesson.seen = lesson.dates.length;
    if (before < promoteDays && lesson.dates.length >= promoteDays) {
      promotions.push({
        id: lesson.id,
        title: lesson.title,
        summary: lesson.summary,
        dates: [...lesson.dates],
      });
    }
  }
  return { lessons, promotions };
}

module.exports = { HEADING, parseLessons, renderLessons, observeLessons };
