// <copyright file="Adr0225PrefixBindReuseTests.cs" company="GSharp">
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

/// ADR-0225 D6.6 (#6079): a prefix bind that gets the result of the previous cut reuses its declarations
/// and the bodies that did not change, and reports what a bind from scratch reports.
open class Adr0225PrefixBindReuseTests {
    /// Differential check: at successive statement boundaries of the function bodies of each sample, in
    /// both modes, the bind that reuses the previous result reports the same classified diagnostics,
    /// scope and open constructs as a bind from scratch. The counters show that it reused declarations
    /// and bodies.
    @Fact
    func SuccessiveCuts_ReportWhatABindFromScratchReports() {
        var checks = 0
        let wrong = List[string]()
        using let measurements = CompilationMeasurements.Start("test")
        for file in SampleFiles() {
            let tree = SyntaxTree.Parse(SourceText.From(MemberForm(File.ReadAllText(file)), file))
            if tree.Root.Members.Any((m MemberSyntax) -> m is GlobalStatementSyntax) {
                continue
            }
            let compilation = Compilation(tree)
            for remainder in[]PrefixRemainder{PrefixRemainder.KeepDeclarations, PrefixRemainder.Nothing} {
                for body in FunctionBodies(tree) {
                    var previous PrefixBindResult? = nil
                    for statement in body.Statements.Take(6) {
                        let cut = statement.Span.End
                        let options = PrefixBindOptions(remainder)
                        let scratch = compilation.BindPrefix(tree, cut, options)
                        let reused = compilation.BindPrefix(tree, cut, options, previous)
                        checks++
                        if Describe(scratch) != Describe(reused) {
                            wrong.Add(
                                "${Path.GetFileName(file)} ${remainder} cut ${cut}:\n${Describe(scratch)}\n---\n${Describe(reused)}"
                            )
                        }
                        previous = reused
                    }
                }
            }
        }
        Assert.True(checks > 1000, "checked ${checks} cuts")
        Assert.True(wrong.Count == 0, string.Join("\n\n", wrong.Take(5)))
        Assert.True(
            measurements.GetCounter("declarations.reuses") > checks / 2,
            "${measurements.GetCounter("declarations.reuses")} declaration reuses in ${checks} cuts"
        )
        Assert.True(
            measurements.GetCounter("bodies.cache-hits") > checks / 2,
            "${measurements.GetCounter("bodies.cache-hits")} body reuses in ${checks} cuts"
        )
    }

    /// A body that the open body makes suspending (ADR-0174) is reported as from scratch: the closed
    /// caller's report changes when the open body gets a channel operation.
    @Fact
    func OpenBodyThatStartsToSuspend_ReportsLikeABindFromScratch() {
        const source = `package P

func Caller() int32 {
    let x = Work()
    return x
}

func Work() int32 {
    let ch = chan[int32](1)
    let a = 1
    ch <- a
    let b = <-ch
    return b
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "prefix.gs"))
        let compilation = Compilation(tree)
        let work = tree
            .Root
            .Members
            .OfType[FunctionDeclarationSyntax]()
            .Single((f FunctionDeclarationSyntax) -> f.Identifier.Text == "Work")
        let body = Assert.IsType[BlockStatementSyntax](work.Body)
        for remainder in[]PrefixRemainder{PrefixRemainder.KeepDeclarations, PrefixRemainder.Nothing} {
            var previous PrefixBindResult? = nil
            for statement in body.Statements {
                let options = PrefixBindOptions(remainder)
                let scratch = compilation.BindPrefix(tree, statement.Span.End, options)
                let reused = compilation.BindPrefix(tree, statement.Span.End, options, previous)
                Assert.Equal(Describe(scratch), Describe(reused))
                previous = reused
            }
        }
    }

    @Fact
    func ResultOfAnotherMode_IsNotReused() {
        const source = `package P

func Value(x int32) int32 {
    let y = x + 1
    let z = y + 1
    return z
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "prefix.gs"))
        let compilation = Compilation(tree)
        let first = source.IndexOf("let z", StringComparison.Ordinal)
        let second = source.IndexOf("return", StringComparison.Ordinal)
        let previous = compilation.BindPrefix(tree, first, PrefixBindOptions(PrefixRemainder.Nothing))
        using let measurements = CompilationMeasurements.Start("test")
        let other = compilation.BindPrefix(tree, second, PrefixBindOptions(PrefixRemainder.KeepDeclarations), previous)
        Assert.Equal(0L, measurements.GetCounter("declarations.reuses"))
        Assert.Equal(
            Describe(compilation.BindPrefix(tree, second, PrefixBindOptions(PrefixRemainder.KeepDeclarations))),
            Describe(other)
        )
        let same = compilation.BindPrefix(tree, second, PrefixBindOptions(PrefixRemainder.Nothing), previous)
        Assert.Equal(1L, measurements.GetCounter("declarations.reuses"))
        Assert.Equal(
            Describe(compilation.BindPrefix(tree, second, PrefixBindOptions(PrefixRemainder.Nothing))),
            Describe(same)
        )
    }

    shared {
        private func Describe(result PrefixBindResult) string {
            let diagnostics = string.Join(
                "\n",
                result.Diagnostics.Select((d ClassifiedDiagnostic) -> "${d} @${d.Diagnostic.Location.Span}")
            )
            let names = string.Join(
                ",",
                result.Scope.Select((s Symbol) -> s.Name).OrderBy((n string) -> n, StringComparer.Ordinal)
            )
            let constructs = string.Join(
                ",",
                result.OpenConstructs.Select(
                    (o OpenConstruct) -> "${o.Kind}:${o.Symbol?.Name ?? ""}:${o.ExpectedType?.Name ?? ""}"
                )
            )
            return "${diagnostics}\n[${names}]\n[${constructs}]"
        }

        // The function bodies with at least three statements, at most three for each file.
        private func FunctionBodies(tree SyntaxTree) List[BlockStatementSyntax] {
            let bodies = List[BlockStatementSyntax]()
            let pending = Stack[SyntaxNode]()
            pending.Push(tree.Root)
            while pending.Count > 0 {
                let node = pending.Pop()
                if node is FunctionDeclarationSyntax{Body: BlockStatementSyntax body} && body.Statements.Length >= 3 {
                    bodies.Add(body)
                }
                for child in node.GetChildren() {
                    pending.Push(child)
                }
            }
            return bodies.OrderBy((b BlockStatementSyntax) -> b.Span.Start).Take(3).ToList()
        }

        // The top-level statements of a sample moved into a function, so that the file has member
        // bodies only. A file whose statements are not one block stays as it is.
        private func MemberForm(text string) string {
            let tree = SyntaxTree.Parse(SourceText.From(text, "sample.gs"))
            let globals = tree.Root.Members.OfType[GlobalStatementSyntax]().ToList()
            if globals.Count == 0 {
                return text
            }
            let start = globals[0].Span.Start
            let end = globals[globals.Count - 1].Span.End
            for member in tree.Root.Members {
                if !(member is GlobalStatementSyntax) && member.Span.Start > start && member.Span.Start < end {
                    return text
                }
            }
            return text.Substring(0, start) + "func Main__() {\n" + text.Substring(start, end - start) +
                "\n}\n" +
                text.Substring(end)
        }

        private func SampleFiles() List[string] {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            Assert.NotNull(directory)
            return Directory
                .GetFiles(Path.Combine(directory!!.FullName, "samples"), "*.gs", SearchOption.AllDirectories)
                .OrderBy((f string) -> f, StringComparer.Ordinal)
                .ToList()
        }
    }
}
