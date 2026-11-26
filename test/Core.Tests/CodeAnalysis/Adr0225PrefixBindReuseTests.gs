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

    /// #6178: successive cuts in one member body of a script reuse the declarations, with the top-level
    /// statements before and after the member unchanged, and report what a bind from scratch reports.
    @Fact
    func SuccessiveCutsInAMemberOfAScript_ReuseTheDeclarations() {
        var checks = 0
        var withGlobals = 0
        var reusesWithGlobals = 0
        var scratchTicks = 0L
        var reusedTicks = 0L
        let wrong = List[string]()
        using let measurements = CompilationMeasurements.Start("test")
        for file in SampleFiles() {
            let tree = SyntaxTree.Parse(SourceText.From(File.ReadAllText(file), file))
            if !tree.Root.Members.Any((m MemberSyntax) -> m is GlobalStatementSyntax) {
                continue
            }
            let compilation = Compilation(tree)
            for remainder in[]PrefixRemainder{PrefixRemainder.KeepDeclarations, PrefixRemainder.Nothing} {
                for body in FunctionBodies(tree) {
                    var previous PrefixBindResult? = nil
                    for statement in body.Statements.Take(6) {
                        let cut = statement.Span.End
                        let options = PrefixBindOptions(remainder)
                        var watch = System.Diagnostics.Stopwatch.StartNew()
                        let scratch = compilation.BindPrefix(tree, cut, options)
                        scratchTicks += watch.ElapsedTicks
                        let reusesBefore = measurements.GetCounter("declarations.reuses")
                        watch = System.Diagnostics.Stopwatch.StartNew()
                        let reused = compilation.BindPrefix(tree, cut, options, previous)
                        reusedTicks += watch.ElapsedTicks
                        // A chained bind whose prefix keeps top-level statements is the case of #6178.
                        if previous != nil &&
                            reused.SyntaxTree.Root.Members.Any((m MemberSyntax) -> m is GlobalStatementSyntax) {
                            withGlobals++
                            if measurements.GetCounter("declarations.reuses") > reusesBefore {
                                reusesWithGlobals++
                            }
                        }
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
        let reuses = measurements.GetCounter("declarations.reuses")
        Console.WriteLine(
            "#6178 script cuts: ${checks}, declaration reuses: ${reuses}, with top-level statements ${reusesWithGlobals} of ${withGlobals}, scratch ${scratchTicks * 1000 / System.Diagnostics.Stopwatch.Frequency} ms, chained ${reusedTicks * 1000 / System.Diagnostics.Stopwatch.Frequency} ms"
        )
        Assert.True(checks > 200, "checked ${checks} cuts")
        Assert.True(wrong.Count == 0, string.Join("\n\n", wrong.Take(5)))
        // Only the cuts that keep the declarations can reuse them (ADR-0225 D6.8), and the cuts in files
        // that have no top-level statements in the prefix reuse them without #6178. Every chained cut whose prefix keeps top-level statements is the case of #6178.
        Assert.True(withGlobals > 50, "${withGlobals} chained cuts keep top-level statements")
        Assert.True(
            reusesWithGlobals > withGlobals / 2,
            "${reusesWithGlobals} declaration reuses in ${withGlobals} chained cuts that keep top-level statements"
        )
    }

    /// #6178: a script whose open body starts to suspend (ADR-0174), and a script whose globals read a type of
    /// another tree, report on chained cuts what a bind from scratch reports.
    @Theory
    @InlineData(false)
    @InlineData(true)
    func ChainedCutsOfAScriptWithSuspensionOrAnotherTree_ReportWhatABindFromScratchReports(otherTree bool) {
        let source = if otherTree {
            "package P\n\nlet e = E()\nlet value = e.Message\n\nfunc F() {\n    let a = 1\n    let b int32 = value\n    let c = 2\n    let d = 3\n}\n"
        } else {
            "package P\n\nlet ch = chan[int32](1)\nlet run = func () {\n    Work()\n}\nWork()\nlet after = 0\n\nfunc Work() {\n    let a = 1\n    ch <- a\n    let b = 2\n    let c = 3\n}\n"
        }
        let tree = SyntaxTree.Parse(SourceText.From(source, "script.gs"))
        let compilation = if otherTree {
            Compilation(
                SyntaxTree.Parse(SourceText.From("package P\n\npartial class E : System.Exception {\n}\n", "e.gs")),
                tree
            )
        } else {
            Compilation(tree)
        }
        let body = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().Last().Body!!
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

    /// #6178: cuts in the top-level statements, and a function whose return type its body infers, bind on a
    /// chain as from scratch.
    @Theory
    @InlineData(
        "package P\n\nimport System.Math\n\nlet value = Abs(1)\n\n\n\nfunc Use() {\n    let x string = value\n}\n",
        false
    )
    @InlineData(
        "package P\n\nlet m = Make()\n\nfunc Make() {\n    let a = 1\n    return object {\n        let X = 1\n    }\n}\n",
        true
    )
    @InlineData(
        "package P\n\nlet unrelated = 1\n\nfunc Make() {\n    return object {\n        let X = 1\n    }\n}\n\nfunc Use() int32 {\n    return Make().X\n}\n",
        true
    )
    func ChainedCutsOfAScriptThatLaterTextCanChange_ReportWhatABindFromScratchReports(source string, inBody bool) {
        let tree = SyntaxTree.Parse(SourceText.From(source, "script.gs"))
        let compilation = Compilation(tree)
        let cuts = List[int32]()
        if inBody {
            let make = tree
                .Root
                .DescendantNodes()
                .OfType[FunctionDeclarationSyntax]()
                .First((f FunctionDeclarationSyntax) -> f.Identifier.ValueText == "Make")
                .Body!!
            cuts.Add(make.OpenBraceToken.Span.End)
            for statement in make.Statements {
                cuts.Add(statement.Span.End)
            }
        } else {
            let start = source.IndexOf("Abs(1)", StringComparison.Ordinal) + "Abs(1)".Length
            cuts.Add(start + 1)
            cuts.Add(start + 2)
            cuts.Add(start + 3)
        }
        var previous PrefixBindResult? = nil
        for cut in cuts {
            let options = PrefixBindOptions(PrefixRemainder.KeepDeclarations)
            let scratch = compilation.BindPrefix(tree, cut, options)
            let reused = compilation.BindPrefix(tree, cut, options, previous)
            Assert.Equal(Describe(scratch), Describe(reused))
            previous = reused
        }
    }

    /// #6178: a reused global of a script points at the new prefix tree, so the semantic model of the result
    /// answers its declaration.
    @Fact
    func ReusedGlobalOfAScript_IsDeclaredInTheNewPrefixTree() {
        const source = "package P\n\nlet total = 1\nlet more = total + 1\n\nfunc F() int32 {\n    let a = total\n    let b = a + 1\n    let c = b + 1\n    return c\n}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "script.gs"))
        let compilation = Compilation(tree)
        using let measurements = CompilationMeasurements.Start("test")
        let options = PrefixBindOptions(PrefixRemainder.KeepDeclarations)
        let first = compilation.BindPrefix(tree, source.IndexOf("    let b", StringComparison.Ordinal), options)
        let second = compilation.BindPrefix(tree, source.IndexOf("    let c", StringComparison.Ordinal), options, first)
        Assert.True(measurements.GetCounter("declarations.reuses") > 0)
        let model = second.Compilation.GetSemanticModel(second.SyntaxTree)
        let declaration = second
            .SyntaxTree
            .Root
            .DescendantNodes()
            .OfType[VariableDeclarationSyntax]()
            .First((v VariableDeclarationSyntax) -> v.Identifier.ValueText == "total")
        Assert.Equal("total", model.GetDeclaredSymbol(declaration)?.Name)
        Assert.All(
            Assert.IsAssignableFrom[Symbol](model.GetDeclaredSymbol(declaration)).DeclaringSyntaxNodes,
            (n SyntaxNode) -> Assert.Same(second.SyntaxTree, n.SyntaxTree)
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

    /// The same differential check with errors in a member before the cut: the cached body of that member
    /// carries diagnostics with premises, a fixed callee and an argument typed by its candidate.
    @Fact
    func SuccessiveCuts_WithErrorsInAnotherMember_ReportWhatABindFromScratchReports() {
        const errors = `
    let local__ = func (a int32) int32 {
        return a
    }
    let fixed__ = local__(1, 2)
    let converted__ = local__("s")
    let unknown__ = noSuchFunction__(1)
    let member__ = System.Math.NoSuchMember__(1)
    let lambda__ = System.Linq.Enumerable.Range(0, 2).Select((x) -> x.NoSuchMember__)
    let operator__ = "s" * 2
`
        var checks = 0
        var withErrors = 0
        let wrong = List[string]()
        using let measurements = CompilationMeasurements.Start("test")
        for file in SampleFiles() {
            let text = MemberForm(File.ReadAllText(file))
            let plain = SyntaxTree.Parse(SourceText.From(text, file))
            let bodies = FunctionBodies(plain)
            if bodies.Count < 2 || plain.Root.Members.Any((m MemberSyntax) -> m is GlobalStatementSyntax) {
                continue
            }
            // The errors go at the start of the first body; the cuts are in the later bodies.
            let insertAt = bodies[0].OpenBraceToken.Span.End
            let mutated = text.Substring(0, insertAt) + errors + text.Substring(insertAt)
            let tree = SyntaxTree.Parse(SourceText.From(mutated, file))
            let compilation = Compilation(tree)
            for remainder in[]PrefixRemainder{PrefixRemainder.KeepDeclarations, PrefixRemainder.Nothing} {
                for body in FunctionBodies(tree).Skip(1) {
                    var previous PrefixBindResult? = nil
                    for statement in body.Statements.Take(4) {
                        let options = PrefixBindOptions(remainder)
                        let scratch = compilation.BindPrefix(tree, statement.Span.End, options)
                        let reused = compilation.BindPrefix(tree, statement.Span.End, options, previous)
                        checks++
                        if scratch.Diagnostics.Length > 5 {
                            withErrors++
                        }
                        if Describe(scratch) != Describe(reused) {
                            wrong.Add(
                                "${Path.GetFileName(file)} ${remainder} cut ${statement.Span.End}:\n${Describe(scratch)}\n---\n${Describe(reused)}"
                            )
                        }
                        previous = reused
                    }
                }
            }
        }
        Assert.True(checks > 100, "checked ${checks} cuts")
        Assert.True(withErrors > checks / 2, "${withErrors} of ${checks} cuts reported the injected errors")
        Assert.True(wrong.Count == 0, string.Join("\n\n", wrong.Take(5)))
        Assert.True(
            measurements.GetCounter("bodies.cache-hits") > checks / 4,
            "${measurements.GetCounter("bodies.cache-hits")} body reuses"
        )
    }

    /// A host that parses the text again for each cut: the previous result comes from another compilation
    /// whose tree has a shorter text. The bind reuses the declarations and binds the bodies again.
    @Fact
    func GrowingText_EachCutInANewCompilation_ReportsWhatABindFromScratchReports() {
        const source = `package P

func Helper(a int32) int32 {
    return a + 1
}

func Main() {
    let x = Helper(1)
    let y = Helper(x, 2)
    let z = noSuchName__
    let w = x + y
}
`
        let main = source.IndexOf("func Main", StringComparison.Ordinal)
        let cuts = List[int32]()
        var position = source.IndexOf('\n', main) + 1
        while true {
            let next = source.IndexOf('\n', position)
            if next < 0 || source.Substring(position, next - position).Trim() == "}" {
                break
            }
            cuts.Add(next)
            position = next + 1
        }
        Assert.Equal(4, cuts.Count)
        using let measurements = CompilationMeasurements.Start("test")
        for remainder in[]PrefixRemainder{PrefixRemainder.Nothing, PrefixRemainder.KeepDeclarations} {
            var previous PrefixBindResult? = nil
            for cut in cuts {
                let text = source.Substring(0, cut)
                let tree = SyntaxTree.Parse(SourceText.From(text, "prefix.gs"))
                let compilation = Compilation(tree)
                let options = PrefixBindOptions(remainder)
                let scratch = compilation.BindPrefix(tree, cut, options)
                let reused = compilation.BindPrefix(tree, cut, options, previous)
                Assert.Equal(Describe(scratch), Describe(reused))
                previous = reused
            }
        }
        Assert.True(
            measurements.GetCounter("declarations.reuses") >= 4,
            "${measurements.GetCounter("declarations.reuses")} reuses"
        )
    }

    /// A host that rolls a cut back binds the next candidate from the same previous result again. The
    /// second bind meets a retired compilation and binds from scratch.
    @Fact
    func SamePreviousTwice_ReportsWhatABindFromScratchReports() {
        const source = `package P

func Value(x int32) int32 {
    let y = x + 1
    let z = y + noSuchName__
    let w = z + 1
    return w
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source, "prefix.gs"))
        let compilation = Compilation(tree)
        let options = PrefixBindOptions(PrefixRemainder.KeepDeclarations)
        let previous = compilation.BindPrefix(tree, source.IndexOf("let z", StringComparison.Ordinal), options)
        for anchor in[]string{"let w", "return", "let w"} {
            let cut = source.IndexOf(anchor, StringComparison.Ordinal)
            Assert.Equal(
                Describe(compilation.BindPrefix(tree, cut, options)),
                Describe(compilation.BindPrefix(tree, cut, options, previous))
            )
        }
    }

    /// A previous result whose compilation was bound with other options is not reused: the bind reads the
    /// options of the previous prefix compilation, not of its host.
    @Fact
    func PreviousBoundWithOtherOptions_IsNotReused() {
        const source = `package P

func Value(x int32) int32 {
    let y = x + 1
    let z = y + 1
    return z
}
`
        let first = source.IndexOf("let z", StringComparison.Ordinal)
        let second = source.IndexOf("return", StringComparison.Ordinal)
        let options = PrefixBindOptions(PrefixRemainder.Nothing)
        let tree = SyntaxTree.Parse(SourceText.From(source, "prefix.gs"))
        let plain = Compilation(tree)
        let previous = plain.BindPrefix(tree, first, options)
        let documented = Compilation(tree){.WarnOnMissingDocumentation: true}
        using let measurements = CompilationMeasurements.Start("test")
        let other = documented.BindPrefix(tree, second, options, previous)
        Assert.Equal(0L, measurements.GetCounter("declarations.reuses"))
        Assert.Equal(Describe(documented.BindPrefix(tree, second, options)), Describe(other))
        // The same options reuse it.
        plain.BindPrefix(tree, second, options, previous)
        Assert.Equal(1L, measurements.GetCounter("declarations.reuses"))
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
