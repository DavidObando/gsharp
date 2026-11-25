package GSharp.Compiler.Tests.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import System.Text
import Xunit

class Issue6231ScopedSymbolsTests {
    @Fact
    func Driver_NearestScopesAndLexicalLambda_DoNotLeak() {
        AssertOutput(`import System
import System.Diagnostics
@file:DefineSymbol("A")
@Conditional("A")
@Conditional("B")
func Log(value string) { Console.Write(value) }
@UndefineSymbol("A")
func Quiet() {
    Log("bad")
    @DefineSymbol("B") {
        let run = () -> Log("L")
        run()
    }
    Log("bad")
}
Quiet()
Log("A")
@UndefineSymbol("A") { Log("bad") }
Log("Z")`, "LAZ")
    }

    @Fact
    func Driver_DefinedIsConstantAndDoesNotHideOrdinaryFunction() {
        AssertOutput(`import System
@file:DefineSymbol("A", "class")
func defined(value string) bool { return value == "ordinary" }
const present = @defined("A")
const absent = @defined("a")
Console.Write(present)
Console.Write(absent)
Console.Write(defined("ordinary"))
Console.Write(@defined("class"))
@UndefineSymbol("A") { Console.Write(@defined("A")) }
Console.Write(@defined("A"))`, "TrueFalseTrueTrueFalseTrue")
    }

    @Fact
    func Driver_InactiveAlternativesAndMembers_AreNotBoundOrEmitted() {
        AssertOutput(`import System
@If(false)
@MissingAttribute
func Value() MissingType { return Missing() }
@If(true)
func Value() int32 { return 7 }
class Box {
    @If(false)
    var Bad MissingType = Missing()
    @If(false)
    func Read() MissingType { return Missing() }
    @If(true)
    func Read() int32 { return Value() }
}
Console.Write(Box().Read())`, "7")
    }

    @Fact
    func Driver_InclusionUsesStrictAncestors_AndActiveEnumOrder() {
        AssertOutput(`import System
@DefineSymbol("SELF")
@If(@defined("SELF"))
func Value() MissingType { return Missing() }
@If(!@defined("SELF"))
func Value() int32 { return 9 }
@DefineSymbol("INNER")
class Box {
    @If(@defined("INNER"))
    func Read() bool { return @defined("INNER") }
}
enum Choice {
    First,
    @If(false) Removed,
    Last
}
Console.Write(Value())
Console.Write(Box().Read())
Console.Write(int32(Choice.Last))`, "9True1")
    }

    @Fact
    func Driver_InactiveLocalsAndYield_DoNotAffectFlowOrIteratorClassification() {
        AssertOutput(`import System
func Read() int32 {
    @If(false) let missing = Unavailable()
    @If(false) { yield return Unavailable() }
    @If(true) let result = 5
    return result
}
Console.Write(Read())`, "5")
    }

    @Fact
    func SameTree_DifferentCompilationBases_AreIndependent() {
        let tree = SyntaxTree.Parse(SourceText.From(`@If(@defined("A"))
func Selected() int32 { return 1 }
@If(!@defined("A"))
func Selected() int32 { return 2 }
`))
        for enabled in[]bool{false, true, false} {
            let compilation = Compilation(tree){
                IsLibrary = true,
                PreprocessorSymbols = if enabled {
                    ImmutableHashSet.Create("A")
                } else {
                    ImmutableHashSet[string].Empty
                }
            }
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError))
            let declarations = tree.Root.Members.OfType[FunctionDeclarationSyntax]().ToArray()
            Assert.Equal(enabled, compilation.IsActive(declarations[0]))
            Assert.Equal(!enabled, compilation.IsActive(declarations[1]))
            let model = compilation.GetSemanticModel(tree)
            Assert.NotNull(
                model.GetDeclaredSymbol(
                    declarations[
                        if enabled {
                            0
                        } else {
                            1
                        }
                    ]
                )
            )
            Assert.Null(
                model.GetDeclaredSymbol(
                    declarations[
                        if enabled {
                            1
                        } else {
                            0
                        }
                    ]
                )
            )
        }
    }

    @Fact
    func OrdinaryFalseIf_StillChecksBothArms() {
        let source = `func Run() { if @defined("ABSENT") { Missing() } }`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source))){IsLibrary = true}
        let diagnostics = compilation.GetDiagnostics().Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.NotEmpty(diagnostics)
        Assert.Contains(
            diagnostics,
            (d Diagnostic) -> d.Location.Span.Start == source.IndexOf("Missing", StringComparison.Ordinal)
        )
    }

    private func AssertOutput(source string, expected string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(source, "ScopedSymbols6231", executable: true)
        Assert.Equal(Encoding.UTF8.GetBytes(expected), fixture.RunBytes(program))
        IlVerifier.Verify(program)
    }
}
