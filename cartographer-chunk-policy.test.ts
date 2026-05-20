import assert from "node:assert/strict";
import {
  classifyPythonDecorator,
  getChunkRole,
  isChunkIndexable,
  shouldExcludeFile,
  shouldRunAIPass,
  shouldSplitAstNodeForLineCount,
  type ChunkCandidate,
} from "./cartographer-chunk-policy.js";

const tinyNamedFunction: ChunkCandidate = {
  filePath: "/Users/joewales/NODE_OUT_Master/example.ts",
  language: "typescript",
  kind: "function",
  symbolName: "xor",
  startLine: 10,
  endLine: 10,
  code: "const xor=(a,b)=>a^b",
};

assert.equal(shouldSplitAstNodeForLineCount(), false, "AST nodes must never be split by line count");
assert.equal(isChunkIndexable(tinyNamedFunction), true, "1-line named symbol must be indexable");
assert.equal(shouldExcludeFile("/tmp/foo/bar.test.ts"), true, "test files must be excluded");
assert.equal(shouldExcludeFile("/tmp/foo/types.d.ts"), true, "d.ts files must be excluded");
assert.equal(shouldExcludeFile("/tmp/foo/runtime.ts"), false, "runtime files should not be excluded");

assert.equal(getChunkRole("interface"), "context", "interface must be context-only");
assert.equal(getChunkRole("type"), "context", "type alias must be context-only");
assert.equal(getChunkRole("typed_dict"), "context", "TypedDict must be context-only");
assert.equal(getChunkRole("dataclass"), "context", "dataclass must be context-only");
assert.equal(shouldRunAIPass({ ...tinyNamedFunction, kind: "interface" }), false, "context chunks skip AI pass");
assert.equal(shouldRunAIPass(tinyNamedFunction), true, "capability chunks require AI pass");

const decoratorLike = `
def retry_connection(retries=3):
    def decorator(fn):
        def wrapper(*args, **kwargs):
            return fn(*args, **kwargs)
        return wrapper
    return decorator
`;

assert.equal(classifyPythonDecorator(decoratorLike), "decorator", "decorator factory should be classified as decorator");
assert.equal(classifyPythonDecorator("def parse_flags(x):\n    return x & 1\n"), "function", "plain function should remain function");

console.log("cartographer-chunk-policy tests passed");
