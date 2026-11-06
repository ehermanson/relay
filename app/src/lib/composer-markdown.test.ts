import { describe, expect, it } from "vitest";
import {
  MARK_BOLD,
  MARK_BULLET,
  MARK_CODE,
  MARK_CODE_BLOCK,
  MARK_HIDDEN,
  MARK_ITALIC,
  MARK_LIST_NUMBER,
  MARK_QUOTE,
  MARK_QUOTE_MARKER,
  MARK_STRIKETHROUGH,
  MARK_SYNTAX,
  applyComposerFormat,
  composerFormatFromKey,
  continueComposerList,
  parseComposerMarkdown,
  removeComposerLinePrefix,
  type ComposerFormat,
} from "./composer-markdown";

/** Each styled range as [text, marks]. */
function parsed(text: string): [string, number][] {
  return parseComposerMarkdown(text).map((span) => [text.slice(span.start, span.end), span.marks]);
}

/** `[` and `]` in `marked` show the selection, `|` a caret. */
function edit(marked: string) {
  const caret = marked.indexOf("|");
  if (caret !== -1) {
    return { value: marked.replace("|", ""), start: caret, end: caret };
  }
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { value: marked.replace("[", "").replace("]", ""), start, end };
}

function show({ value, start, end }: { value: string; start: number; end: number }): string {
  if (start === end) return `${value.slice(0, start)}|${value.slice(start)}`;
  return `${value.slice(0, start)}[${value.slice(start, end)}]${value.slice(end)}`;
}

function format(marked: string, kind: ComposerFormat): string {
  return show(applyComposerFormat(edit(marked), kind));
}

describe("parseComposerMarkdown", () => {
  it("marks inline emphasis and its markers", () => {
    expect(parsed("a **b** c")).toEqual([
      ["**", MARK_HIDDEN],
      ["b", MARK_BOLD],
      ["**", MARK_HIDDEN],
    ]);
    expect(parsed("*i*")[1]).toEqual(["i", MARK_ITALIC]);
    expect(parsed("_i_")[1]).toEqual(["i", MARK_ITALIC]);
    expect(parsed("__b__")[1]).toEqual(["b", MARK_BOLD]);
    expect(parsed("***x***")[1]).toEqual(["x", MARK_BOLD | MARK_ITALIC]);
    expect(parsed("~~x~~")[1]).toEqual(["x", MARK_STRIKETHROUGH]);
    expect(parsed("`x`")).toEqual([
      ["`", MARK_HIDDEN],
      ["x", MARK_CODE],
      ["`", MARK_HIDDEN],
    ]);
  });

  it("nests italic inside bold", () => {
    expect(parsed("**a *b* c**").map(([text]) => text)).toEqual([
      "**",
      "a ",
      "*",
      "b",
      "*",
      " c",
      "**",
    ]);
  });

  it("leaves things that only look like emphasis alone", () => {
    for (const text of ["2 * 3 * 4", "snake_case_name", "a ** b ** c", "\\*not italic\\*"]) {
      expect(parsed(text)).toEqual([]);
    }
  });

  it("doesn't read emphasis inside inline code", () => {
    expect(parsed("`**x**`")[1]).toEqual(["**x**", MARK_CODE]);
  });

  it("marks block prefixes at the start of a line only", () => {
    expect(parsed("- a")).toEqual([["- ", MARK_BULLET]]);
    expect(parsed("  * a")).toEqual([["* ", MARK_BULLET]]);
    expect(parsed("12. a")).toEqual([["12. ", MARK_LIST_NUMBER]]);
    expect(parsed("> a")).toEqual([
      ["> ", MARK_QUOTE_MARKER],
      ["a", MARK_QUOTE],
    ]);
    expect(parsed("# a")).toEqual([
      ["# ", MARK_SYNTAX],
      ["a", MARK_BOLD],
    ]);
    expect(parsed("a - b > c")).toEqual([]);
    expect(parsed("-a")).toEqual([]);
  });

  it("styles inline markdown inside a list item", () => {
    expect(parsed("- **a**")).toEqual([
      ["- ", MARK_BULLET],
      ["**", MARK_HIDDEN],
      ["a", MARK_BOLD],
      ["**", MARK_HIDDEN],
    ]);
  });

  it("treats fenced code as code, closed or not", () => {
    expect(parsed("```ts\n- **a**\n```\n- b")).toEqual([
      ["```ts", MARK_SYNTAX],
      ["- **a**", MARK_CODE_BLOCK],
      ["```", MARK_SYNTAX],
      ["- ", MARK_BULLET],
    ]);
    expect(parsed("```\n- a")[1]).toEqual(["- a", MARK_CODE_BLOCK]);
  });

  describe("revealing markers around the selection", () => {
    /** The marker text left visible for a caret at `|`. */
    const revealed = (marked: string) => {
      const { value, start, end } = edit(marked);
      return parseComposerMarkdown(value, { start, end })
        .filter((span) => span.marks & MARK_SYNTAX)
        .map((span) => value.slice(span.start, span.end));
    };

    it("hides markers with no selection", () => {
      expect(parseComposerMarkdown("**a**").some((span) => span.marks & MARK_SYNTAX)).toBe(false);
    });

    it("shows them with the caret inside or touching", () => {
      expect(revealed("**a|b**")).toEqual(["**", "**"]);
      expect(revealed("|**a**")).toEqual(["**", "**"]);
      expect(revealed("**a**|")).toEqual(["**", "**"]);
      expect(revealed("`a|`")).toEqual(["`", "`"]);
    });

    it("hides them again once the caret moves on", () => {
      expect(revealed("**a** |")).toEqual([]);
      expect(revealed("| **a**")).toEqual([]);
    });

    it("reveals only the piece the caret is on", () => {
      expect(revealed("**a|** and *b*")).toEqual(["**", "**"]);
      expect(revealed("**a** and *b|*")).toEqual(["*", "*"]);
    });

    it("reveals everything a selection touches", () => {
      expect(revealed("**a[** and *]b*")).toEqual(["**", "**", "*", "*"]);
    });

    it("reveals both levels when nested", () => {
      expect(revealed("**a *b|* c**")).toEqual(["**", "*", "*", "**"]);
    });

    it("leaves block syntax alone", () => {
      expect(parsed("# a")[0]).toEqual(["# ", MARK_SYNTAX]);
    });
  });

  it("gives offsets into the whole text", () => {
    expect(parseComposerMarkdown("x\n- a")).toEqual([{ start: 2, end: 4, marks: MARK_BULLET }]);
  });

  it("skips very large text", () => {
    expect(parseComposerMarkdown(`**a** ${"x".repeat(20_000)}`)).toEqual([]);
  });
});

describe("composerFormatFromKey", () => {
  const key = (overrides: Partial<KeyboardEvent>) => ({
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  });

  it("uses Cmd on Apple platforms and Ctrl elsewhere", () => {
    expect(composerFormatFromKey(key({ key: "b", metaKey: true }), true)).toBe("bold");
    expect(composerFormatFromKey(key({ key: "b", ctrlKey: true }), false)).toBe("bold");
  });

  it("leaves macOS Ctrl text navigation alone", () => {
    expect(composerFormatFromKey(key({ key: "e", ctrlKey: true }), true)).toBeNull();
    expect(composerFormatFromKey(key({ key: "b", ctrlKey: true }), true)).toBeNull();
  });

  it("reads list shortcuts from the physical key", () => {
    const shifted = { metaKey: true, shiftKey: true };
    expect(composerFormatFromKey(key({ ...shifted, key: "&", code: "Digit7" }), true)).toBe(
      "number",
    );
    expect(composerFormatFromKey(key({ ...shifted, key: "*", code: "Digit8" }), true)).toBe(
      "bullet",
    );
    expect(composerFormatFromKey(key({ ...shifted, key: "(", code: "Digit9" }), true)).toBe(
      "quote",
    );
  });

  it("ignores unrelated keys", () => {
    expect(composerFormatFromKey(key({ key: "b" }), true)).toBeNull();
    expect(composerFormatFromKey(key({ key: "k", metaKey: true }), true)).toBeNull();
    expect(composerFormatFromKey(key({ key: "b", metaKey: true, altKey: true }), true)).toBeNull();
  });
});

describe("applyComposerFormat inline", () => {
  it("wraps the selection and keeps it selected", () => {
    expect(format("a [b] c", "bold")).toBe("a **[b]** c");
    expect(format("a [b] c", "italic")).toBe("a *[b]* c");
    expect(format("a [b] c", "code")).toBe("a `[b]` c");
  });

  it("toggles back off", () => {
    expect(format("a **[b]** c", "bold")).toBe("a [b] c");
    expect(format("a [**b**] c", "bold")).toBe("a [b] c");
    expect(format("a `[b]` c", "code")).toBe("a [b] c");
  });

  it("combines bold and italic in either order", () => {
    expect(format("**[b]**", "italic")).toBe("***[b]***");
    expect(format("*[b]*", "bold")).toBe("***[b]***");
    expect(format("***[b]***", "bold")).toBe("*[b]*");
    expect(format("***[b]***", "italic")).toBe("**[b]**");
  });

  it("keeps a selected trailing space outside the markers", () => {
    expect(format("[word ]next", "bold")).toBe("**[word]** next");
  });

  it("opens a pair at the caret and closes an empty one", () => {
    expect(format("a |", "bold")).toBe("a **|**");
    expect(format("a **|**", "bold")).toBe("a |");
  });

  it("wraps each line of a multi-line selection", () => {
    expect(format("[a\n\nb]", "bold")).toBe("[**a**\n\n**b**]");
    expect(format("[**a**\n\n**b**]", "bold")).toBe("[a\n\nb]");
  });
});

describe("applyComposerFormat blocks", () => {
  it("prefixes the caret's line and keeps the caret in place", () => {
    expect(format("one\nt|wo", "bullet")).toBe("one\n- t|wo");
    expect(format("t|wo", "number")).toBe("1. t|wo");
    expect(format("t|wo", "quote")).toBe("> t|wo");
  });

  it("toggles back off", () => {
    expect(format("- t|wo", "bullet")).toBe("t|wo");
    expect(format("> t|wo", "quote")).toBe("t|wo");
  });

  it("keeps the caret on the line when the prefix it sat in goes away", () => {
    expect(format("-| a", "bullet")).toBe("|a");
  });

  it("swaps one kind of line for another", () => {
    expect(format("- t|wo", "number")).toBe("1. t|wo");
    expect(format("1. t|wo", "quote")).toBe("> t|wo");
  });

  it("numbers selected lines, skipping blanks", () => {
    expect(format("[a\n\nb]", "number")).toBe("[1. a\n\n2. b]");
  });

  it("extends a partial selection over whole lines", () => {
    expect(format("a[a\nb]b", "bullet")).toBe("[- aa\n- bb]");
  });

  it("removes only when every selected line has the prefix", () => {
    expect(format("[- a\n- b]", "bullet")).toBe("[a\nb]");
    expect(format("[- a\nb]", "bullet")).toBe("[- a\n- b]");
  });

  it("stops at a selection ending just after a newline", () => {
    expect(format("[a\n]b", "bullet")).toBe("[- a]\nb");
  });

  it("keeps indentation", () => {
    expect(format("  a|", "bullet")).toBe("  - a|");
  });

  it("starts a list on an empty line", () => {
    expect(format("|", "bullet")).toBe("- |");
  });
});

describe("continueComposerList", () => {
  const next = (marked: string) => {
    const { value, start } = edit(marked);
    const result = continueComposerList(value, start);
    return result && show(result);
  };

  it("continues each kind of line", () => {
    expect(next("- a|")).toBe("- a\n- |");
    expect(next("* a|")).toBe("* a\n* |");
    expect(next("> a|")).toBe("> a\n> |");
    expect(next("  - a|")).toBe("  - a\n  - |");
  });

  it("increments numbers", () => {
    expect(next("9. a|")).toBe("9. a\n10. |");
    expect(next("1) a|")).toBe("1) a\n2) |");
  });

  it("starts the next task unchecked", () => {
    expect(next("- [x] a|")).toBe("- [x] a\n- [ ] |");
  });

  it("carries text after the caret onto the new item", () => {
    expect(next("- a|b")).toBe("- a\n- |b");
  });

  it("ends the list on an empty item", () => {
    expect(next("- a\n- |")).toBe("- a\n|");
    expect(next("1. |")).toBe("|");
    expect(next("> a\n> |")).toBe("> a\n|");
  });

  it("ignores list-like lines inside a code fence", () => {
    expect(next("```\n- a|\n```")).toBeNull();
  });

  it("leaves other lines to an ordinary line break", () => {
    expect(next("plain|")).toBeNull();
    expect(next("|- a")).toBeNull();
    expect(next("-a|")).toBeNull();
  });
});

describe("removeComposerLinePrefix", () => {
  const backspace = (marked: string) => {
    const { value, start } = edit(marked);
    const result = removeComposerLinePrefix(value, start);
    return result && show(result);
  };

  it("takes the whole prefix off", () => {
    expect(backspace("- |a")).toBe("|a");
    expect(backspace("12. |a")).toBe("|a");
    expect(backspace("> |a")).toBe("|a");
    expect(backspace("x\n- |")).toBe("x\n|");
  });

  it("keeps indentation", () => {
    expect(backspace("  - |a")).toBe("  |a");
  });

  it("leaves every other caret position to a normal backspace", () => {
    expect(backspace("- a|")).toBeNull();
    expect(backspace("-| a")).toBeNull();
    expect(backspace("|- a")).toBeNull();
    expect(backspace("plain|")).toBeNull();
  });
});
