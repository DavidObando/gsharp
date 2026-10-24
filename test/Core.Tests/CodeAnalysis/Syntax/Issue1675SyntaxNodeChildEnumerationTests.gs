// <copyright file="Issue1675SyntaxNodeChildEnumerationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #1675: (cref:SyntaxNode.GetChildren) used to re-run
/// `GetType().GetProperties()` plus `PropertyInfo.GetValue` on every
/// enumeration; it now uses cached, compiled per-type accessors, and
/// (cref:SyntaxNode.Span) is cached per node. Because `Span` is
/// derived from the child sequence, the new enumeration must be byte-identical
/// to the historical reflection order for every node type. These tests pin
/// that equivalence against a reference implementation that is a verbatim copy
/// of the pre-#1675 reflection-based code.
open class Issue1675SyntaxNodeChildEnumerationTests {
    /// The cached accessor list must select the same properties in the same
    /// order as the historical reflection-based filter, for every concrete
    /// node type in the assembly — no parsing required.
    @Fact
    func ChildPropertyOrder_MatchesLegacyReflectionOrder_ForEveryNodeType() {
        for type in GetConcreteNodeTypes() {
            let actual = SyntaxNode
                .GetChildPropertiesInEnumerationOrder(type)
                .Select((p PropertyInfo) -> p.Name)
                .ToArray()
            let expected = LegacyChildProperties(type).Select((p PropertyInfo) -> p.Name).ToArray()
            Assert.True(
                expected.SequenceEqual(actual),
                "Child property order mismatch for ${type.Name}: expected [${string.Join(", ", expected)}], got [${string.Join(", ", actual)}]"
            )
        }
    }

    /// The child order itself, pinned in a golden. Both sides of the test
    /// above come from `GetProperties()`, so they agree with each other
    /// whatever order the compiler that built GSharp.Core emitted the
    /// properties in. Production child order (and with it first/last token,
    /// spans and diagnostic positions) follows that metadata order, so a
    /// rebuild of Core that reorders properties must fail here rather than pass
    /// both sides of a self-comparison.
    @Fact
    func ChildPropertyOrder_MatchesGolden() {
        let lines = GetConcreteNodeTypes().Select(
            (type Type) -> (
                type.FullName + ": " + string.Join(
                    ", ",
                    SyntaxNode.GetChildPropertiesInEnumerationOrder(type).Select((p PropertyInfo) -> p.Name)
                )
            )
        )
            .ToList()
        Assert.True(lines.Count > 100, "only ${lines.Count} concrete syntax node types")
        GoldenFile.AssertMatches(
            Path.Combine(LocateRepoRoot(), "test", "Core.Tests", "Baselines", "syntax-child-order.txt"),
            string.Join("\n", lines) + "\n",
            "Syntax child order changed. If intended, regenerate with GSHARP_UPDATE_GOLDENS=1; it moves " +
                "first/last tokens, spans and diagnostic positions."
        )
    }

    /// For every node of every tree in the corpus, the new
    /// (cref:SyntaxNode.GetChildren) must yield exactly the same child
    /// instances, in exactly the same order, as the legacy reflection-based
    /// implementation.
    @Fact
    func GetChildren_MatchesLegacyReflectionImplementation_OnCorpus() {
        var nodesChecked = 0
        for tree in ParseCorpus() {
            nodesChecked += AssertChildrenMatchLegacy(tree.Root)
        }
        // Sanity check that the corpus actually exercised a large tree set.
        Assert.True(nodesChecked > 10_000, "corpus unexpectedly small: $nodesChecked nodes")
    }

    /// The corpus must instantiate every concrete (cref:SyntaxNode)
    /// subclass so the parity check above is exhaustive. If this fails after
    /// adding a new syntax node type, add a snippet exercising it to
    /// (cref:Snippets).
    @Fact
    func Corpus_CoversEveryConcreteSyntaxNodeType() {
        let covered = HashSet[Type]()
        for tree in ParseCorpus() {
            Collect(tree.Root, covered)
        }
        let missing = GetConcreteNodeTypes()
            .Where((t Type) -> !covered.Contains(t))
            .Select((t Type) -> t.Name)
            .OrderBy((n string) -> n, StringComparer.Ordinal)
            .ToList()
        Assert.True(
            missing.Count == 0,
            "Corpus does not instantiate: " + string.Join(", ", missing) +
                ". Add a snippet to Issue1675SyntaxNodeChildEnumerationTests.Snippets covering the new node type(s)."
        )
    }

    /// Spans are cached per node (nodes are immutable once parsed), so
    /// accessing them in different orders on two identical trees must produce
    /// identical values node-for-node.
    @Fact
    func Span_IsIdenticalRegardlessOfAccessOrder() {
        const source = `package p

func main() {
  let x = (1 + 2) * 3
  if x > 5 {
    let y = "hello"
  }
}
`
        // Tree 1: root-first — computing the root span recursively computes
        // (and caches) every descendant span.
        let tree1 = SyntaxTree.Parse(source)
        let nodes1 = Flatten(tree1.Root)
        let _ = tree1.Root.Span
        // Tree 2: leaf-first — access spans bottom-up in reverse order.
        let tree2 = SyntaxTree.Parse(source)
        let nodes2 = Flatten(tree2.Root)
        for var i = nodes2.Count - 1; i >= 0; i-- {
            let _ = nodes2[i].Span
        }
        Assert.Equal(nodes1.Count, nodes2.Count)
        for var i = 0; i < nodes1.Count; i++ {
            Assert.Equal(nodes1[i].Kind, nodes2[i].Kind)
            Assert.Equal(nodes1[i].Span.Start, nodes2[i].Span.Start)
            Assert.Equal(nodes1[i].Span.End, nodes2[i].Span.End)
        }
    }

    /// The parser assigns some child-bearing properties after construction
    /// (e.g. (cref:BlockStatementSyntax.UnsafeKeyword)). Those setters
    /// must invalidate a previously computed span so the cache never serves a
    /// stale value.
    @Fact
    func Span_IsInvalidatedWhenParserAssignsChildAfterConstruction() {
        const source = `package p
func F() {
  let x = 1
}
`
        let tree = SyntaxTree.Parse(source)
        let block = Flatten(tree.Root).OfType[BlockStatementSyntax]().First()
        // Force the span to be computed and cached.
        var before = block.Span
        Assert.True(before.Start > 0)
        // Simulate the parser's post-construction mutation: attach a token
        // that lies before the block's current span.
        block.UnsafeKeyword = SyntaxToken(tree, SyntaxKind.IdentifierToken, 0, "unsafe", nil)
        var after = block.Span
        Assert.Equal(0, after.Start)
        Assert.Equal(before.End, after.End)
    }

    shared {
        /// Source snippets that, together with `samples/**/*.gs`, instantiate
        /// every concrete (cref:SyntaxNode) subclass in the Core assembly
        /// (verified by (cref:Corpus_CoversEveryConcreteSyntaxNodeType)).
        private let Snippets IReadOnlyList[string] = []string{`package p
func View(ref value int32) ref readonly int32 { return ref value }
class Box {
 var value int32
 prop View ref readonly int32 -> value
 prop this[i int32] ref readonly int32 -> value
}
func Read() { var value = 1
 let ref readonly view = value }
`, `package p
import System
func F(x any) {
  let s = x as string
  let t = typeof(int32)
  let n = nameof(x)
  throw Exception("boom")
}
`, `package p
import System
func R() {
  try {
    throw Exception("boom")
  } catch (e Exception) {
    rethrow
  }
}
`, `package p
import System
func G(s string?) string {
  return s ?? throw Exception("null")
}
`, `package P
class WithInit {
  public var Asin string
  public var Title string
}
func Main() {
  var w = WithInit() { Asin = "X", Title = "T" }
}
`, `package P
import System
class Foo {
  event Changed () -> void {
    add { }
    remove { }
  }
}
`, `package p
func F(v int32) int32 {
  let x = switch v { case > 0 and < 10: 1 case not > 20: 2 case (== 0 or > 5): 3 default: 0 }
  return x
}
`, `package p
func F(v object?) bool {
  return v is var captured && captured == nil
}
`, `package p
func F(a []int32) {
  let b = a[^1]
  let c = a[1..^1]
  let d = a[..2]
}
`, `package p
func F(a []int32) {
  let b = []int32{0, ...a, 9}
}
`, `package p
func F() {
  let pos (line int32, column int32) = (line: 3, column: 5)
  let l = pos.line
}
`, `package p
func F(r in chan[int32], w out chan[int32]) {
  let legacy = make(chan int32, 1)
  let ch = chan[int32](1)
}
`, `package p
struct Box[T] { shared { func Make(x int32) int32 { return x } } }
class C { func F() int32 { return Box[int32?].Make(5) } }
`, `package p
open class B { open func M() int32 { return 1 } }
class C : B { override func M() int32 { return base.M() } }
`, `package p
class W { shared { var Count int32 = 0
 init { Count = 1 } } }
`, `package p
func F() {
  var a = 1
  var b = 2
  a, b = b, a
}
`, `package p
func F() {
  var existing = 0
  existing, let fresh = (1, 2)
}
`, `package p
class Box { var Value int32 }
func Pair() (int32, int32) { return (1, 2) }
func F(a []int32, box Box) {
  a[0], box.Value = Pair()
}
`, `package p
func F() {
  for {
    break
  }
}
`, `package p
func F(v int32) {
  switch v {
    case 1, 2 {
      fallthrough
    }
    default {
    }
  }
}
`, `package p
unsafe func F(dest []uint8) {
  fixed pD *uint8 = dest { }
  var buf = stackalloc [4]uint8
  let sz = sizeof(int32)
  var x = 1
  var px = &x
  *px = 2
}
`, `package p
unsafe func F() {
  var arr = []int32{1, 2, 3}
  var p *int32 = &arr[0]
  var i int32 = 0
  *(p + i) += 1
}
`, `package p
func F() {
  var a int32 = 1
  var b int32 = 2
  var c = checked(a + b)
  var d = unchecked(a + b)
  checked {
    var e = a + b
  }
  unchecked {
    var f = a + b
  }
}
`, `package p
struct Inner { var x int32 }
struct S {
  var arr []int32
  var inner Inner
}
func F(s S, arr []int32) {
  s.inner.x = 1
  s.arr[0] = 1
  arr[0] += 1
  s.arr[0] += 2
}
`, `package p
func F(cond bool) {
  var a = 1
  var b = 2
  var x = cond ? ref a : ref b
}
`, `package p
import System
@field:Obsolete
var counter = 0
func F(@param:NotNull x int32) {
}
`, `package p
func F() {
  var x = object { let Name string = "Foo"; let Age int32 = 42 }
}
`, `package p
type MyInt = int32
`, `package p
import System
async func F(stream any) {
  await using let r = stream
  await for v in stream {
  }
}
`, `package p
class Gate {}
func F(g Gate) {
  lock g {
    var x = 1
  }
}
`, `package p
func F(xs [](int32, int32)) {
  for (a, b) in xs {
  }
}
`, `package p
func F() {
  var a = 0
  retry:
  a = a + 1
  if a < 3 {
    goto retry
  }
}
`, `package p
func F(s string?) int32 {
  return if let v = s && v.Length > 0 { v.Length } else { 0 }
}
`, `package p
func F(s string?) {
  while let v = s {
    break
  }
}
`, `package p
func F(rows []int32) {
  var c = Container{ Width: 1, 2, ...rows }
}
`, `package p
func F(rows []int32) {
  var c = Container[int32](7){ ...rows, .Width: 1, key: 2, [key] = 3, }
}
`, `package p
func F() int32 {
  let f = ((x int32, y int32)) -> x + y
  return f((1, 2))
}
`}

        private func LocateRepoRoot() string {
            for var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory); dir != nil; dir = dir!!.Parent {
                if Directory.Exists(Path.Combine(dir.FullName, "test", "Core.Tests", "Baselines")) {
                    return dir.FullName
                }
            }
            throw InvalidOperationException("repository root not found from " + AppContext.BaseDirectory)
        }

        internal func GetConcreteNodeTypes() List[Type] {
            return typeof(SyntaxNode)
                .Assembly
                .GetTypes()
                .Where((t Type) -> typeof(SyntaxNode).IsAssignableFrom(t) && !t.IsAbstract)
                .OrderBy((t Type) -> t.FullName!!, StringComparer.Ordinal)
                .ToList()
        }

        internal func ParseCorpus() sequence[SyntaxTree] {
            for snippet in Snippets {
                yield SyntaxTree.Parse(snippet)
            }
            let samplesDirectory string? = LocateSamplesDirectory()
            Assert.NotNull(samplesDirectory)
            for path in Directory.EnumerateFiles(samplesDirectory!!, "*.gs", SearchOption.AllDirectories).OrderBy(
                (p string) -> p,
                StringComparer.Ordinal
            ) {
                yield SyntaxTree.Parse(File.ReadAllText(path))
            }
        }

        private func LocateSamplesDirectory() string? {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(Issue1675SyntaxNodeChildEnumerationTests).Assembly.Location)!!
            )
            while dir != nil {
                let candidate = Path.Combine(dir.FullName, "samples")
                if Directory.Exists(candidate) {
                    return candidate
                }
                dir = dir.Parent
            }
            return nil
        }

        private func AssertChildrenMatchLegacy(node SyntaxNode) int32 {
            // A class marked @SyntaxChildSourceOrder lists the same children by source position
            // (issue #5185). OrderBy is stable.
            var expected = LegacyGetChildren(node).ToList()
            if Attribute.IsDefined(node.GetType(), typeof(SyntaxChildSourceOrderAttribute), true) {
                expected = expected.OrderBy((c SyntaxNode) -> c.Span.Start).ToList()
            }
            let actual = node.GetChildren().ToList()
            Assert.True(
                expected.Count == actual.Count,
                "${node.GetType().Name}: expected ${expected.Count} children, got ${actual.Count}"
            )
            var checkedNodes = 1
            for var i = 0; i < expected.Count; i++ {
                Assert.Same(expected[i], actual[i])
            }
            for child in expected {
                checkedNodes += AssertChildrenMatchLegacy(child)
            }
            return checkedNodes
        }

        private func Collect(node SyntaxNode, covered HashSet[Type]) {
            covered.Add(node.GetType())
            for child in node.GetChildren() {
                Collect(child, covered)
            }
        }

        private func Flatten(root SyntaxNode) List[SyntaxNode] {
            let result = List[SyntaxNode]()
            let stack = Stack[SyntaxNode]()
            stack.Push(root)
            while stack.Count > 0 {
                let node = stack.Pop()
                result.Add(node)
                for child in node.GetChildren().Reverse() {
                    stack.Push(child)
                }
            }
            return result
        }

        private func LegacyChildProperties(nodeType Type) sequence[PropertyInfo] {
            // Historical filter plus explicit derived-property exclusions.
            let properties = nodeType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            for property in properties {
                if property.GetCustomAttribute[SyntaxChildIgnoreAttribute]() == nil &&
                    (
                    typeof(SyntaxNode).IsAssignableFrom(property.PropertyType) ||
                        typeof(SeparatedSyntaxList).IsAssignableFrom(property.PropertyType) ||
                        typeof(IEnumerable[SyntaxNode]).IsAssignableFrom(property.PropertyType)
                ) {
                    yield property
                }
            }
        }

        private func LegacyGetChildren(node SyntaxNode) sequence[SyntaxNode] {
            // Historical implementation plus explicit derived-property exclusions.
            let properties = node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance)
            for property in properties {
                if property.GetCustomAttribute[SyntaxChildIgnoreAttribute]() != nil {
                    continue
                }
                if typeof(SyntaxNode).IsAssignableFrom(property.PropertyType) {
                    let child SyntaxNode? = cast[SyntaxNode](property.GetValue(node))
                    if child != nil {
                        yield child
                    }
                } else if typeof(SeparatedSyntaxList).IsAssignableFrom(property.PropertyType) {
                    let separatedSyntaxList SeparatedSyntaxList? = cast[SeparatedSyntaxList](property.GetValue(node))
                    if separatedSyntaxList == nil {
                        continue
                    }
                    for child in separatedSyntaxList.GetWithSeparators() {
                        yield child
                    }
                } else if typeof(IEnumerable[SyntaxNode]).IsAssignableFrom(property.PropertyType) {
                    let children IEnumerable[SyntaxNode]? = cast[IEnumerable[SyntaxNode]](property.GetValue(node))
                    for child in children!! {
                        if child != nil {
                            yield child
                        }
                    }
                }
            }
        }
    }
}
