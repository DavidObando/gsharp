// gstokens: print the tokens and the doc comments of G# source files as the
// compiler reads them. build/check-comment-only-diff.py uses it to compare
// .gs files.
//
// Usage: gstokens FILE...
// Output: a JSON array with one object for each file:
//   {"path": FILE, "errors": [MESSAGE, ...],
//    "tokens": [[KIND, LINE, TEXT, POSITION], ...],
//    "docs": [{"line": LINE, "end": POSITION, "declaration": POSITION, "xml": XML}, ...],
//    "docDiagnostics": [MESSAGE, ...]}
// The tokens include whitespace and comments. LINE starts at 1. Each doc entry
// is one `///` block: "declaration" is the start of the declaration that the
// compiler attaches it to, or -1 if the block is floating; "xml" is the XML
// documentation that the compiler writes for it. "docDiagnostics" holds what
// the compiler's DocumentationValidator reports from the syntax tree alone
// (floating doc comments and unknown tags), without locations.
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Documentation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.IO
import System.Text.Json

using let output = Console.OpenStandardOutput()
using let writer = Utf8JsonWriter(output)
writer.WriteStartArray()
for path in args {
    // Each file is written to its own buffer, so a failure in one file still
    // gives a JSON entry whose "errors" says what went wrong.
    let buffer = MemoryStream()
    try {
        using let entry = Utf8JsonWriter(buffer)
        let source = SourceText.From(File.ReadAllText(path), path)
        let tokens = SyntaxTree.ParseTokens(source, out var diagnostics)
        entry.WriteStartObject()
        entry.WriteString("path", path)
        entry.WriteStartArray("errors")
        for diagnostic in diagnostics {
            if diagnostic.IsError {
                entry.WriteStringValue(diagnostic.ToString())
            }
        }
        entry.WriteEndArray()
        entry.WriteStartArray("tokens")
        for token in tokens {
            entry.WriteStartArray()
            entry.WriteStringValue(token.Kind.ToString())
            entry.WriteNumberValue(source.GetLineIndex(token.Position) + 1)
            entry.WriteStringValue(token.Text ?? "")
            entry.WriteNumberValue(token.Position)
            entry.WriteEndArray()
        }
        entry.WriteEndArray()
        // Attach each block the way the compiler does: the first documentable
        // declaration after the block, if Attach() gave it this block's text.
        let tree = SyntaxTree.Parse(source)
        let attached = DocumentationAttacher.Attach(tree)
        let declarations = DocumentationAttacher.GetDocumentableDeclarations(tree)
        entry.WriteStartArray("docs")
        var next = 0
        for block in DocumentationAttacher.GetBlocks(tree) {
            while next < declarations.Count && declarations[next].Span.Start < block.EndPosition {
                next++
            }
            var declaration = -1
            if next < declarations.Count && attached.TryGetValue(declarations[next], out var text) &&
                text == block.Text {
                declaration = declarations[next].Span.Start
            }
            entry.WriteStartObject()
            entry.WriteNumber("line", block.FirstLine + 1)
            entry.WriteNumber("end", block.EndPosition)
            entry.WriteNumber("declaration", declaration)
            entry.WriteString(
                "xml",
                DocumentationXmlWriter.WriteXmlFragment(GSharpDocumentationParser.Parse(block.Text))
            )
            entry.WriteEndObject()
        }
        entry.WriteEndArray()
        let docDiagnostics = DiagnosticBag()
        DocumentationValidator.Validate(
            tree,
            ImmutableArray[FunctionSymbol].Empty,
            ImmutableArray[StructSymbol].Empty,
            docDiagnostics,
            false
        )
        entry.WriteStartArray("docDiagnostics")
        for diagnostic in docDiagnostics {
            entry.WriteStringValue(diagnostic.Message)
        }
        entry.WriteEndArray()
        entry.WriteEndObject()
        entry.Flush()
        writer.WriteRawValue(buffer.ToArray())
    } catch (ex Exception) {
        writer.WriteStartObject()
        writer.WriteString("path", path)
        writer.WriteStartArray("errors")
        writer.WriteStringValue("gstokens: " + ex.GetType().Name + ": " + ex.Message)
        writer.WriteEndArray()
        writer.WriteStartArray("tokens")
        writer.WriteEndArray()
        writer.WriteStartArray("docs")
        writer.WriteEndArray()
        writer.WriteStartArray("docDiagnostics")
        writer.WriteEndArray()
        writer.WriteEndObject()
    }
}
writer.WriteEndArray()
writer.Flush()
return 0
