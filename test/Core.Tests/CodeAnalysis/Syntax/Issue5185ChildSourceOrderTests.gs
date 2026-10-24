// <copyright file="Issue5185ChildSourceOrderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Threading
import Xunit

/// Issue #5185: `GetChildren` yields the children of every node in source order. These tests run
/// on every node of the corpus (the snippets and `samples/**/*.gs`) and on small exact cases.
open class Issue5185ChildSourceOrderTests {
    /// The start of each child is not before the start of the previous child, for every node of the
    /// corpus. A failure lists each (node class, previous child kind, next child kind) shape.
    @Fact
    func ChildStarts_NeverGoBackward_OnCorpus() {
        let found = SortedSet[string](StringComparer.Ordinal)
        var nodes = 0
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                nodes++
                var previous SyntaxNode? = nil
                for child in node.GetChildren() {
                    if previous != nil && child.Span.Start < previous.Span.Start {
                        found.Add("${node.GetType().Name}: ${previous.Kind} -> ${child.Kind}")
                    }
                    previous = child
                }
            }
        }
        Assert.True(nodes > 10_000, "corpus unexpectedly small: $nodes nodes")
        Assert.True(
            found.Count == 0,
            "Children out of source order (${found.Count} shapes):\n" + string.Join("\n", found)
        )
    }

    /// Children can still overlap in order. This is not an ordering defect. A synthesized token
    /// (an expression body's `return`, the braces of a body-less type) shares a position with a
    /// real one. An interpolated string token contains its holes. Two properties can return one
    /// token. This test records each such shape so a new one is reviewed. Regenerate with
    /// GSHARP_UPDATE_GOLDENS=1.
    @Fact
    func ChildOverlaps_MatchTheRecordedShapes() {
        let found = SortedSet[string](StringComparer.Ordinal)
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                var previous SyntaxNode? = nil
                for child in node.GetChildren() {
                    if previous != nil && child.Span.Start < previous.Span.End {
                        let reason = if object.ReferenceEquals(previous, child) {
                            "same instance twice"
                        } else if child.Span.End <= previous.Span.End {
                            "contained in the previous child"
                        } else {
                            "partial overlap"
                        }
                        found.Add("${node.GetType().Name}: ${previous.Kind} -> ${child.Kind} (${reason})")
                    }
                    previous = child
                }
            }
        }
        GoldenFile.AssertMatches(
            Path.Combine(LocateRepoRoot(), "test", "Core.Tests", "Baselines", "syntax-child-overlaps.txt"),
            string.Join("\n", found) + "\n",
            "A syntax node has overlapping children in a new shape. If the new shape is expected, " +
                "regenerate with GSHARP_UPDATE_GOLDENS=1."
        )
    }

    /// A postfix `!!` follows its operand, so it is the last token of the expression.
    @Fact
    func PostfixUnary_ListsTheOperandBeforeTheOperator() {
        let tree = SyntaxTree.Parse("package p\nfunc F(x int32?) int32 { return x!! }\n")
        let unary = Descendants(tree.Root).OfType[UnaryExpressionSyntax]().First()
        Assert.Equal("x !!", Leaves(unary))
        Assert.Equal("x", unary.GetFirstToken().Text)
        Assert.Equal("!!", unary.GetLastToken().Text)
    }

    /// A prefix operator stays first.
    @Fact
    func PrefixUnary_ListsTheOperatorFirst() {
        let tree = SyntaxTree.Parse("package p\nfunc F(x int32) int32 { return -x }\n")
        let unary = Descendants(tree.Root).OfType[UnaryExpressionSyntax]().First()
        Assert.Equal("- x", Leaves(unary))
    }

    /// The forms of a type clause list their tokens in the order they are written.
    @Fact
    func TypeClauseForms_ListTheirTokensInSourceOrder() {
        let tree = SyntaxTree.Parse(
            "package p\nfunc F(a string?, b []int32, c (int32, int32) -> int32, d map[string, int32]) { }\n"
        )
        let clauses = Descendants(tree.Root).OfType[ParameterSyntax]().Select((p ParameterSyntax) -> p.Type!!).ToList()
        Assert.Equal(4, clauses.Count)
        Assert.Equal("string ?", Leaves(clauses[0]))
        Assert.Equal("[ ] int32", Leaves(clauses[1]))
        Assert.Equal("( int32 , int32 ) -> int32", Leaves(clauses[2]))
        Assert.Equal("map [ string , int32 ]", Leaves(clauses[3]))
    }

    /// A struct lists fields, methods, nested types and the shared block where they are written.
    @Fact
    func StructBody_ListsMembersInSourceOrder() {
        let tree = SyntaxTree.Parse(
            "package p\nclass A {\n    var a int32\n    func F() { }\n    shared {\n        var s int32 = 1\n    }\n    var b int32\n    class Inner { }\n}\n"
        )
        let type = Descendants(tree.Root).OfType[StructDeclarationSyntax]().First()
        Assert.Equal(
            "class A { var a int32 func F ( ) { } shared { var s int32 = 1 } var b int32 class Inner { } }",
            Leaves(type)
        )
        Assert.Equal("class", type.GetFirstToken().Text)
        Assert.Equal("}", type.GetLastToken().Text)
    }

    /// Annotations and modifiers come before the `func` keyword, and the return type is last.
    @Fact
    func FunctionDeclaration_ListsAnnotationsAndModifiersFirst() {
        let tree = SyntaxTree.Parse("package p\n@Obsolete\nprivate func F() int32 { return 1 }\n")
        let function = Descendants(tree.Root).OfType[FunctionDeclarationSyntax]().First()
        Assert.Equal("@ Obsolete private func F ( ) int32 { return 1 }", Leaves(function))
        Assert.Equal("@", function.GetFirstToken().Text)
    }

    /// A receiver in parentheses follows the `func` keyword.
    @Fact
    func MethodWithReceiver_ListsTheKeywordBeforeTheReceiver() {
        let tree = SyntaxTree.Parse("package p\nfunc (v int32) Scale(f int32) int32 { return v * f }\n")
        let function = Descendants(tree.Root).OfType[FunctionDeclarationSyntax]().First()
        Assert.Equal("func ( v int32 ) Scale ( f int32 ) int32 { return v * f }", Leaves(function))
    }

    /// A node that lists its annotations among the child properties must either declare them
    /// first or sort its children by source position. An annotation is written before the rest of
    /// the declaration, so an `Annotations` property declared after other child properties
    /// breaks the order (the shared cause in review of #5275). The test also checks the order
    /// of the rare forms: a fixed buffer, an explicit interface property and an explicit interface event.
    @Fact
    func NodesWithAnnotations_DeclareThemFirstOrSortTheirChildren() {
        var checkedTypes = 0
        for type in Issue1675SyntaxNodeChildEnumerationTests.GetConcreteNodeTypes() {
            let properties = SyntaxNode.GetChildPropertiesInEnumerationOrder(type)
            let annotations = properties.ToList().FindIndex(
                (p System.Reflection.PropertyInfo) -> p.PropertyType == typeof(
                    System.Collections.Immutable.ImmutableArray[AnnotationSyntax]
                )
            )
            if annotations < 0 {
                continue
            }
            checkedTypes++
            Assert.True(
                annotations == 0 || SyntaxNode.IsSourceOrdered(type),
                "${type.Name} lists Annotations after other children but does not carry @SyntaxChildSourceOrder"
            )
        }
        Assert.True(checkedTypes >= 8, "only $checkedTypes node types have annotations")
    }

    @Fact
    func FixedBufferAndExplicitInterfaceForms_AreInTheCorpusAndInSourceOrder() {
        var fixedFields = 0
        var explicitProperties = 0
        var explicitEvents = 0
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                if node is FieldDeclarationSyntax field && field.FixedKeyword != nil {
                    fixedFields++
                    Assert.Equal("fixed", node.GetFirstToken().Text)
                } else if node is PropertyDeclarationSyntax property && property.ExplicitInterfaceType != nil {
                    explicitProperties++
                    Assert.True(node.GetFirstToken().Position <= property.PropKeyword.Position)
                } else if node is EventDeclarationSyntax declaration && declaration.ExplicitInterfaceType != nil {
                    explicitEvents++
                }
                var previous SyntaxNode? = nil
                if node is FieldDeclarationSyntax ||
                    node is PropertyDeclarationSyntax ||
                    node is EventDeclarationSyntax {
                    for child in node.GetChildren() {
                        Assert.True(previous == nil || child.Span.Start >= previous.Span.Start, node.GetType().Name)
                        previous = child
                    }
                }
            }
        }
        Assert.True(fixedFields > 0 && explicitProperties > 0 && explicitEvents > 0, "forms missing from the corpus")
    }

    /// The parser builds a long postfix `!!` chain in a loop, so the tree is very deep. Sorting
    /// the children and computing spans must not recurse on the call stack (review of #5275).
    /// The walk runs on a thread with a small stack, where recursion over 20,000 levels fails.
    @Fact
    func DeepPostfixChain_ListsChildrenAndSpansWithoutRecursion() {
        let source = "package p\nfunc F(x int32?) int32 { return x" + string.Concat(Enumerable.Repeat("!!", 20000)) +
            " }\n"
        let tree = SyntaxTree.Parse(source)
        let negatedSource = "package p\nfunc F(a object) bool { return a" + " !is Dog" + " }\n"
        let negatedTree = SyntaxTree.Parse(negatedSource)
        var firstText = ""
        var lastText = ""
        var negatedFirst = ""
        var negatedLast = ""
        var failure Exception? = nil
        var spanLength = 0
        var visited = 0
        let thread = Thread(
            () -> {
                try {
                    spanLength = tree.Root.Span.Length
                    // The outermost unary expression of a long chain: its first and last token are
                    // found by a loop, not by one call per operator.
                    let outer = Descendants(tree.Root).OfType[UnaryExpressionSyntax]().First()
                    firstText = outer.GetFirstToken().Text
                    lastText = outer.GetLastToken().Text
                    let negated = Descendants(negatedTree.Root).OfType[UnaryExpressionSyntax]().First()
                    negatedFirst = negated.GetFirstToken().Text
                    negatedLast = negated.GetLastToken().Text
                    for node in Descendants(tree.Root) {
                        visited++
                    }
                } catch (ex Exception) {
                    failure = ex
                }
            },
            524288
        )
        thread.Start()
        thread.Join()
        Assert.True(failure == nil, failure?.ToString() ?? "")
        Assert.Equal("x", firstText)
        Assert.Equal("!!", lastText)
        Assert.Equal("a", negatedFirst)
        Assert.Equal("Dog", negatedLast)
        Assert.True(spanLength > 40000)
        Assert.True(visited > 40000, "visited only $visited nodes")
    }

    /// An incomplete `1 !is` ends in a missing pattern token. The REPL uses this token to decide
    /// whether to wait for more input (review of #5275).
    @Fact
    func IncompleteNegatedIs_LastTokenIsTheMissingPattern() {
        let tree = SyntaxTree.Parse("1 !is")
        Assert.True(tree.Root.Members.Length > 0)
        Assert.True(tree.Root.Members[^1].GetLastToken().IsMissing)
        let complete = SyntaxTree.Parse("a !is Dog")
        Assert.Equal("Dog", complete.Root.Members[^1].GetLastToken().Text)
        Assert.Equal("a", complete.Root.Members[^1].GetFirstToken().Text)
    }

    /// A synthesized `return` of an expression body has a span that is wider than the body. It must
    /// not make the method look like it ends before an unfinished class (review of #5275).
    @Fact
    func SynthesizedReturn_DoesNotHideTheMissingClassBrace() {
        let unfinished = SyntaxTree.Parse("class C {\n    func F() int32 -> 1\n")
        Assert.True(unfinished.Root.Members[^1].GetLastToken().IsMissing)
        let finished = SyntaxTree.Parse("class C {\n    func F() int32 -> 1\n}\n")
        Assert.Equal("}", finished.Root.Members[^1].GetLastToken().Text)
        let tree = SyntaxTree.Parse("package p\nfunc F() int32 -> 1\n")
        let statement = Descendants(tree.Root).OfType[ReturnStatementSyntax]().First()
        Assert.Equal("1", statement.GetLastToken().Text)
    }

    /// Children with the same start keep the order of the properties, so the sort is stable.
    @Fact
    func SortBySourcePosition_KeepsTheOrderOfChildrenWithTheSameStart() {
        let tree = SyntaxTree.Parse("package p\nfunc F() { G(1) }\n")
        let call = Descendants(tree.Root).OfType[CallExpressionSyntax]().First()
        let callee = call.GetChild(0)
        // The call and its callee start at the same position.
        Assert.Equal(call.Span.Start, callee.Span.Start)
        let kept = SyntaxNode.SortBySourcePosition(ImmutableArray.Create[SyntaxNode](call, callee))
        Assert.Same(call, kept[0])
        Assert.Same(callee, kept[1])
        let swapped = SyntaxNode.SortBySourcePosition(ImmutableArray.Create[SyntaxNode](callee, call))
        Assert.Same(callee, swapped[0])
        let later = call.GetChild(call.ChildCount - 1)
        let ordered = SyntaxNode.SortBySourcePosition(ImmutableArray.Create[SyntaxNode](later, callee))
        Assert.Same(callee, ordered[0])
        Assert.Same(later, ordered[1])
    }

    /// A node class outside the compiler can override `Span`. A parent uses that value, whether or
    /// not it computed its own span before (review of #5275).
    @Fact
    func ExternalSpanOverride_IsUsedByTheParentSpan() {
        let tree = SyntaxTree.Parse("package p\nfunc F() int32 { return 1 + 2 }\n")
        let binary = Descendants(tree.Root).OfType[BinaryExpressionSyntax]().First()
        let child = SpanOverridingBinary(tree, binary.Left, binary.OperatorToken, binary.Right)
        Assert.Equal(1005, child.Span.End)
        let parent = BinaryExpressionSyntax(tree, child, binary.OperatorToken, binary.Right)
        Assert.Equal(1005, parent.Span.End)
        // The span of the child is not cached, so a second parent sees the same value.
        let other = BinaryExpressionSyntax(tree, child, binary.OperatorToken, binary.Right)
        Assert.Equal(1005, other.Span.End)
        let outer = BinaryExpressionSyntax(tree, parent, binary.OperatorToken, binary.Right)
        Assert.Equal(1005, outer.Span.End)
    }

    /// A graph that a caller builds by sharing one child twice has few distinct nodes but
    /// exponentially many paths. The deep span walk plans each node once (review of #5275).
    @Fact
    func SharedSubtreeGraph_IsPlannedOncePerNode() {
        let tree = SyntaxTree.Parse("package p\nfunc F() int32 { return 1 + 2 }\n")
        let binary = Descendants(tree.Root).OfType[BinaryExpressionSyntax]().First()
        var node ExpressionSyntax = binary
        for var i = 0; i < 140; i++ {
            node = BinaryExpressionSyntax(tree, node, binary.OperatorToken, node)
        }
        using let measurements = CompilationMeasurements.Start("issue5185")
        let span = node.Span
        Assert.Equal(binary.Span.Start, span.Start)
        let planned = measurements.GetCounter("syntax.deep-span-nodes")
        Assert.True(planned > 0 && planned <= 20, "planned $planned nodes")
    }

    /// A synthesized `return` can extend the span of the operand through a postfix `!!`. The
    /// postfix operator is still the last token (review of #5275).
    @Fact
    func PostfixAfterSynthesizedReturn_EndsInTheOperator() {
        for source in[]string{
            "package p\nlet x = object{func F()int32->1}!!\n",
            "package p\nlet x = object{func F() int32 -> 1}!!\n",
            "package p\nlet x = object{func F() int32 -> 1 }!!\n",
            "package p\nlet x = object{func F() int32 -> 1\n}!!\n"
        } {
            let tree = SyntaxTree.Parse(source)
            let unary = Descendants(tree.Root).OfType[UnaryExpressionSyntax]().First()
            Assert.Equal("!!", unary.GetLastToken().Text)
            Assert.Equal("object", unary.GetFirstToken().Text)
        }
    }

    /// The rules of the whole feature, checked on the corpus and on edge shapes:
    /// 1. child starts never go backward;
    /// 2. a node that uses the base span has the bounds of its children (no children: 0..0);
    /// 3. the first token is the first token of the first child;
    /// 4. the last token is the last token of the last child, except the `!` of `!is`.
    /// The edge shapes cover missing tokens, empty input, unfinished input and comments.
    @Fact
    func OrderSpanAndEdgeTokens_FollowTheInvariants() {
        let sources = List[string]()
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            sources.Add(tree.Text.ToString())
        }
        for edge in[]string{
            "",
            "// only a comment\n",
            "1 !is",
            "a !is Dog",
            "x!!",
            "class C {",
            "class C { func F() int32 -> 1",
            "func F(",
            "package",
            "import",
            "let s = \"$",
            "let s = \"$" + "{x}\"",
            "enum E { A, B",
            "struct S { var a int32 /* c */ func F() { } // t\n var b int32 }",
            "@A\n@B func F() { }",
            "func F() { return -- }"
        } {
            sources.Add(edge)
        }
        var checkedNodes = 0
        for source in sources {
            let tree = SyntaxTree.Parse(source)
            for node in Descendants(tree.Root) {
                checkedNodes++
                let count = node.ChildCount
                for var i = 1; i < count; i++ {
                    if node.GetChild(i).Span.Start < node.GetChild(i - 1).Span.Start {
                        let shape = string.Join(
                            ", ",
                            node.GetChildren().Select((c SyntaxNode) -> c.Kind.ToString() + " " + c.Span.ToString())
                        )
                        Assert.Fail(
                            "${node.GetType().Name}: child $i starts before child ${i - 1} in [${source}]: ${shape}"
                        )
                    }
                }
                if node is SyntaxToken {
                    continue
                }
                if SyntaxNode.HasBaseSpan(node.GetType()) {
                    var start = int32.MaxValue
                    var end = int32.MinValue
                    for var i = 0; i < count; i++ {
                        start = Math.Min(start, node.GetChild(i).Span.Start)
                        end = Math.Max(end, node.GetChild(i).Span.End)
                    }
                    if count == 0 {
                        start = 0
                        end = 0
                    }
                    Assert.True(
                        node.Span.Start == start && node.Span.End == end,
                        "${node.GetType().Name}: span ${node.Span} is not the bounds ${start}..${end}"
                    )
                }
                if count > 0 {
                    Assert.Same(node.GetChild(0).GetFirstToken(), node.GetFirstToken())
                    let isNegatedIs = node is UnaryExpressionSyntax unary &&
                        unary
                        .OperatorToken
                        .Kind == SyntaxKind.BangToken &&
                        unary.Operand is IsExpressionSyntax &&
                        unary
                        .Operand
                        .Span
                        .Start < unary
                        .OperatorToken
                        .Span
                        .Start
                    if !isNegatedIs {
                        Assert.Same(node.GetChild(count - 1).GetLastToken(), node.GetLastToken())
                    }
                }
            }
        }
        Assert.True(checkedNodes > 10_000, "only $checkedNodes nodes")
    }

    /// Reflection and the generated accessors order the children the same way.
    @Fact
    func ReflectionOracle_UsesTheSameOrder() {
        for tree in Issue1675SyntaxNodeChildEnumerationTests.ParseCorpus() {
            for node in Descendants(tree.Root) {
                Assert.True(
                    node.GetChildren().SequenceEqual(node.GetChildrenByReflection()),
                    "${node.GetType().Name} children differ from the reflection order"
                )
            }
        }
    }

    private class SpanOverridingBinary : BinaryExpressionSyntax {
        init(syntaxTree SyntaxTree, left ExpressionSyntax, operatorToken SyntaxToken, right ExpressionSyntax) : base(
            syntaxTree,
            left,
            operatorToken,
            right
        ) { }

        override prop Span TextSpan -> TextSpan(1000, 5)
    }

    shared {
        /// Returns the texts of the leaf tokens of a node, in the order of `GetChildren`.
        private func Leaves(node SyntaxNode) string {
            let texts = List[string]()
            AddLeaves(node, texts)
            return string.Join(" ", texts)
        }

        private func AddLeaves(node SyntaxNode, texts List[string]) {
            if node is SyntaxToken token {
                texts.Add(token.Text)
                return
            }
            for child in node.GetChildren() {
                AddLeaves(child, texts)
            }
        }

        private func Descendants(root SyntaxNode) sequence[SyntaxNode] {
            let stack = Stack[SyntaxNode]()
            stack.Push(root)
            while stack.Count > 0 {
                let node = stack.Pop()
                yield node
                let count = node.ChildCount
                for var i = count - 1; i >= 0; i-- {
                    stack.Push(node.GetChild(i))
                }
            }
        }

        private func LocateRepoRoot() string {
            for var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory); dir != nil; dir = dir!!.Parent {
                if Directory.Exists(Path.Combine(dir.FullName, "test", "Core.Tests", "Baselines")) {
                    return dir.FullName
                }
            }
            throw InvalidOperationException("repository root not found from " + AppContext.BaseDirectory)
        }
    }
}
