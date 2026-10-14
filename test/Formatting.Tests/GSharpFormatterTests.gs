// <copyright file="GSharpFormatterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import GSharp.Tests
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

class GSharpFormatterTests {
    @Fact
    func Format_UsesCanonicalLayout() {
        const input = `package Z
import Zed
import Alpha
func add(a int32,b int32)int32{
return a+b
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(`package Z

import Alpha
import Zed

func add(a int32, b int32) int32 {
` + "    return a + b\n" + "}\n", result.Text!!.ToString())
    }

    @Fact
    func Format_IsIdempotent() {
        const input = `func run(){
var x=1
if x>0{
Console.WriteLine(x)
}
}
`
        let once = GSharpFormatter.Format(SourceText.From(input))
        let twice = GSharpFormatter.Format(once.Text!!)
        Assert.Empty(once.Diagnostics)
        Assert.Empty(twice.Diagnostics)
        Assert.Equal(once.Text!!.ToString(), twice.Text!!.ToString())
        Assert.False(twice.Changed)
    }

    @Fact
    func Format_WrapsComposableExpressionShapes() {
        let arguments = string.Join(", ", Enumerable.Range(0, 30).Select((index int32) -> "value$index"))
        let input = (`func run() {
Console.WriteLine(` + "$arguments" + `)
}
`)
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.All(
            result.Text!!.ToString().Split('\n'),
            (line string) -> Assert.True(line.Length <= 120, "Line exceeded the canonical width: " + line)
        )
        Assert.Contains(`
        value0,
        value1,`, result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_KeepsArrayElementTypeAdjacent() {
        const input = "let values=[3]int32{1,2,3}\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Equal("let values = [3]int32{1, 2, 3}\n", result.Text!!.ToString())
    }

    @Fact
    func Format_KeepsMagicTypesAndConditionalIndexAdjacent() {
        const input = "func use(ch chan[int32], values map[string,int32], items sequence[int32], xs []int32){\n" +
            "let first=xs?[0]\n" +
            "}\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("chan[int32]", result.Text!!.ToString(), StringComparison.Ordinal)
        Assert.Contains("map[string, int32]", result.Text!!.ToString(), StringComparison.Ordinal)
        Assert.Contains("sequence[int32]", result.Text!!.ToString(), StringComparison.Ordinal)
        Assert.Contains("xs?[0]", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_PreservesImportOrderWhenLocalNamesCollide() {
        const input = "package Demo\n" + "import X = System.Math\n" + "import X = System.Console\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        Assert.True(
            formatted.IndexOf("System.Math", StringComparison.Ordinal) < formatted.IndexOf(
                "System.Console",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func Format_PreservesImportOrderWhenACommentSitsInTheImportBlock() {
        const input = "package Demo\n" + "import b.x\n" + "import a.y // only for y\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        Assert.Contains("import a.y // only for y", formatted, StringComparison.Ordinal)
        Assert.True(
            formatted.IndexOf("import b.x", StringComparison.Ordinal) < formatted.IndexOf(
                "import a.y",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func Format_PreservesImportOrderWhenACommentIntroducesTheImportBlock() {
        const input = "package Demo\n" + "\n" + "// only for x\n" + "import b.x\n" + "import a.y\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        Assert.True(
            formatted.IndexOf("import b.x", StringComparison.Ordinal) < formatted.IndexOf(
                "import a.y",
                StringComparison.Ordinal
            )
        )
    }

    @Fact
    func Format_KeepsBlockCommentsInline() {
        const input = `func main() {
let a = /* why */ 1
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("let a = /* why */ 1", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_DoesNotSplitPayloadEnumDeclarationHead() {
        const input = "enum Shape { Circle(r float64); Square(s float64); Empty }\n"
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.StartsWith("enum Shape {", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_PreservesNewlineSensitiveReturn() {
        const input = `func value() int32 {
return
42
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("return\n    42", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_InsertsMemberBlankLineBeforeDocumentationTrivia() {
        const input = `class Widget {
func A() { }
/// Documents B.
func B() { }
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains(`    func A() { }

    /// Documents B.`, result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_PreservesOneBlankLineAfterCommentBlock() {
        const input = `// File heading.

package Demo
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Equal(`// File heading.

package Demo
`, result.Text!!.ToString())
    }

    @Fact
    func Format_JoinsACStyleForClauseHeaderOntoOneLine() {
        // ADR-0179 regression: the for-clause header's two separator `;`
        // tokens are list separators like `,`, not statement terminators, and
        // must not force a line break the way a real statement-ending `;`
        // does.
        const input = `func run() {
for var i = 0;
i < 10;
i++ {
Console.WriteLine(i)
}
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("for var i = 0; i < 10; i++ {\n", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_IsAFixedPointOnAJoinedForClauseHeader() {
        const input = `func run() {
for var i = 0; i < 10; i++ {
Console.WriteLine(i)
}
}
`
        let once = GSharpFormatter.Format(SourceText.From(input))
        let twice = GSharpFormatter.Format(once.Text!!)
        Assert.Empty(once.Diagnostics)
        Assert.Empty(twice.Diagnostics)
        Assert.Equal(once.Text!!.ToString(), twice.Text!!.ToString())
        Assert.False(twice.Changed)
    }

    @Theory
    @InlineData(`func run() {
for ; i < 10; i++ {
break
}
}
`, "for ; i < 10; i++ {\n")
    @InlineData(`func run() {
for var i = 0; ; i++ {
break
}
}
`, "for var i = 0; ; i++ {\n")
    @InlineData(`func run() {
for var i = 0; i < 10; {
break
}
}
`, "for var i = 0; i < 10; {\n")
    @InlineData(`func run() {
for ; ; {
break
}
}
`, "for ; ; {\n")
    func Format_SpacesAnEmptyForClauseCorrectly(input string, expectedHeader string) {
        // An empty clause leaves a for-clause separator with nothing but the
        // `for` keyword or the other separator to its left; the "no space
        // before `;`" rule that ordinarily hugs a statement-terminating `;`
        // to its preceding token must not glue it to `for` as `for;`.
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains(expectedHeader, result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_ParseFailureReturnsDiagnostics() {
        let result = GSharpFormatter.Format(SourceText.From("func broken( {\n"))
        Assert.Null(result.Text)
        Assert.NotEmpty(result.Diagnostics)
        Assert.False(result.Changed)
    }

    @Fact
    func FormatRange_OnlyReturnsEditsForIntersectingLines() {
        const input = `func first(){
return 1
}

func second(){
return 2
}
`
        let secondStart = input.IndexOf("func second", StringComparison.Ordinal)
        let result = GSharpFormatter.Format(SourceText.From(input), TextSpan(secondStart, input.Length - secondStart))
        let applied = ApplyEdits(input, result.Edits)
        Assert.Equal(applied, result.Text!!.ToString())
        Assert.StartsWith(`func first(){
return 1
}
`, applied, StringComparison.Ordinal)
        Assert.Contains(`func second() {
    return 2
}`, applied, StringComparison.Ordinal)
    }

    @Fact
    func FormatRange_DoesNotCoalesceAnAdjacentLineOutsideTheRange() {
        const input = `func run() {
var x = 1
var y = 2
}
`
        let start = input.IndexOf("var x", StringComparison.Ordinal)
        let result = GSharpFormatter.Format(SourceText.From(input), TextSpan(start, "var x = 1".Length))
        let applied = ApplyEdits(input, result.Edits)
        Assert.Contains(`
    var x = 1
`, applied, StringComparison.Ordinal)
        Assert.Contains(`
var y = 2
`, applied, StringComparison.Ordinal)
    }

    // ADR-0179 phase 6. These formatter defects made gsfmt reject its own output
    // on the migrated tree, which is invisible in normal use: the formatter
    // falls soft and hands the caller the unformatted text, so the symptom is
    // "wrapping did not happen here" rather than a crash.
    @Fact
    func Format_KeepsNullConditionalInvocationTightAgainstItsArgumentList() {
        const input = `func run(onBound ((int32) -> void)?) {
onBound?(1)
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("onBound?(1)", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_KeepsNullableConversionCallTightAgainstItsArgumentList() {
        const input = `func run(n int32) {
let widened = int32?(n)
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("int32?(n)", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_SpacesANullableTypeMarkerAwayFromAFollowingEquals() {
        const input = `func run() {
let root string?=nil
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("let root string? = nil", result.Text!!.ToString(), StringComparison.Ordinal)
        Assert.DoesNotContain("string?=", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_KeepsTheNullableSliceMarkerTightAgainstItsElementType() {
        // `[]?int32` puts the marker INSIDE the type clause, so the rule cannot
        // simply be "always space after a nullable `?`".
        const input = `func run(values []?int32) {
let first = values?[0]
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("[]?int32", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_KeepsDoubleLogicalNegationFromFusingIntoNullAssertion() {
        const input = `func run() {
let on = true
let doubled = ! !on
}
`
        let result = GSharpFormatter.Format(SourceText.From(input))
        Assert.Empty(result.Diagnostics)
        Assert.Contains("let doubled = ! !on", result.Text!!.ToString(), StringComparison.Ordinal)
    }

    @Fact
    func Format_KeepsACollectionInitializersFirstElementOnTheBraceLine() {
        let arguments = string.Join(", ", Enumerable.Range(0, 20).Select((index int32) -> "argument$index"))
        let input = (`func run(capacity int32) {
let items = List[int32](capacity){buildElement(` + "$arguments" + `)}
}
`)
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        // A newline immediately after the brace demotes this single nonliteral
        // initializer to a call followed by an unrelated block statement.
        Assert.Contains("){buildElement(", formatted, StringComparison.Ordinal)
    }

    @Fact
    func Format_BreaksAfterACollectionInitializerBraceWhenUnambiguous() {
        let elements = string.Join(", ", Enumerable.Range(0, 20).Select((index int32) -> "element$index"))
        let input = (`func run(capacity int32) {
let items = List[int32](capacity){` + "$elements" + `}
}
`)
        let result = GSharpFormatter.Format(SourceText.From(input))
        let formatted = result.Text!!.ToString()
        Assert.Empty(result.Diagnostics)
        Assert.Contains("){\n        element0,", formatted, StringComparison.Ordinal)
        Assert.All(
            formatted.Split('\n'),
            (line string) -> Assert.True(line.Length <= 120, "Line exceeded the canonical width: " + line)
        )
    }

    @Fact
    func Samples_RoundTripAndRemainIdempotent() {
        let root = FindRepositoryRoot()
        for path in Directory.EnumerateFiles(Path.Combine(root, "samples"), "*.gs", SearchOption.TopDirectoryOnly) {
            let input = File.ReadAllText(path)
            let once = GSharpFormatter.Format(SourceText.From(input, path))
            Assert.True(once.Diagnostics.IsEmpty, path + ": " + string.Join(Environment.NewLine, once.Diagnostics))
            let twice = GSharpFormatter.Format(once.Text!!)
            Assert.True(twice.Diagnostics.IsEmpty, path + ": " + string.Join(Environment.NewLine, twice.Diagnostics))
            Assert.Equal(once.Text!!.ToString(), twice.Text!!.ToString())
        }
    }

    shared {
        private func FindRepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil {
                if RepositoryRootMarker.IsRoot(directory.FullName) {
                    return directory.FullName
                }
                directory = directory.Parent
            }
            throw DirectoryNotFoundException("Could not locate GSharp.sln or GSharp.slnx.")
        }

        private func ApplyEdits(source string, edits ImmutableArray[TextEdit]) string {
            var source = source
            for edit in edits.OrderByDescending((item TextEdit) -> item.Span.Start) {
                source = source.Substring(0, edit.Span.Start) + edit.NewText + source.Substring(edit.Span.End)
            }
            return source
        }
    }
}
