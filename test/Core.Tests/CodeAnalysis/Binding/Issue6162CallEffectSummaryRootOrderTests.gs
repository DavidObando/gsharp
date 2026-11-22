// <copyright file="Issue6162CallEffectSummaryRootOrderTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import Xunit

/// Issue #6162: a call-effect summary whose effects depend on whether the root of its traversal takes a
/// sequence is cached once per root answer, so the narrowing of a member does not depend on the members
/// that were bound before it. Each test binds the same files in several orders and compares the
/// diagnostics.
open class Issue6162CallEffectSummaryRootOrderTests {
    private const Header string = "package P\n\nimport System.Collections.Generic\nimport System.Linq\n\n"

    // H's deferred callback writes a `C?`. Enumerating a lazy sequence may run it when the root of the
    // traversal takes a sequence.
    private let Shared[]string = []string{
        Header + "class C {\n    var Value int32 = 1\n}\n\nclass Box {\n    var Item C? = nil\n}\n",
        Header +
            "func H(items IEnumerable[int32], box Box) IEnumerable[int32] -> items.Select((x int32) -> {\n    box.Item = nil\n    return x\n})\n"
    }

    @Fact
    func WrapperThatTakesASequence_DoesNotChangeADirectCallersNarrowing() {
        // Binding `Pre` asks for `K`'s summary under the root `K`, which takes a sequence. `G`'s summary is
        // computed in that traversal. `Caller` asks for `G`'s summary under the root `G`, which takes none.
        let files = Shared.Concat(
            []string{
                Header +
                    "func Pre(items IEnumerable[int32], ref a C?) int32 {\n    if a == nil {\n        return 0\n    }\n    let n = K(items)\n    return a.Value + n\n}\n",
                Header + "func K(items IEnumerable[int32]) int32 {\n    return G()\n}\n",
                Header +
                    "func Caller(ref b C?) int32 {\n    if b == nil {\n        return 0\n    }\n    let n = G()\n    return b.Value + n\n}\n",
                Header + "func G() int32 {\n    let xs IEnumerable[int32] = List[int32]()\n    return xs.Count()\n}\n"
            }
        )
            .ToArray()
        let keys = AssertSameInEveryOrder(files)
        // Under `K` the enumeration may write `a`; under `G` it cannot write `b`.
        Assert.Contains(keys, (k string) -> k.StartsWith("f2.gs|GS0158|", StringComparison.Ordinal))
        Assert.DoesNotContain(keys, (k string) -> k.StartsWith("f4.gs|GS0158|", StringComparison.Ordinal))
    }

    @Fact
    func DirectCallFirst_DoesNotChangeTheNarrowingUnderAWrapperThatTakesASequence() {
        // The opposite order: `Direct` caches `G`'s summary under a root that takes no sequence, and
        // `Caller` then reads it in `K`'s traversal.
        let files = Shared.Concat(
            []string{
                Header +
                    "func Direct(ref b C?) int32 {\n    if b == nil {\n        return 0\n    }\n    let n = G()\n    return b.Value + n\n}\n",
                Header +
                    "func Caller(items IEnumerable[int32], ref a C?) int32 {\n    if a == nil {\n        return 0\n    }\n    let n = K(items)\n    return a.Value + n\n}\n",
                Header + "func K(items IEnumerable[int32]) int32 {\n    return G()\n}\n",
                Header + "func G() int32 {\n    let xs IEnumerable[int32] = List[int32]()\n    return xs.Count()\n}\n"
            }
        )
            .ToArray()
        let keys = AssertSameInEveryOrder(files)
        Assert.Contains(keys, (k string) -> k.StartsWith("f3.gs|GS0158|", StringComparison.Ordinal))
        Assert.DoesNotContain(keys, (k string) -> k.StartsWith("f2.gs|GS0158|", StringComparison.Ordinal))
    }

    @Fact
    func MethodsOfOneClass_InTwoDeclarationOrders_ReportTheSame() {
        // The same members in one class, declared in two orders. The keys name the member and the offset
        // inside it, so the two texts compare.
        let members = []string{
            "    func Pre(items IEnumerable[int32], ref a C?) int32 {\n        if a == nil {\n            return 0\n        }\n        let n = K(items)\n        return a.Value + n\n    }\n",
            "    func K(items IEnumerable[int32]) int32 {\n        return G()\n    }\n",
            "    func Caller(ref b C?) int32 {\n        if b == nil {\n            return 0\n        }\n        let n = G()\n        return b.Value + n\n    }\n",
            "    func G() int32 {\n        let xs IEnumerable[int32] = List[int32]()\n        return xs.Count()\n    }\n"
        }
        let forward = MemberKeys(members)
        let backward = MemberKeys(Enumerable.Reverse(members).ToArray())
        Assert.Equal(forward, backward)
        Assert.Contains("Pre|GS0158", forward)
    }

    // Binds the files in every rotation and in reverse, and checks that each order reports the same.
    private func AssertSameInEveryOrder(files[]string) ImmutableArray[string] {
        let trees = List[SyntaxTree]()
        for var i = 0; i < files.Length; i++ {
            trees.Add(SyntaxTree.Parse(SourceText.From(files[i], "f${i}.gs")))
        }
        let orders = List[List[SyntaxTree]]()
        for var shift = 0; shift < trees.Count; shift++ {
            orders.Add(trees.Skip(shift).Concat(trees.Take(shift)).ToList())
        }
        orders.Add(Enumerable.Reverse(trees).ToList())
        let expected = Keys(orders[0])
        for order in orders.Skip(1) {
            let actual = Keys(order)
            Assert.True(
                expected.SequenceEqual(actual),
                "order ${string.Join(",", order.Select((t SyntaxTree) -> t.Text.FileName))}:\n${string.Join("\n", expected)}\n---\n${string.Join("\n", actual)}"
            )
        }
        return expected
    }

    private func Keys(trees List[SyntaxTree]) ImmutableArray[string] -> Compilation(SequenceResolver(), trees.ToArray())
        .GetDiagnostics()
        .Select(
        (
            d Diagnostic
        ) -> "${d.Location.Text?.FileName}|${d.Id}|${d.Location.Span.Start}|${d.Location.Span.Length}|${d.Message}"
    )
        .OrderBy((k string) -> k, StringComparer.Ordinal)
        .ToImmutableArray()

    // The diagnostics of a class with the given members, by the member that holds each one.
    private func MemberKeys(members[]string) List[string] {
        let source = Header +
            "class C {\n    var Value int32 = 1\n}\n\nclass Box {\n    var Item C? = nil\n}\n\nfunc H(items IEnumerable[int32], box Box) IEnumerable[int32] -> items.Select((x int32) -> {\n    box.Item = nil\n    return x\n})\n\nclass W {\n" +
            string.Concat(members) + "}\n"
        let tree = SyntaxTree.Parse(SourceText.From(source, "a.gs"))
        let declarations = tree.Root.DescendantNodes().OfType[FunctionDeclarationSyntax]().ToList()
        return Compilation(SequenceResolver(), tree)
            .GetDiagnostics()
            .Select(
            (d Diagnostic) -> {
                let owner = declarations.FirstOrDefault(
                    (f FunctionDeclarationSyntax) -> f.Span.Start <= d.Location.Span.Start &&
                        d.Location.Span.End <= f.Span.End
                )
                if owner == nil {
                    return "-|${d.Id}"
                }
                return "${owner.Identifier.ValueText}|${d.Id}"
            }
        )
            .OrderBy((k string) -> k, StringComparer.Ordinal)
            .ToList()
    }

    // A default resolver depends on what the process has loaded, and so does the bind of a program whose
    // narrowing reads deferred-enumeration effects: an explicit resolver over the assemblies it uses.
    private func SequenceResolver() ReferenceResolver {
        let runtime = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
        return ReferenceResolver.WithReferences(
            []string{
                typeof(object).Assembly.Location,
                typeof(List[int32]).Assembly.Location,
                typeof(Enumerable).Assembly.Location,
                Path.Combine(runtime, "System.Runtime.dll"),
                Path.Combine(runtime, "System.Collections.dll")
            }
                .Distinct().ToArray()
        )
    }
}
