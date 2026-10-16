import { describe, expect, test } from "bun:test";
import { documentEmbeddingText } from "./documents";

describe("documentEmbeddingText", () => {
  test("is title and outline: nothing else goes into the vector", () => {
    expect(documentEmbeddingText("Tasks", "# Tasks")).toBe("Tasks\n# Tasks");
  });

  test("without an outline, just the title", () => {
    expect(documentEmbeddingText("Call the dentist", "")).toBe("Call the dentist");
  });
});
