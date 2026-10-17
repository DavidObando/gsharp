// gstokens: print the tokens of G# source files as the compiler's lexer reads
// them. build/check-comment-only-diff.py uses it to compare .gs files.
//
// Usage: gstokens FILE...
// Output: a JSON array with one object for each file:
//   {"path": FILE, "errors": [MESSAGE, ...], "tokens": [[KIND, LINE, TEXT], ...]}
// The tokens include whitespace and comments. LINE starts at 1.
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
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
        writer.WriteEndArray()
    }
    writer.WriteEndArray()
    writer.WriteEndObject()
}
writer.WriteEndArray()
writer.Flush()
return 0
