package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Syntax
import System
import System.IO
import System.Linq
import System.Text
import Xunit

class Issue6074ConstructorInitializerTests {
    @Theory
    @InlineData("source", "this", "")
    @InlineData("source", "banana", "")
    @InlineData("interface", "this", "")
    @InlineData("interface", "banana", "")
    @InlineData("none", "this", "")
    @InlineData("none", "banana", "")
    @InlineData("source", "this", "func ")
    @InlineData("source", "banana", "func ")
    func InvalidTarget_RejectsImageAndCompilesSuggestedRemedy(kind string, target string, prefix string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let hasBase = kind == "source"
        let baseClause = if hasBase {
            " : Base"
        } else if kind == "interface" {
            " : IDisposable"
        } else {
            ""
        }
        let designatedClause = if hasBase {
            " : base(Mark(\"b\", value))"
        } else {
            ""
        }
        let source = `import System
var calls int32 = 0
func Mark(label string, value int32) int32 {
    calls++
    Console.Write(label)
    return value
}
open class Base {
    init(value int32) {
        Console.Write("B")
        Console.Write(value)
    }
}
class Derived` + baseClause + ` {
    var start int32
    init(value int32)` + designatedClause + ` {
        start = value
        Console.Write("D")
    }
    ` + prefix + `init() : ` + target + `(Mark("a", 42)) {}
    public func Dispose() {}
    func Read() int32 -> start
}
Console.Write(Derived().Read())
Console.Write(":")
Console.Write(calls)
`
        let (code, output) = fixture.TryCompile(source, "rejected", true)
        Assert.NotEqual(0, code)
        let column = 14 + prefix.Length
        let endColumn = column + target.Length
        Assert.Contains("rejected.gs(20,$column,20,$endColumn): error GS0642:", output, StringComparison.Ordinal)
        Assert.Equal(1, output.Split(": error ", StringSplitOptions.None).Length - 1)
        Assert.Contains("Only 'base' is valid after ':'", output, StringComparison.Ordinal)
        const remedy = "convenience init() { init(args) }"
        Assert.Contains(remedy, output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "rejected.dll")))

        let corrected = source.Replace(
            prefix + "init() : " + target + "(Mark(\"a\", 42)) {}",
            remedy.Replace("args", "Mark(\"a\", 42)", StringComparison.Ordinal),
            StringComparison.Ordinal
        )
        let assembly = fixture.Compile(corrected, "convenience", true)
        IlVerifier.Verify(assembly)
        Assert.Equal(
            Encoding.UTF8.GetBytes(
                if hasBase {
                    "abB42D42:2"
                } else {
                    "aD42:1"
                }
            ),
            fixture.RunBytes(assembly)
        )
        if hasBase {
            let genuineBase = source.Replace(": " + target + "(", ": base(", StringComparison.Ordinal)
            let baseAssembly = fixture.Compile(genuineBase, "genuine-base", true)
            IlVerifier.Verify(baseAssembly)
            Assert.Equal(Encoding.UTF8.GetBytes("aB420:1"), fixture.RunBytes(baseAssembly))
        }
    }

    @Theory
    @InlineData("class C", "")
    @InlineData("class C", "func ")
    @InlineData("struct C", "")
    @InlineData("data struct C", "func ")
    @InlineData("let value = object", "")
    @InlineData("let value = object", "func ")
    func InvalidTarget_RecoversBodyAndFollowingMembers(owner string, prefix string) {
        let source = owner + ` {
    ` + prefix + `init() : banana(Call(1, 2)) { Call(3, 4) }
    func After() int32 -> 7
}
func Last() int32 -> 9
`
        let tree = SyntaxTree.Parse(source)
        let diagnostic = Assert.Single(tree.Diagnostics.Where((d) -> d.Id == "GS0642"))
        Assert.Equal(1, diagnostic.Location.StartLine)
        Assert.Equal(13 + prefix.Length, diagnostic.Location.StartCharacter)
        Assert.Equal("banana", tree.Text.ToString(diagnostic.Location.Span))
        Assert.Equal(
            if owner == "let value = object" {
                2
            } else {
                1
            },
            tree.Diagnostics.Length
        )
        let methods = Descendants(tree.Root).OfType[FunctionDeclarationSyntax]().ToArray()
        Assert.Equal(
            []string{"After", "Last"},
            methods.Select((method FunctionDeclarationSyntax) -> method.Identifier.Text).ToArray()
        )
        if owner != "let value = object" {
            let constructor = Assert.Single(Descendants(tree.Root).OfType[ConstructorDeclarationSyntax]())
            Assert.Equal("{ Call(3, 4) }", tree.Text.ToString(constructor.Body.Span))
        }
        let last = Assert.Single(Descendants(methods[1]).OfType[LiteralExpressionSyntax]())
        Assert.Equal(9, last.Value)
    }

    shared {
        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Descendants(child) {
                    yield descendant
                }
            }
        }
    }
}
