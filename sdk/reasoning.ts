/** Render reasoning emphasis without merging adjacent streamed summary headings. */
export function reasoningMarkdown(text: string): string {
  let output = "";
  let index = 0;
  let previousHeadingEnd = -1;
  while (index < text.length) {
    if (text[index] === "\\") {
      output += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (text[index] === "`") {
      let length = 1;
      while (text[index + length] === "`") length++;
      const end = text.indexOf("`".repeat(length), index + length);
      if (end < 0) { output += text.slice(index); break; }
      output += text.slice(index, end + length);
      index = end + length;
      continue;
    }
    if (text.startsWith("**", index)) {
      let end = text.indexOf("**", index + 2);
      while (end >= 0 && text[end - 1] === "\\") end = text.indexOf("**", end + 2);
      if (end >= 0 && text.slice(index + 2, end).trim()) {
        if (previousHeadingEnd === index) output += "\n\n";
        output += "*" + text.slice(index + 2, end).trim() + "*";
        index = end + 2;
        previousHeadingEnd = index;
        continue;
      }
    }
    output += text[index++];
  }
  return output;
}
