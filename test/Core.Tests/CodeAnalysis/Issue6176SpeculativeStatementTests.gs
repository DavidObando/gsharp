// <copyright file="Issue6176SpeculativeStatementTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #6176 (ADR-0229): `SemanticModel.GetSpeculativeStatementDiagnostics` binds a statement as if
/// it stood at a position, and answers what a bind of the text with the statement inserted answers.
open class Issue6176SpeculativeStatementTests {
    @Fact
    func SamplePrefixes_SpeculativeStatementsMatchTheBindOfTheInsertedText() {
        var checkedStatements = 0
        var reported = 0
        let wrong = List[string]()
        for file in SampleFiles().Take(60) {
            let text = File.ReadAllText(file)
            let tree = SyntaxTree.Parse(SourceText.From(text, file))
            let compilation = Compilation(tree)
            for cut in BodyStatementEnds(tree, 2) {
                for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
                    let options = PrefixBindOptions(remainder, includeScope: false)
                    let prefix = compilation.BindPrefix(tree, cut, options)
                    let model = prefix.Compilation.GetSemanticModel(prefix.SyntaxTree)
                    for statement in Statements {
                        checkedStatements++
                        let result = model.GetSpeculativeStatementDiagnostics(
                            cut,
                            SyntaxTree.ParseStatement(statement)!!
                        )
                        // The oracle: the text with the statement inserted, bound from scratch.
                        let inserted = "\n" + statement + "\n"
                        let insertedText = SourceText.From(
                            text.Substring(0, cut) + inserted + text.Substring(cut),
                            file
                        )
                        let insertedTree = SyntaxTree.Parse(insertedText)
                        let expected = Compilation(insertedTree)
                            .BindPrefix(insertedTree, cut + inserted.Length, options)
                            .Diagnostics
                            .Where(
                            (d ClassifiedDiagnostic) -> d.Diagnostic.Location.Span.Start > cut &&
                                d.Diagnostic.Location.Span.End <= cut +
                                inserted.Length
                        )
                            .Select(Describe)
                            .ToList()
                        let actual = result.Diagnostics.Select(Describe).ToList()
                        reported += actual.Count
                        Assert.Equal(TextSpan(cut + 1, statement.Length), result.StatementSpan)
                        if !expected.SequenceEqual(actual) {
                            wrong.Add(
                                "${Path.GetFileName(file)} cut ${cut} ${remainder} '${statement}': expected [${string.Join("; ", expected)}], got [${string.Join("; ", actual)}]"
                            )
                        }
                    }
                }
            }
        }
        Assert.True(checkedStatements > 500, "checked ${checkedStatements} statements")
        Assert.True(reported > 200, "${reported} diagnostics")
        Assert.True(wrong.Count == 0, string.Join("\n", wrong.Take(20)))
    }

    @Fact
    func SpeculativeStatement_ClassifiesAsThePrefixBindDoes() {
        const source = "package P\n\nfunc Main() {\n    let a = 1\n/*CUT*/\n}\n"
        let nothing = Speculate(source, PrefixRemainder.Nothing, "let b = missing__(a)")
        let unknown = Assert.Single(nothing.Diagnostics)
        Assert.Equal("GS0130", unknown.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.FutureDependent, unknown.Finality)
        Assert.Equal("later-declaration", unknown.Reason)
        // Every later declaration is kept, and a statement of the open member cannot declare a function.
        let keep = Speculate(source, PrefixRemainder.KeepDeclarations, "let b = missing__(a)")
        Assert.Equal(DiagnosticFinality.Final, Assert.Single(keep.Diagnostics).Finality)
    }

    @Fact
    func SpeculativeStatement_AnswersTheLocalsThatItDeclares() {
        const source = "package P\n\nfunc Main() {\n    let a = 1\n/*CUT*/\n}\n"
        let result = Speculate(source, PrefixRemainder.Nothing, "let (b, c) = (a + 1, \"s\")")
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            []string{"b int32", "c string"},
            result
                .DeclaredSymbols
                .Select((s Symbol) -> "${s.Name} ${cast[VariableSymbol](s).Type}")
                .OrderBy((s string) -> s, StringComparer.Ordinal)
                .ToArray()
        )
        // The statement sees the locals before the position, so it declares nothing else.
        Assert.DoesNotContain(result.DeclaredSymbols, (s Symbol) -> s.Name == "a")
    }

    @Fact
    func SpeculativeStatement_SeesTheFlowStateAtThePosition() {
        // GetSpeculativeTypeInfo starts with empty narrowing. A statement is bound in its body, so a
        // null check before it narrows `p`.
        const source = "package P\n\nfunc F(p string?) {\n    if p != nil {\n        let a = 1\n/*CUT*/\n    }\n}\n"
        let result = Speculate(source, PrefixRemainder.KeepDeclarations, "let n int32 = p.Length")
        Assert.Empty(result.Diagnostics)
        let outside = Speculate(
            "package P\n\nfunc F(p string?) {\n    let a = 1\n/*CUT*/\n}\n",
            PrefixRemainder.KeepDeclarations,
            "let n int32 = p.Length"
        )
        Assert.NotEmpty(outside.Diagnostics)
    }

    @Fact
    func SpeculativeStatementInACompleteTree_IsFinalAndChangesNothing() {
        const source = "package P\n\nfunc Main() {\n    let a = 1\n    let b = a\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "complete.gs"))
        let compilation = Compilation(tree)
        let before = compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray()
        let model = compilation.GetSemanticModel(tree)
        let position = source.IndexOf("    let b", StringComparison.Ordinal) - 1
        let result = model.GetSpeculativeStatementDiagnostics(
            position,
            SyntaxTree.ParseStatement("let c int32 = \"s\"")!!
        )
        let mismatch = Assert.Single(result.Diagnostics)
        Assert.Equal("GS0155", mismatch.Diagnostic.Id)
        Assert.Equal(DiagnosticFinality.Final, mismatch.Finality)
        Assert.Equal("c", Assert.Single(result.DeclaredSymbols).Name)
        Assert.Equal(before, compilation.GetDiagnostics().Select((d Diagnostic) -> d.ToString()).ToArray())
        Assert.Same(tree, model.SyntaxTree)
    }

    @Fact
    func SpeculativeStatement_RejectsAPositionAfterTheCut() {
        const source = "package P\n\nfunc Main() {\n    let a = 1\n/*CUT*/\n}\n"
        let cut = source.IndexOf("/*CUT*/", StringComparison.Ordinal)
        let tree = SyntaxTree.Parse(SourceText.From(source.Replace("/*CUT*/", string.Empty), "prefix.gs"))
        let prefix = Compilation(tree).BindPrefix(tree, cut, PrefixBindOptions(PrefixRemainder.Nothing))
        let model = prefix.Compilation.GetSemanticModel(prefix.SyntaxTree)
        Assert.Throws[ArgumentOutOfRangeException](
            () -> model.GetSpeculativeStatementDiagnostics(cut + 1, SyntaxTree.ParseStatement("let b = 1")!!)
        )
    }

    shared {
        private let Statements[]string = []string{
            "let probe__ int32 = \"s\"",
            "missing__(1)",
            "let fine__ = 1",
            "let probeCall__ string = System.Math.Abs(1)"
        }

        private func Speculate(source string, remainder PrefixRemainder, statement string) SpeculativeStatementResult {
            let cut = source.IndexOf("/*CUT*/", StringComparison.Ordinal)
            Assert.True(cut >= 0)
            let tree = SyntaxTree.Parse(SourceText.From(source.Replace("/*CUT*/", string.Empty), "prefix.gs"))
            let prefix = Compilation(tree).BindPrefix(tree, cut, PrefixBindOptions(remainder))
            let model = prefix.Compilation.GetSemanticModel(prefix.SyntaxTree)
            return model.GetSpeculativeStatementDiagnostics(cut, SyntaxTree.ParseStatement(statement)!!)
        }

        private func Describe(
            d ClassifiedDiagnostic
        ) string -> "${d.Diagnostic.Id}@${d.Diagnostic.Location.Span.Start}:${d.Diagnostic.Location.Span.Length} ${d.Finality} ${d.Reason}"

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

        // The ends of up to [`count`](paramref) statements of function bodies, outside function literals.
        private func BodyStatementEnds(tree SyntaxTree, count int32) List[int32] {
            let cuts = SortedSet[int32]()
            let pending = Stack[SyntaxNode]()
            pending.Push(tree.Root)
            while pending.Count > 0 {
                let node = pending.Pop()
                for child in node.GetChildren() {
                    pending.Push(child)
                }
                if node is StatementSyntax statement && tree.GetParent(node) is BlockStatementSyntax block &&
                    block.OpenBraceToken.Span.Length > 0 &&
                    InFunction(tree, node) {
                    cuts.Add(statement.Span.End)
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

        private func InFunction(tree SyntaxTree, node SyntaxNode) bool {
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
