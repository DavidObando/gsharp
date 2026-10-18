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
    let source = SourceText.From(File.ReadAllText(path), path)
    let tokens = SyntaxTree.ParseTokens(source, out var diagnostics)
    writer.WriteStartObject()
    writer.WriteString("path", path)
    writer.WriteStartArray("errors")
    for diagnostic in diagnostics {
        if diagnostic.IsError {
            writer.WriteStringValue(diagnostic.ToString())
        }
    }
    writer.WriteEndArray()
    writer.WriteStartArray("tokens")
    for token in tokens {
        writer.WriteStartArray()
        writer.WriteStringValue(token.Kind.ToString())
        writer.WriteNumberValue(source.GetLineIndex(token.Position) + 1)
        writer.WriteStringValue(token.Text ?? "")
        writer.WriteNumberValue(token.Position)
        writer.WriteEndArray()
    }
    writer.WriteEndArray()
    // Attach each block the way the compiler does: the first documentable
    // declaration after the block, if Attach() gave it this block's text.
    let tree = SyntaxTree.Parse(source)
    let attached = DocumentationAttacher.Attach(tree)
    let declarations = DocumentationAttacher.GetDocumentableDeclarations(tree)
    writer.WriteStartArray("docs")
    var next = 0
    for block in DocumentationAttacher.GetBlocks(tree) {
        while next < declarations.Count && declarations[next].Span.Start < block.EndPosition {
            next++
        }
        var declaration = -1
        if next < declarations.Count && attached.TryGetValue(declarations[next], out var text) && text == block.Text {
            declaration = declarations[next].Span.Start
        }
        writer.WriteStartObject()
        writer.WriteNumber("line", block.FirstLine + 1)
        writer.WriteNumber("end", block.EndPosition)
        writer.WriteNumber("declaration", declaration)
        writer.WriteString("xml", DocumentationXmlWriter.WriteXmlFragment(GSharpDocumentationParser.Parse(block.Text)))
        writer.WriteEndObject()
    }
    writer.WriteEndArray()
    let docDiagnostics = DiagnosticBag()
    DocumentationValidator.Validate(
        tree,
        ImmutableArray[FunctionSymbol].Empty,
        ImmutableArray[StructSymbol].Empty,
        docDiagnostics,
        false
    )
    writer.WriteStartArray("docDiagnostics")
    for diagnostic in docDiagnostics {
        writer.WriteStringValue(diagnostic.Message)
    }
    writer.WriteEndArray()
    writer.WriteEndObject()
}
writer.WriteEndArray()
writer.Flush()
return 0
