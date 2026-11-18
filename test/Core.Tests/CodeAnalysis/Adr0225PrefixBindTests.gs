// <copyright file="Adr0225PrefixBindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// ADR-0225: (cref:Compilation.BindPrefix) binds a tree as if its text ended at a cut, and the binder
/// classifies each diagnostic as final, future-dependent or an artifact of the cut.
open class Adr0225PrefixBindTests {
    @Fact
    func OpenBody_NotAllPathsReturn_IsFutureDependent() {
        const source = `package P

func Value(x int32) int32 {
    var y = x + 1
    if y > 0 {
        y = y + 1
/*CUT*/
    }
    return y
}
`
        for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
            let result = Bind(source, remainder)
            let diagnostic = Assert.Single(result.Diagnostics)
            Assert.Equal("GS0100", diagnostic.Diagnostic.Id)
            Assert.Equal(DiagnosticFinality.FutureDependent, diagnostic.Finality)
            Assert.Equal("rest-of-body", diagnostic.Reason)
        }
    }

    @Fact
    func ClosedBody_NotAllPathsReturn_IsFinal() {
        const source = `package P

func Value(x int32) int32 {
    let y = x + 1
}

func Main() {
    let z = Value(1)
/*CUT*/
}
`
        for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
            let diagnostic = Assert.Single(Bind(source, remainder).Diagnostics)
            Assert.Equal("GS0100", diagnostic.Diagnostic.Id)
            Assert.Equal(source.IndexOf("Value", StringComparison.Ordinal), diagnostic.Diagnostic.Location.Span.Start)
            Assert.Equal(DiagnosticFinality.Final, diagnostic.Finality)
            Assert.Equal(string.Empty, diagnostic.Reason)
        }
    }

    @Fact
    func OpenType_MissingInterfaceMember_IsFutureDependent() {
        const source = `package P

interface IShape {
    func Area() float64;
    func Name() string;
}

class Square : IShape {
    func Area() float64 {
        return 1.0
    }
/*CUT*/
    func Name() string {
        return "square"
    }
}
`
        let openType = Bind(source, PrefixRemainder.Nothing)
        Assert.NotEmpty(openType.Diagnostics)
        Assert.All(
            openType.Diagnostics,
            (d ClassifiedDiagnostic) -> {
                Assert.Equal(DiagnosticFinality.FutureDependent, d.Finality)
                Assert.Equal("rest-of-type", d.Reason)
            }
        )
        // The later members are present, so the type is complete.
        Assert.Empty(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics)
    }

    @Fact
    func OpenTry_WithoutCatch_IsFutureDependent() {
        const source = `package P

import System

func Main() {
    try {
        Console.WriteLine("work")
/*CUT*/
    } catch {
        Console.WriteLine("failed")
    }
}
`
        let diagnostic = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal("GS0118", diagnostic.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, diagnostic.Finality)
        Assert.Equal("rest-of-statement", diagnostic.Reason)
    }

    @Fact
    func UnknownName_DependsOnWhatFollowsTheCut() {
        const source = `package P

import System

func Main() {
    Console.WriteLine(1)
    undefinedThing(2)
/*CUT*/
    Console.WriteLine(3)
}
`
        // A later top-level function can declare the name.
        let nothing = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal("GS0130", nothing.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, nothing.Finality)
        Assert.Equal("later-declaration", nothing.Reason)
        // Every later declaration is present, and a statement cannot declare a name for an earlier one.
        let keep = Assert.Single(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics)
        Assert.Equal("GS0130", keep.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.Final, keep.Finality)
    }

    @Fact
    func UnknownNameInFunctionLiteral_CanBeALaterLocal() {
        const source = `package P

func Main() {
    let first = func (n int32) int32 {
        return second(n)
    }
/*CUT*/
    let second = func (n int32) int32 {
        return n
    }
}
`
        let keep = Assert.Single(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics)
        Assert.Equal("GS0130", keep.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, keep.Finality)
        Assert.Equal("later-declaration", keep.Reason)
    }

    @Fact
    func UnknownStaticMemberOfAnImportedType_IsFinalWhenTheDeclarationsAreKept() {
        const source = `package P

import System

func Main() {
    Console.WriteLin("x")
    let pi = Math.PIE
/*CUT*/
}
`
        // A later source type named `Console` or `Math` can hide the imported one.
        let nothing = Bind(source, PrefixRemainder.Nothing).Diagnostics
        Assert.Equal(
            []string{"GS0159", "GS0158"},
            nothing.Select((d ClassifiedDiagnostic) -> d.Diagnostic.Id).ToArray()
        )
        Assert.All(
            nothing,
            (d ClassifiedDiagnostic) -> {
                Assert.Equal(DiagnosticFinality.FutureDependent, d.Finality)
                Assert.Equal("later-member", d.Reason)
            }
        )
        let keep = Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics
        Assert.Equal([]string{"GS0159", "GS0158"}, keep.Select((d ClassifiedDiagnostic) -> d.Diagnostic.Id).ToArray())
        Assert.All(keep, (d ClassifiedDiagnostic) -> Assert.Equal(DiagnosticFinality.Final, d.Finality))
    }

    @Fact
    func ClosedPartialType_MissingInterfaceMember_CanBeALaterPart() {
        const source = `package P

partial class Holder : System.IDisposable {
    func Run() {
    }
}

func Main() {
    let x = 1
/*CUT*/
}
`
        let nothing = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal("GS0187", nothing.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, nothing.Finality)
        Assert.Equal("rest-of-type", nothing.Reason)
        Assert.Equal(
            DiagnosticFinality.Final,
            Assert.Single(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics).Finality
        )
    }

    @Fact
    func PartialTypeWithAnOpenLaterPart_MissingInterfaceMember_IsFutureDependent() {
        const source = `package P

interface IWork {
    func Run();
}

partial class Worker : IWork {
}

partial class Worker {
/*CUT*/
    func Run() {
    }
}
`
        let nothing = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal("GS0187", nothing.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, nothing.Finality)
        Assert.Equal("rest-of-type", nothing.Reason)
        Assert.Empty(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics)
    }

    @Fact
    func TryThatEndsAtTheCut_WithoutCatch_IsFutureDependent() {
        const source = `package P

import System

func Main() {
    try {
        Console.WriteLine(1)
    }
/*CUT*/
    catch {
        Console.WriteLine(2)
    }
}
`
        for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
            let diagnostic = Assert.Single(Bind(source, remainder).Diagnostics)
            Assert.Equal("GS0118", diagnostic.Diagnostic.Id)
            Assert.Equal(DiagnosticFinality.FutureDependent, diagnostic.Finality)
            Assert.Equal("rest-of-statement", diagnostic.Reason)
        }
    }

    @Fact
    func OutParameter_DependsOnHowTheBodyExits() {
        const openLiteral = `package P

func Main() {
    let f = func (out v int32) {
        let x = 1
/*CUT*/
        v = x
    }
}
`
        const completedReturn = `package P

func Get(out v int32) bool {
    let x = 1
    return true
/*CUT*/
}
`
        for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
            let literal = Assert.Single(Bind(openLiteral, remainder).Diagnostics)
            Assert.Equal("GS0238", literal.Diagnostic.Id)
            Assert.Equal(DiagnosticFinality.FutureDependent, literal.Finality)
            let completed = Assert.Single(Bind(completedReturn, remainder).Diagnostics)
            Assert.Equal("GS0238", completed.Diagnostic.Id)
            Assert.Equal(DiagnosticFinality.Final, completed.Finality)
        }
    }

    @Fact
    func Scope_AfterAnInnerBlock_KeepsTheOuterLocals() {
        const source = `package P

func F(p int32) {
    let x = p
    if true {
        let y = 2
    }/*CUT*/
    let z = x
}
`
        let names = Bind(source, PrefixRemainder.Nothing).Scope.Select((s Symbol) -> s.Name).ToList()
        Assert.Contains("p", names)
        Assert.Contains("x", names)
        Assert.DoesNotContain("y", names)
    }

    @Fact
    func PrefixOnlyTree_UnfinishedTextAtTheEnd_IsAnArtifact() {
        let texts = []string{
            "package P\nfunc Main() {\n    let x =",
            "package P\nfunc Main() {\n    let s = \"abc",
            "package P\n/* unfinished",
            "package P\nfunc Main() {\n    let s = \"abc\\",
            "package P\nfunc Main() {\n    let s = \"\\u00"
        }
        for text in texts {
            let tree = SyntaxTree.Parse(SourceText.From(text, "prefix.gs"))
            for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
                let result = Compilation(tree).BindPrefix(tree, text.Length, PrefixBindOptions(remainder))
                Assert.NotEmpty(result.Diagnostics)
                Assert.All(
                    result.Diagnostics,
                    (d ClassifiedDiagnostic) -> {
                        Assert.Equal(DiagnosticFinality.Artifact, d.Finality)
                        Assert.Equal("cut", d.Reason)
                    }
                )
            }
        }
    }

    @Fact
    func LexicalErrorInACompletedToken_IsFinal() {
        let texts = []string{
            "package P\nfunc Main() {\n    let s = \"\\q\" ",
            "package P\nfunc Main() {\n    let s = \"\\q\""
        }
        for text in texts {
            let tree = SyntaxTree.Parse(SourceText.From(text, "prefix.gs"))
            for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
                let result = Compilation(tree).BindPrefix(tree, text.Length, PrefixBindOptions(remainder))
                let escape = result.Diagnostics.Single((d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0269")
                Assert.Equal(DiagnosticFinality.Final, escape.Finality)
            }
        }
    }

    @Fact
    func PrefixOnlyTree_OpenTypeWithoutItsClosingBrace_IsSealed() {
        let text = "package P\nclass Holder : System.IDisposable {"
        let tree = SyntaxTree.Parse(SourceText.From(text, "prefix.gs"))
        let result = Compilation(tree).BindPrefix(
            tree,
            text.Length,
            PrefixBindOptions(PrefixRemainder.KeepDeclarations)
        )
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0187", diagnostic.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, diagnostic.Finality)
        let construct = Assert.Single(result.OpenConstructs)
        Assert.Equal(SyntaxKind.StructDeclaration, construct.Kind)
        Assert.Equal("Holder", construct.Symbol?.Name)
    }

    @Fact
    func WordSplitByTheCut_IsNotFinal() {
        const source = `package P

func Main() {
    let value = 1
    let copy = val/*CUT*/ue
}
`
        for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
            let diagnostic = Assert.Single(Bind(source, remainder).Diagnostics)
            Assert.Equal("GS0125", diagnostic.Diagnostic.Id)
            Assert.Equal(DiagnosticFinality.FutureDependent, diagnostic.Finality)
        }
    }

    @Fact
    func DuplicateExplicitImplementation_InAnOpenType_IsFinal() {
        const source = `package P

interface IFoo {
    func Bar() int32;
}

class Impl : IFoo {
    private func (IFoo) Bar() int32 { return 1 }

    private func (IFoo) Bar() int32 { return 2 }
/*CUT*/
}
`
        let diagnostic = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal("GS0495", diagnostic.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.Final, diagnostic.Finality)
    }

    @Fact
    func OpenFunctionLiteral_ReportsItsReturnType() {
        const source = `package P

func Main() {
    let f = func () int32 {
        let n = 1
/*CUT*/
        return n
    }
}
`
        let result = Bind(source, PrefixRemainder.Nothing)
        Assert.Equal(SyntaxKind.FunctionLiteralExpression, result.OpenConstructs[0].Kind)
        Assert.Equal(TypeSymbol.Int32, result.OpenConstructs[0].ExpectedType)
        Assert.Equal(SyntaxKind.FunctionDeclaration, result.OpenConstructs[1].Kind)
    }

    @Fact
    func PrefixOnlyTree_KeepsTheOpenMemberFacts() {
        const text = `package P

func Main() {
    let first = func () {
        second()
    }`
        let tree = SyntaxTree.Parse(SourceText.From(text, "prefix.gs"))
        let result = Compilation(tree).BindPrefix(
            tree,
            text.Length,
            PrefixBindOptions(PrefixRemainder.KeepDeclarations)
        )
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0130", diagnostic.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, diagnostic.Finality)
        Assert.Equal("later-declaration", diagnostic.Reason)
    }

    @Fact
    func UnknownInstanceMember_CanBeALaterReceiverFunction() {
        const source = `package P

import System

func Main() {
    let text = "abc"
    Console.WriteLine(text.Twice())
/*CUT*/
}

func (value string) Twice() string {
    return value + value
}
`
        // A receiver function after the cut can declare the member.
        let nothing = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal(DiagnosticFinality.FutureDependent, nothing.Finality)
        Assert.Equal("later-member", nothing.Reason)
        Assert.Empty(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics)
    }

    @Fact
    func UnknownTypeAsReceiver_CanBeALaterType() {
        const source = `package P

func Main() {
    Later.Run()
/*CUT*/
}

class Later {
    shared {
        func Run() {
        }
    }
}
`
        let nothing = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal("GS0157", nothing.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, nothing.Finality)
        Assert.Equal("later-declaration", nothing.Reason)
        Assert.Empty(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics)
    }

    @Fact
    func StaticMemberOfASourceTypeWithAnImportedBase_CanBeALaterMember() {
        const source = `package P

import System

class Failure : Exception {
    func Use() int32 {
        return Failure.Code
    }
/*CUT*/
    shared {
        let Code int32 = 1
    }
}
`
        let nothing = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal("GS0158", nothing.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, nothing.Finality)
        Assert.Equal("later-member", nothing.Reason)
        Assert.Empty(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics)
    }

    @Fact
    func EndOfBodyChecks_InAnOpenBody_AreFutureDependent() {
        const outParameter = `package P

func Get(out v int32) {
    let x = 1
/*CUT*/
    v = x
}
`
        const label = `package P

import System

func Main() {
    goto done
/*CUT*/
done:
    Console.WriteLine(2)
}
`
        const exhaustive = `package P

enum Color { Red, Green }

func Name(c Color) string {
    var s = "?"
    switch c {
        case Color.Red {
            s = "r"
        }
/*CUT*/
        case Color.Green {
            s = "g"
        }
    }
    return s
}
`
        const partialMethod = `package P

import System

partial class Box {
    partial func Hook();
/*CUT*/
    partial func Hook() {
        Console.WriteLine(1)
    }
}
`
        let expected = []string{"GS0238", "GS0469", "GS0178", "GS0609"}
        let sources = []string{outParameter, label, exhaustive, partialMethod}
        for var i = 0; i < sources.Length; i++ {
            let diagnostics = Bind(sources[i], PrefixRemainder.Nothing)
                .Diagnostics
                .Where((d ClassifiedDiagnostic) -> d.Diagnostic.Id != "GS0100")
                .ToList()
            let diagnostic = Assert.Single(diagnostics)
            Assert.Equal(expected[i], diagnostic.Diagnostic.Id)
            Assert.Equal(DiagnosticFinality.FutureDependent, diagnostic.Finality)
        }
    }

    @Fact
    func UnknownMemberInTopLevelStatements_IsFinalWhenTheDeclarationsAreKept() {
        const source = `package P

import System

let text = "abc"
Console.WriteLine(text.Lenght)
/*CUT*/
Console.WriteLine(1)
`
        let nothing = Assert.Single(Bind(source, PrefixRemainder.Nothing).Diagnostics)
        Assert.Equal(DiagnosticFinality.FutureDependent, nothing.Finality)
        let keep = Assert.Single(Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics)
        Assert.Equal("GS0158", keep.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.Final, keep.Finality)
    }

    @Fact
    func TreeOfThePrefixText_BindsLikeTheCutOfTheWholeText() {
        const source = `package P

import System

func Value(x int32) int32 {
    Console.WriteLin(x)
    let y = x + 1
/*CUT*/
    return y
}
`
        let cut = source.IndexOf("/*CUT*/", StringComparison.Ordinal)
        let prefixTree = SyntaxTree.Parse(SourceText.From(source.Substring(0, cut), "prefix.gs"))
        let result = Compilation(prefixTree).BindPrefix(prefixTree, cut, PrefixBindOptions(PrefixRemainder.Nothing))
        let whole = Bind(source, PrefixRemainder.Nothing)
        Assert.Equal(
            whole.Diagnostics.Select((d ClassifiedDiagnostic) -> d.ToString()).ToArray(),
            result.Diagnostics.Select((d ClassifiedDiagnostic) -> d.ToString()).ToArray()
        )
        Assert.Equal(
            []string{"GS0159", "GS0100"},
            result.Diagnostics.Select((d ClassifiedDiagnostic) -> d.Diagnostic.Id).ToArray()
        )
        Assert.Contains("y", result.Scope.Select((s Symbol) -> s.Name))
    }

    @Fact
    func CallWithAnOpenArgumentList_IsFutureDependent() {
        const source = `package P

import System
import System.Linq

func Main() {
    let words = Enumerable.Range(0, 3)
    let joined = words.Join(words, func (a int32) int32 {
        let k = a
/*CUT*/
        return k
    }, func (b int32) int32 { return b }, func (a int32, b int32) int32 { return a + b })
    Console.WriteLine(joined.Count())
}
`
        // The seal closes the call after its second argument; more arguments can follow the cut.
        let keep = Bind(source, PrefixRemainder.KeepDeclarations).Diagnostics.Single(
            (d ClassifiedDiagnostic) -> d.Diagnostic.Id == "GS0159"
        )
        Assert.Equal(DiagnosticFinality.FutureDependent, keep.Finality)
        Assert.Equal("rest-of-statement", keep.Reason)
    }

    @Fact
    func ParseErrorAtTheCut_IsAnArtifact() {
        const source = `package P

import System

func Main() {
    Console.WriteLine(1 +/*CUT*/ 2)
}
`
        let result = Bind(source, PrefixRemainder.Nothing)
        Assert.NotEmpty(result.Diagnostics)
        Assert.All(
            result.Diagnostics,
            (d ClassifiedDiagnostic) -> {
                Assert.Equal(DiagnosticFinality.Artifact, d.Finality)
                Assert.Equal("cut", d.Reason)
            }
        )
    }

    @Fact
    func OpenConstructsAndScope_DescribeTheCut() {
        const source = `package P

import System

func Value(x int32) int32 {
    let y = x + 1
    if y > 0 {
        let z = y * 2
/*CUT*/
    }
    return y
}
`
        let result = Bind(source, PrefixRemainder.Nothing)
        Assert.Equal(2, result.OpenConstructs.Length)
        Assert.Equal(SyntaxKind.BlockStatement, result.OpenConstructs[0].Kind)
        Assert.Null(result.OpenConstructs[0].Symbol)
        Assert.Equal(SyntaxKind.FunctionDeclaration, result.OpenConstructs[1].Kind)
        Assert.Equal("Value", result.OpenConstructs[1].Symbol?.Name)
        Assert.Equal(TypeSymbol.Int32, result.OpenConstructs[1].ExpectedType)
        let names = result.Scope.Select((s Symbol) -> s.Name).ToList()
        Assert.Contains("z", names)
        Assert.Contains("y", names)
        Assert.Contains("x", names)
        let withoutScope = BindWith(source, PrefixBindOptions(PrefixRemainder.Nothing, includeScope: false))
        Assert.Empty(withoutScope.Scope)
    }

    @Fact
    func BindPrefix_DoesNotChangeTheCompilation() {
        const source = `package P

func Value(x int32) int32 {
    let y = x + 1
/*CUT*/
    return missing
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source.Replace("/*CUT*/", string.Empty), "prefix.gs"))
        let compilation = Compilation(tree)
        let cut = source.IndexOf("/*CUT*/", StringComparison.Ordinal)
        let first = compilation.BindPrefix(tree, cut, PrefixBindOptions(PrefixRemainder.Nothing))
        let second = compilation.BindPrefix(tree, cut, PrefixBindOptions(PrefixRemainder.KeepDeclarations))
        Assert.NotSame(first.Compilation, second.Compilation)
        Assert.Same(tree, Assert.Single(compilation.SyntaxTrees))
        let expected = Compilation(
            SyntaxTree.Parse(SourceText.From(tree.Text.ToString(), "prefix.gs"))
        ).GetDiagnostics()
        let actual = compilation.GetDiagnostics()
        Assert.Equal(Describe(expected), Describe(actual))
        Assert.Equal("GS0125", Assert.Single(actual).Id)
    }

    @Fact
    func BindPrefix_RejectsATreeOfAnotherCompilationAndACutOutsideTheText() {
        let tree = SyntaxTree.Parse("package P\n")
        let compilation = Compilation(tree)
        let options = PrefixBindOptions(PrefixRemainder.Nothing)
        Assert.Throws[ArgumentException](() -> compilation.BindPrefix(SyntaxTree.Parse("package Q\n"), 0, options))
        Assert.Throws[ArgumentOutOfRangeException](() -> compilation.BindPrefix(tree, tree.Text.Length + 1, options))
        Assert.Throws[ArgumentOutOfRangeException](() -> compilation.BindPrefix(tree, -1, options))
    }

    /// The complete programs: a cut at the end of the text that keeps every declaration reports
    /// exactly the diagnostics of (cref:Compilation.GetDiagnostics), and every one is final.
    @Fact
    func CompleteSamples_ReportTodaysDiagnostics() {
        var compared = 0
        let mismatches = List[string]()
        for file in SampleFiles() {
            let tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(file), file))
            let compilation = Compilation(tree)
            let result = compilation.BindPrefix(
                tree,
                tree.Text.Length,
                PrefixBindOptions(PrefixRemainder.KeepDeclarations, includeScope: false)
            )
            let expected = Describe(compilation.GetDiagnostics())
            let actual = Describe(result.Diagnostics.Select((d ClassifiedDiagnostic) -> d.Diagnostic))
            if expected != actual {
                mismatches.Add("${Path.GetFileName(file)}: ${actual} instead of ${expected}")
            }
            for d in result.Diagnostics {
                compared++
                if d.Finality != DiagnosticFinality.Final {
                    mismatches.Add("${Path.GetFileName(file)}: ${d}")
                }
            }
        }
        Assert.True(compared > 10, "compared ${compared} diagnostics")
        Assert.True(mismatches.Count == 0, string.Join("\n", mismatches))
    }

    /// ADR-0225 test plan, check 1: at each statement boundary of each sample, in both modes, every
    /// final diagnostic of the prefix appears with the same ID and span in the complete file.
    @Fact
    func SamplePrefixes_ReportFinalDiagnosticsOnlyWhereTheCompleteFileDoes() {
        var cuts = 0
        var futureDependent = 0
        let wrong = List[string]()
        for file in SampleFiles() {
            let tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(file), file))
            let compilation = Compilation(tree)
            let complete = HashSet[string](compilation.GetDiagnostics().Select((d Diagnostic) -> Key(d)))
            for cut in StatementBoundaries(tree, 8, functionBodiesOnly: false) {
                for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
                    cuts++
                    let result = compilation.BindPrefix(tree, cut, PrefixBindOptions(remainder, includeScope: false))
                    for d in result.Diagnostics {
                        if d.Finality == DiagnosticFinality.FutureDependent {
                            futureDependent++
                        } else if d.Finality == DiagnosticFinality.Final && !complete.Contains(Key(d.Diagnostic)) {
                            wrong.Add("${Path.GetFileName(file)} cut ${cut} ${remainder}: ${d}")
                        }
                    }
                }
            }
        }
        Assert.True(cuts > 1000, "checked ${cuts} cuts")
        Assert.True(futureDependent > 50, "${futureDependent} future-dependent diagnostics")
        Assert.True(wrong.Count == 0, string.Join("\n", wrong.Take(40)))
    }

    /// ADR-0225 test plan, check 2: an error in the statement before the cut appears in the prefix with
    /// the ID and span of the complete file. It is final when no later declaration can remove it.
    @Fact
    func SamplePrefixes_ReportAnInjectedErrorAsTheCompleteFileDoes() {
        var checkedMutations = 0
        let wrong = List[string]()
        for file in SampleFiles() {
            let text = File.ReadAllText(file)
            let tree = SyntaxTree.Parse(SourceText.From(text, file))
            for cut in StatementBoundaries(tree, 4, functionBodiesOnly: true) {
                for mutation in Mutations {
                    let statement = "\n" + mutation.Statement
                    let mutated = text.Substring(0, cut) + statement + text.Substring(cut)
                    let mutatedCut = cut + statement.Length
                    let mutatedTree = SyntaxTree.Parse(SourceText.From(mutated, file))
                    let compilation = Compilation(mutatedTree)
                    let expected = compilation
                        .GetDiagnostics()
                        .Where((d Diagnostic) -> d.Location.Span.Start > cut && d.Location.Span.End <= mutatedCut)
                        .ToList()
                    if expected.Count != 1 || expected[0].Id != mutation.Id {
                        wrong.Add(
                            "${Path.GetFileName(file)} cut ${cut} ${mutation.Id}: complete file reports ${Describe(expected)}"
                        )
                        continue
                    }
                    for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
                        checkedMutations++
                        let result = compilation.BindPrefix(
                            mutatedTree,
                            mutatedCut,
                            PrefixBindOptions(remainder, false)
                        )
                        let found = result
                            .Diagnostics
                            .Where((d ClassifiedDiagnostic) -> Key(d.Diagnostic) == Key(expected[0]))
                            .ToList()
                        let finality = if remainder == PrefixRemainder.Nothing {
                            mutation.WithNothingAfterTheCut
                        } else {
                            DiagnosticFinality.Final
                        }
                        if found.Count != 1 || found[0].Finality != finality {
                            wrong.Add(
                                "${Path.GetFileName(file)} cut ${cut} ${remainder} ${mutation.Id}: expected ${finality}, got ${string.Join("; ", result.Diagnostics)}"
                            )
                        }
                    }
                }
            }
        }
        Assert.True(checkedMutations > 500, "checked ${checkedMutations} mutations")
        Assert.True(wrong.Count == 0, string.Join("\n", wrong.Take(40)))
    }

    shared {
        // The statements that the mutation check inserts, the ID that the complete file reports, and the
        // finality when nothing follows the cut. A later declaration can declare the name, or a later type can
        // hide the imported one.
        private let Mutations[](Statement string, Id string, WithNothingAfterTheCut DiagnosticFinality) = [](
            string,
            string,
            DiagnosticFinality
        ){
            ("System.Console.NoSuchMember__(1)", "GS0159", DiagnosticFinality.FutureDependent),
            ("let noSuchProperty__ = System.Math.NoSuchProperty__", "GS0158", DiagnosticFinality.FutureDependent),
            ("System.Math.Abs()", "GS0159", DiagnosticFinality.FutureDependent),
            ("noSuchFunction__(1)", "GS0130", DiagnosticFinality.FutureDependent)
        }

        private func Bind(source string, remainder PrefixRemainder) PrefixBindResult -> BindWith(
            source,
            PrefixBindOptions(remainder)
        )

        private func BindWith(source string, options PrefixBindOptions) PrefixBindResult {
            let cut = source.IndexOf("/*CUT*/", StringComparison.Ordinal)
            Assert.True(cut >= 0)
            let tree = SyntaxTree.Parse(SourceText.From(source.Replace("/*CUT*/", string.Empty), "prefix.gs"))
            return Compilation(tree).BindPrefix(tree, cut, options)
        }

        private func Key(d Diagnostic) string -> "${d.Id}@${d.Location.Span.Start}:${d.Location.Span.Length}"

        private func Describe(diagnostics IEnumerable[Diagnostic]) string -> string.Join(
            "; ",
            diagnostics.Select((d Diagnostic) -> "${Key(d)} ${d.Severity} ${d.Message}")
        )

        private func SampleFiles() List[string] {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            Assert.NotNull(directory)
            return Directory
                .GetFiles(Path.Combine(directory!!.FullName, "samples"), "*.gs")
                .OrderBy((f string) -> f, StringComparer.Ordinal)
                .ToList()
        }

        // The ends of statements whose parent is a block or the file, evenly spread. With
        // [`functionBodiesOnly`](paramref), only statements in a function body outside function literals.
        private func StatementBoundaries(tree SyntaxTree, count int32, functionBodiesOnly bool) List[int32] {
            let cuts = SortedSet[int32]()
            let pending = Stack[SyntaxNode]()
            pending.Push(tree.Root)
            while pending.Count > 0 {
                let node = pending.Pop()
                for child in node.GetChildren() {
                    pending.Push(child)
                }
                if node is StatementSyntax statement {
                    let parent = tree.GetParent(node)
                    if functionBodiesOnly {
                        // An expression body is a block without braces; its statement ends the member.
                        if parent is BlockStatementSyntax block &&
                            block
                            .OpenBraceToken
                            .Span
                            .Length > 0 &&
                            IsInFunctionBody(tree, node) {
                            cuts.Add(statement.Span.End)
                        }
                    } else if parent is BlockStatementSyntax || parent is GlobalStatementSyntax {
                        cuts.Add(statement.Span.End)
                    }
                }
            }
            let all = cuts.ToList()
            if all.Count <= count {
                return all
            }
            let picked = List[int32]()
            for var i = 0; i < count; i++ {
                picked.Add(all[i * all.Count / count])
            }
            return picked
        }

        private func IsInFunctionBody(tree SyntaxTree, node SyntaxNode) bool {
            var current SyntaxNode? = tree.GetParent(node)
            while current != nil {
                if current is LambdaExpressionSyntax || current is FunctionLiteralExpressionSyntax {
                    return false
                }
                if current is FunctionDeclarationSyntax {
                    return true
                }
                current = tree.GetParent(current)
            }
            return false
        }
    }
}
