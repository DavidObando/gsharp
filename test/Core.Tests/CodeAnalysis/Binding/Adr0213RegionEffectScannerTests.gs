// <copyright file="Adr0213RegionEffectScannerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Generic
import System.Linq
import Xunit

/// ADR-0213 section 20, slice L0: the region walker. Each row of the contract table below is one
/// syntax shape and the record that rule W1 to W8 gives it. The walker reads syntax only, so the
/// sources are parsed and not bound. The rows that carry the probe name of the ADR tie a rule to the
/// corpus probe that the later slices pin with a run.
open class Adr0213RegionEffectScannerTests {
    /// The contract table. A row is `rule`, `probe`, the loop statements, and the record
    /// (`RegionEffects.ToString`) that the first loop of the source must have.
    @Theory
    @MemberData("Rows")
    func EveryRow_GivesItsRecord(rule string, probe string, loop string, expected string) {
        let effects = Scan(loop)
        Assert.True(expected == effects.ToString(), "${rule} ${probe}: expected ${expected} but found ${effects}")
    }

    /// The table must keep at least one row for every rule of section 7.
    @Fact
    func Table_HasARowForEveryRule() {
        let rules = Rows().Select((row[]object) -> cast[string](row[0])).Distinct().ToArray()
        for rule in[]string{"W1", "W2", "W3", "W4", "W5", "W7", "W8", "T"} {
            Assert.Contains(rule, rules)
        }
    }

    // ----------------------------------------------------------------- W1

    @Fact
    func W1_ARegionLocalDeclarationDoesNotKillTheOuterVariable() {
        // Probe e16 and q4: the `let s` of the body shadows the outer `s`.
        let effects = Scan("while c {\nlet s string? = Get()\nif s == nil { continue }\n}")
        Assert.Empty(effects.Writes)
    }

    @Fact
    func W1_ADeclarationInAnEarlierSiblingScopeDoesNotHideALaterWrite() {
        // A declaration form that does not enclose the write declares nothing for it.
        let effects = Scan("while c {\n{ var s = 1 }\ns = nil\n}")
        Assert.Equal(1, effects.Writes.Count)
        Assert.Equal("s", effects.Writes[0].Name)
    }

    // ----------------------------------------------------------------- W2

    @Fact
    func W2_AWriteBeforeAnExitStillCounts() {
        // Probe e2b: `s = nil; break` is a write of the region.
        let effects = Scan("while c { if c2 {\ns = nil\nbreak\n} }")
        let write = Assert.Single(effects.Writes)
        Assert.Equal("s", write.Name)
        Assert.True(write.FollowedByExit)
    }

    @Fact
    func W2_AWriteWithoutAnExitIsNotOnTheExitPath() {
        let effects = Scan("while c { s = nil }")
        Assert.False(Assert.Single(effects.Writes).FollowedByExit)
    }

    // ----------------------------------------------------------------- W3

    @Fact
    func W3_AByReferenceCallReportsTheNamesPerCall() {
        let effects = Scan("while c { Run(ref a, b, ref a) }")
        let call = Assert.Single(effects.Calls)
        Assert.Equal(RegionCallKind.NamedInvocation, call.Kind)
        Assert.Equal("Run", call.CalleeName)
        Assert.Equal([]string{"a", "a"}, call.ByReferenceNames.ToArray())
        Assert.Equal([]string{"b"}, call.ByValueNames.ToArray())
        Assert.All(effects.Writes, (write RegionWrite) -> Assert.True(write.ViaCallArgument))
    }

    @Fact
    func W3_ANonNameOperandIsUnresolved() {
        let effects = Scan("while c { Run(ref xs[0]) }")
        Assert.True(Assert.Single(effects.Calls).HasUnresolvedOperand)
        Assert.True(effects.ContainsMemberWrite)
        Assert.False(effects.ContainsPointerWrite)
        let storage = Scan("while c { Run(ref obj.Field) }")
        Assert.True(storage.ContainsPointerWrite)
    }

    @Fact
    func W3_AMemberCallIsNotANamedInvocation() {
        let effects = Scan("while c { list.TryGetValue(key, out found) }")
        let call = Assert.Single(effects.Calls)
        Assert.Equal(RegionCallKind.MemberInvocation, call.Kind)
        // The member and a plain receiver let the consumer tell a function value from a method.
        Assert.Equal("TryGetValue", call.CalleeName)
        Assert.Equal("list", call.ReceiverName)
        Assert.Equal([]string{"list", "key"}, call.ByValueNames.ToArray())
        Assert.Equal([]string{"found"}, call.ByReferenceNames.ToArray())
    }

    // ----------------------------------------------------------------- W5

    @Fact
    func W5_EveryMemberAndIndexReadIsCounted() {
        let effects = Scan("while c { total = total + a.b.Length + xs[0] }")
        // `a.b` and `a.b.Length` are two member reads, `xs[0]` is the third.
        Assert.Equal(3, effects.MemberReadCount)
        Assert.True(effects.ContainsMemberRead)
    }

    @Fact
    func W5_AMethodCallIsNotAMemberRead() {
        let effects = Scan("while c { a.Run() }")
        Assert.Equal(0, effects.MemberReadCount)
        Assert.True(effects.ContainsCall)
    }

    // ----------------------------------------------------------------- W6

    @Fact
    func W6_ASyntaxKindThatTheTableDoesNotListIsUnknown() {
        Assert.Equal(RegionEffectClass.Unknown, RegionEffectKindTable.Classify(cast[SyntaxKind](9999)))
    }

    @Fact
    func W6_ANodeOfAnUnlistedKindMarksTheRecordUnknown() {
        // A region with such a node loses every fact (the consumer rule empties the entry state).
        let tree = SyntaxTree.Parse(Wrap("while c { }"))
        let effects = RegionEffectScanner().ScanStatements([]SyntaxNode{UnlistedKindSyntax(tree)})
        Assert.True(effects.ContainsUnknownKind)
        Assert.Equal("flags=[unknown-kind] writes=[]", effects.ToString())
    }

    @Fact
    func W6_EverySyntaxKindIsListed() {
        // The enumeration test: a new kind fails until someone decides its effect.
        let unlisted = List[string]()
        var listed = 0
        for kind in Enum.GetValues[SyntaxKind]() {
            if RegionEffectKindTable.IsListed(kind) {
                listed++
            } else {
                unlisted.Add(kind.ToString())
            }
        }
        Assert.True(listed > 100, "the enumeration must reach the node kinds, it listed ${listed}")
        Assert.True(
            unlisted.Count == 0,
            "SyntaxKind values the walker does not classify: ${string.Join(",", unlisted)}"
        )
    }

    @Fact
    func W6_EveryListedKindIsASyntaxKind() {
        let names = Enum.GetNames[SyntaxKind]().ToHashSet()
        for name in RegionEffectKindTable.ListedKindNames() {
            Assert.Contains(name, names)
        }
    }

    // ----------------------------------------------------------------- W7

    @Fact
    func W7_ANestedLoopWalkIsReusedByTheEnclosingLoop() {
        let tree = SyntaxTree.Parse(Wrap("while c { while c2 { s = nil } }"))
        let outer = FirstLoop(tree.Root)
        let inner = Loops(outer).Skip(1).First()
        // The inner loop is bound after the outer one, so the walk of the outer loop caches the inner one.
        let scanner = RegionEffectScanner()
        let outerEffects = scanner.ScanLoop(outer)
        let visitedForOuter = scanner.NodesVisited
        let innerEffects = scanner.ScanLoop(inner)
        Assert.Equal(visitedForOuter, scanner.NodesVisited)
        Assert.Equal(2, scanner.Regions)
        Assert.Equal([]string{"s"}, outerEffects.Writes.Select((w RegionWrite) -> w.Name).ToArray())
        Assert.Equal([]string{"s"}, innerEffects.Writes.Select((w RegionWrite) -> w.Name).ToArray())
        // A nested loop that runs part of itself once (a `for` initializer) is walked for each context.
        let second = RegionEffectScanner()
        second.ScanLoop(outer)
        Assert.Equal(visitedForOuter, second.NodesVisited)
    }

    @Fact
    func W3_ARefLocalOperandIsTheStorageItNames() {
        // `c` names the storage of `b`, so the call passes one storage twice.
        let effects = Scan("while c {\nlet ref c = b\nClear2(ref b, ref c)\n}")
        let call = Assert.Single(effects.Calls)
        Assert.Equal([]string{"b", "b"}, call.ByReferenceNames.ToArray())
    }

    @Fact
    func W2_ACachedRecordKeepsItsOwnExitAnnotation() {
        // The enclosing `break` marks the copy in the outer record, not the cached record of the inner loop.
        let tree = SyntaxTree.Parse(Wrap("while c {\nwhile c2 { s = nil }\nbreak\n}"))
        let outer = FirstLoop(tree.Root)
        let inner = Loops(outer).Skip(1).First()
        let scanner = RegionEffectScanner()
        let outerEffects = scanner.ScanLoop(outer)
        Assert.True(Assert.Single(outerEffects.Writes).FollowedByExit)
        Assert.False(Assert.Single(scanner.ScanLoop(inner).Writes).FollowedByExit)
    }

    @Fact
    func P7_ACallableDeclaredInTheRegionIsNoConstruction() {
        let shadowed = Scan("while c {\nlet Dog = func() { }\ns = Dog()\n}")
        Assert.Equal(RegionWriteProof.None, Assert.Single(shadowed.Writes).Proof)
        let plain = Scan("while c { s = Dog() }")
        Assert.Equal(RegionWriteProof.Construction, Assert.Single(plain.Writes).Proof)
    }

    // ----------------------------------------------------------------- spans

    @Fact
    func Span_StartsAtTheEarliestBackwardTargetAndEndsAtItsGoto() {
        // Probe q2.
        let span = Span(`func Run(n int32) int32 {
    var i = 0
    var s string? = Get()
    if s == nil { return 0 }
    Again: i = i + s!!.Length
    s = nil
    if i < n { s = Get(); goto Again }
    return i
}`)
        Assert.NotNull(span)
        let found = span!!
        Assert.Equal([]string{"Again"}, found.Labels.ToArray())
        Assert.Equal(1, found.GotoCount)
        Assert.Equal(3, found.FirstIndex)
        Assert.Equal(5, found.LastIndex)
    }

    @Fact
    func Span_AForwardOnlyGotoHasNoSpan() {
        let span = Span(`func Run(skip bool) int32 {
    if skip { goto Done }
    Done: return 1
}`)
        Assert.Null(span)
    }

    @Fact
    func Span_AGotoAfterAnUnconditionalExitIsNotAParticipant() {
        // Rule J8: the jump is at an unreachable point.
        let span = Span(`func Run(n int32) int32 {
    Again: n = n + 1
    return n
    goto Again
}`)
        Assert.Null(span)
    }

    @Fact
    func Span_AJumpThroughANonCompletingFinallyIsNotAParticipant() {
        // Probe d6: the label is outside the try, and the finally cannot complete.
        let span = Span(`func Run(n int32) int32 {
    Enter: n = n + 1
    try {
        if n < 3 { goto Enter }
    } finally {
        return 4
    }
    return n
}`)
        Assert.Null(span)
    }

    @Fact
    func Span_AJumpInsideTheSameTryIsAParticipant() {
        // Probe q10: the label is inside the try, so the finally does not run on the jump.
        let span = Span(`func Run(n int32) int32 {
    var i = 0
    try {
        Again: i = i + 1
        if i < n { goto Again }
    } finally {
        return i
    }
}`)
        Assert.NotNull(span)
        let found = span!!
        Assert.Equal([]string{"Again"}, found.Labels.ToArray())
    }

    @Fact
    func Span_CoversEveryLabelBetweenTheTargetAndTheLastGoto() {
        // Probe c3b: a write returns to the first label through the second.
        let span = Span(`func Run(a bool, b bool) int32 {
    var n = 0
    First: n = n + 1
    if a { goto Second }
    Second: n = n + 2
    if b { goto First }
    return n
}`)
        Assert.NotNull(span)
        let found = span!!
        Assert.Equal([]string{"First", "Second"}, found.Labels.ToArray())
        Assert.Equal(1, found.FirstIndex)
        Assert.Equal(4, found.LastIndex)
    }

    @Fact
    func Span_AGotoInATrailingBlockOfABlockExpressionHasAValidAncestry() {
        // The trailing expression follows the statements of its block, so the label and the goto share a list.
        let span = Span(`func Run(n int32) int32 {
    let v = {
        Again: n = n + 1
        {
            if n < 3 { goto Again }
            n
        }
    }
    return v
}`)
        let found = span!!
        Assert.Equal([]string{"Again"}, found.Labels.ToArray())
        // The span covers the statement and the trailing expression that holds the goto.
        Assert.Equal(2, found.Statements().Length)
    }

    @Fact
    func Span_ATailOnlySpanHasAFirstNodeAndItsLabels() {
        // No prefix statement: the label and the goto sit in the nested tail block, whose list is the lowest shared one.
        let span = Span(`func Run(n int32) int32 {
    let v = {
        {
            Again: n = n + 1
            if n < 3 { goto Again }
            n
        }
    }
    return v
}`)
        let found = span!!
        Assert.Equal([]string{"Again"}, found.Labels.ToArray())
        Assert.Equal(2, found.Statements().Length)
        Assert.NotNull(found.FirstStatement)
    }

    @Fact
    func Span_ALabeledExitEndsThePath() {
        // `Again: return 0` cannot complete, so the goto after it is at an unreachable point.
        let span = Span(`func Run(n int32) int32 {
    Again: return 0
    goto Again
}`)
        Assert.Null(span)
    }

    @Fact
    func Span_ALabeledExitAtTheEndOfAFinallyCannotComplete() {
        let span = Span(`func Run(n int32) int32 {
    Enter: n = n + 1
    try {
        if n < 3 { goto Enter }
    } finally {
        Out: return 4
    }
    return n
}`)
        Assert.Null(span)
    }

    @Fact
    func Span_IsComputedForABlockBodyOfAFunctionLiteral() {
        let span = Span(`func Run(n int32) int32 {
    let f = func() int32 {
        var i = 0
        Again: i = i + 1
        if i < n { goto Again }
        return i
    }
    return f()
}`)
        // The label belongs to the function literal, which has its own spans (section 11).
        Assert.Null(span)
    }

    // ----------------------------------------------------------------- helpers

    shared {
        // The contract table: rule, probe, the loop, the record.
        private func Rows() IEnumerable[[]object] {
            let rows = List[[]object]()
            let Add = func (rule string, probe string, loop string, expected string) {
                rows.Add([]object{rule, probe, loop, expected})
            }
            // W1: scope-aware names.
            Add("W1", "e16", "while c {\nvar s = \"a\"\ns = \"b\"\n}", "flags=[] writes=[]")
            Add(
                "W1",
                "q4",
                "while c {\nlet s string? = Get()\nif s == nil { continue }\n}",
                "flags=[call,operator] writes=[]"
            )
            Add("W1", "unrecognised", "while c {\n{ var s = 1 }\ns = nil\n}", "flags=[] writes=[s]")
            Add(
                "W1",
                "nested-for-variable",
                "while c { for var j = 0; j < 3; j++ { j = 1 } }",
                "flags=[operator] writes=[]"
            )
            Add("W1", "if-let", "while c { if let t = s { t = \"x\" } }", "flags=[] writes=[]")
            Add(
                "W1",
                "closure-parameter",
                "while c { let f = func(s string) { s = \"x\" } }",
                "flags=[closure] writes=[]"
            )
            Add(
                "W1",
                "catch-variable",
                "while c { try { } catch (e Exception) { e = nil } }",
                "flags=[handler] writes=[]"
            )
            Add("W1", "range-element", "while c { for x in xs { x = 1 } }", "flags=[call,iteration] writes=[]")
            Add("W1", "pattern-variable", "while c { if v is Dog d { d = nil } }", "flags=[] writes=[]")
            Add("W1", "out-var", "while c {\nTryGet(out var t)\nt = nil\n}", "flags=[call] writes=[]")
            Add("W1", "plain-write", "while c { s = nil }", "flags=[] writes=[s]")
            Add("W1", "increment", "while c { n++ }", "flags=[operator] writes=[n]")
            Add("W1", "compound", "while c { s += \"a\" }", "flags=[operator] writes=[s]")
            Add("W1", "coalescing", "while c { s ??= \"a\" }", "flags=[] writes=[s]")
            Add("W1", "multi-assign", "while c { a, b = b, a }", "flags=[] writes=[a,b]")
            // W2: every write counts, whatever follows it.
            Add("W2", "e2b", "while c { if c2 {\ns = nil\nbreak\n} }", "flags=[] writes=[s]")
            Add("W2", "return", "while c {\ns = nil\nreturn\n}", "flags=[] writes=[s]")
            // W3: writes through aliases.
            Add("W3", "ref", "while c { Run(ref s) }", "flags=[call,alias-take,ref-arg] writes=[s]")
            Add("W3", "out", "while c { TryGet(out s) }", "flags=[call,alias-take,ref-arg] writes=[s]")
            Add("W3", "address-of", "while c { let p = &s }", "flags=[alias-take] writes=[s]")
            Add("W3", "ref-local", "while c {\nlet ref a = s\na = nil\n}", "flags=[alias-take] writes=[s]")
            Add(
                "W3",
                "element-address",
                "while c { Run(ref xs[0]) }",
                "flags=[call,member-write,member-read,alias-take,ref-arg] writes=[]"
            )
            Add("W3", "member-write", "while c { x.F = 1 }", "flags=[call,member-write] writes=[]")
            Add("W3", "index-write", "while c { xs[0] = 1 }", "flags=[call,member-write] writes=[]")
            Add("W3", "pointer-write", "while c { *p = 1 }", "flags=[member-write,pointer-write] writes=[]")
            // W4: any call is a call.
            Add("W4", "invocation", "while c { Work() }", "flags=[call] writes=[]")
            Add("W4", "member-call", "while c { x.Run() }", "flags=[call] writes=[]")
            Add("W4", "construction", "while c { let d = Dog{} }", "flags=[call] writes=[]")
            Add("W4", "defer", "while c { defer Close() }", "flags=[call] writes=[]")
            Add("W4", "interpolation", "while c { let t = \"" + "$" + "{s}\" }", "flags=[call] writes=[]")
            Add("W4", "go", "while c { go Work() }", "flags=[call,suspension] writes=[]")
            Add("W4", "using", "while c { using let r = Open() }", "flags=[call] writes=[]")
            Add("W4", "operator", "while c { let t = a + b }", "flags=[operator] writes=[]")
            Add(
                "W4",
                "operator-with-literal-operand-is-a-candidate",
                "while c { let t = a + 1 }",
                "flags=[operator] writes=[]"
            )
            // W5: member and index reads.
            Add(
                "W5",
                "member-read",
                "while c { total = total + x.Length }",
                "flags=[member-read,operator] writes=[total]"
            )
            Add("W5", "index-read", "while c { total = xs[0] }", "flags=[member-read] writes=[total]")
            // W7: nested regions and closures.
            Add("W7", "nested-loop", "while c { while c2 { s = nil } }", "flags=[] writes=[s]")
            Add("W7", "closure-write", "while c { let f = func() { s = nil } }", "flags=[closure] writes=[s]")
            Add(
                "W7",
                "closure-body-is-not-the-region",
                "while c { let f = func() {\nWork()\nx.F = 1\ny.Z()\n} }",
                "flags=[closure] writes=[]"
            )
            Add(
                "W7",
                "closure-bound-to-a-name",
                "while c { let Local = func() { s = nil } }",
                "flags=[closure] writes=[s]"
            )
            // W8: a catch clause in the region.
            Add("W8", "catch", "while c { try { } catch (e Exception) { } }", "flags=[handler] writes=[]")
            Add(
                "W8",
                "catch-with-write",
                "while c { try { } catch (e Exception) { s = nil } }",
                "flags=[handler] writes=[s]"
            )
            // Table 9: the region of each loop kind.
            Add("T", "T3-initializer-is-outside", "for s = nil; c; c2 = true { }", "flags=[] writes=[c2]")
            Add("T", "T3-post-and-condition", "for var i = 0; i < n; i++ { i = 5 }", "flags=[operator] writes=[i]")
            Add("T", "T5-iteration", "for x in xs { }", "flags=[call,iteration] writes=[]")
            Add("T", "T6-do-while", "do { s = nil } while c", "flags=[] writes=[s]")
            Add("T", "T2-while-let", "while let t = Next() { s = nil }", "flags=[call] writes=[s]")
            Add("T", "T4-infinite", "for {\ns = nil\nbreak\n}", "flags=[] writes=[s]")
            Add(
                "W7",
                "handler-in-a-closure",
                "while c { let f = func() { try { } catch (e Exception) { } } }",
                "flags=[closure] writes=[]"
            )
            Add(
                "W7",
                "loop-in-a-closure",
                "while c { let f = func() { while c2 { Work() } } }",
                "flags=[closure] writes=[]"
            )
            Add(
                "W7",
                "write-in-a-loop-in-a-closure",
                "while c { let f = func() { while c2 { s = nil } } }",
                "flags=[closure] writes=[s]"
            )
            Add(
                "W3",
                "ref-local-in-a-nested-loop",
                "while c {\nlet ref a = s\nwhile c2 { a = nil }\n}",
                "flags=[alias-take] writes=[s]"
            )
            Add(
                "W3",
                "ref-local-names-the-outer-variable",
                "while c {\nlet ref a = s\n{\nvar s = \"local\"\na = nil\n}\n}",
                "flags=[alias-take] writes=[s]"
            )
            Add(
                "W3",
                "ref-local-of-a-region-local",
                "while c {\nvar t = \"x\"\nlet ref a = t\na = nil\n}",
                "flags=[alias-take] writes=[]"
            )
            Add("W5", "list-pattern", "while c { if xs is [1] { } }", "flags=[member-read] writes=[]")
            Add("W5", "property-pattern-field", "while c { if v is { Value: 1 } { } }", "flags=[member-read] writes=[]")
            Add("W5", "empty-property-pattern-is-a-null-test", "while c { if v is { } { } }", "flags=[] writes=[]")
            Add(
                "W1",
                "block-expression-scope",
                "while c {\nlet v = if c2 {\nlet s = \"x\"\ns\n} else {\n\"\"\n}\ns = nil\n}",
                "flags=[] writes=[s]"
            )
            Add(
                "W1",
                "if-initializer-covers-the-else-arm",
                "while c { if var s string? = nil; c2 { } else { s = nil } }",
                "flags=[] writes=[]"
            )
            Add(
                "W3",
                "ref-local-shadows-its-own-target",
                "while c {\nlet ref x = x\nx = 1\n}",
                "flags=[alias-take] writes=[x]"
            )
            return rows
        }

        private func Wrap(statements string) string -> "package T\nfunc Run(c bool, c2 bool) {\n${statements}\n}\n"

        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            yield node
            for child in node.GetChildren() {
                for descendant in Descendants(child) {
                    yield descendant
                }
            }
        }

        private func Loops(root SyntaxNode) sequence[SyntaxNode] {
            for node in Descendants(root) {
                if RegionEffectKindTable.Classify(node.Kind) == RegionEffectClass.Loop {
                    yield node
                }
            }
        }

        private func FirstLoop(root SyntaxNode) SyntaxNode {
            return Assert.IsAssignableFrom[SyntaxNode](Loops(root).First())
        }

        private func Scan(loop string) RegionEffects {
            let tree = SyntaxTree.Parse(Wrap(loop))
            Assert.Empty(tree.Diagnostics.Where((d Diagnostic) -> d.IsError).ToArray())
            return RegionEffectScanner().ScanLoop(FirstLoop(tree.Root))
        }

        private func Span(function string) BackwardJumpSpan? {
            let tree = SyntaxTree.Parse("package T\n" + function + "\n")
            let declaration = Descendants(tree.Root).OfType[FunctionDeclarationSyntax]().First()
            return BackwardJumpSpans.Compute(declaration.Body!!)
        }
    }
}

/// A node whose kind the walker's table does not list.
internal sealed class UnlistedKindSyntax : ExpressionSyntax {
    init(syntaxTree SyntaxTree) : base(syntaxTree) { }

    override prop Kind SyntaxKind -> cast[SyntaxKind](9999)
}
