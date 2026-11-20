// <copyright file="Issue6071NestedIndexerMemberParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit

/// Issue #6071: a nested indexer followed by a member access
/// (`samples[jobs[slot]].Key`, `a[b[c[d]]].X`, `a.b[c[d]].e`,
/// `a[b[c]].M()`, `a[b[c]].Prop = v`, `"${a[b[c]].Key}"`) must parse as an
/// `IndexExpressionSyntax` receiver rather than a
/// `GenericNameExpressionSyntax`. Meanwhile, unambiguously type-shaped
/// arguments (`Box[List[int32?]].Create()`,
/// `Dictionary[string, List[int32]].Empty`) continue to parse as
/// `GenericNameExpressionSyntax`.
open class Issue6071NestedIndexerMemberParserTests {
    @Fact
    func NestedIndexerMemberAccess_ParsesAsIndexExpression() {
        const source = `
package p
func F(samples []string, jobs []int32, slot int32) int32 {
    return samples[jobs[slot]].Length
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let returnStmt = Descendants(tree.Root).OfType[ReturnStatementSyntax]().Single()
        let accessor = Assert.IsType[AccessorExpressionSyntax](returnStmt.Expression)
        let outerIndex = Assert.IsType[IndexExpressionSyntax](accessor.LeftPart)
        Assert.IsType[IndexExpressionSyntax](Assert.Single(outerIndex.Indices))
        Assert.DoesNotContain(Descendants(tree.Root).ToList(), (node SyntaxNode) -> node is GenericNameExpressionSyntax)
    }

    @Fact
    func DeepNestedIndexerMemberAccess_ParsesAsIndexExpression() {
        const source = `
package p
func F(a []string, b []int32, c []int32, d int32) int32 {
    return a[b[c[d]]].Length
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let returnStmt = Descendants(tree.Root).OfType[ReturnStatementSyntax]().Single()
        let accessor = Assert.IsType[AccessorExpressionSyntax](returnStmt.Expression)
        let level1 = Assert.IsType[IndexExpressionSyntax](accessor.LeftPart)
        let level2 = Assert.IsType[IndexExpressionSyntax](Assert.Single(level1.Indices))
        Assert.IsType[IndexExpressionSyntax](Assert.Single(level2.Indices))
        Assert.DoesNotContain(Descendants(tree.Root).ToList(), (node SyntaxNode) -> node is GenericNameExpressionSyntax)
    }

    @Fact
    func MemberBeforeAndAfterNestedIndexer_ParsesAsIndexExpression() {
        const source = `
package p
func F(a Holder, c []int32, d int32) int32 {
    return a.b[c[d]].Length
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let returnStmt = Descendants(tree.Root).OfType[ReturnStatementSyntax]().Single()
        let outerAccessor = Assert.IsType[AccessorExpressionSyntax](returnStmt.Expression)
        let innerAccessor = Assert.IsType[AccessorExpressionSyntax](outerAccessor.RightPart)
        let index = Assert.IsType[IndexExpressionSyntax](innerAccessor.LeftPart)
        Assert.IsType[IndexExpressionSyntax](Assert.Single(index.Indices))
        Assert.DoesNotContain(Descendants(tree.Root).ToList(), (node SyntaxNode) -> node is GenericNameExpressionSyntax)
    }

    @Fact
    func NestedIndexerMemberInvocation_ParsesAsIndexExpression() {
        const source = `
package p
func F(a []int32, b []int32, c int32) string {
    return a[b[c]].ToString()
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let returnStmt = Descendants(tree.Root).OfType[ReturnStatementSyntax]().Single()
        let accessor = Assert.IsType[AccessorExpressionSyntax](returnStmt.Expression)
        let index = Assert.IsType[IndexExpressionSyntax](accessor.LeftPart)
        Assert.IsType[IndexExpressionSyntax](Assert.Single(index.Indices))
        Assert.IsType[CallExpressionSyntax](accessor.RightPart)
        Assert.DoesNotContain(Descendants(tree.Root).ToList(), (node SyntaxNode) -> node is GenericNameExpressionSyntax)
    }

    @Fact
    func NestedIndexerMemberAssignment_ParsesAsIndexExpressionReceiver() {
        const source = `
package p
func F(a []Box, b []int32, c int32, v int32) {
    a[b[c]].Prop = v
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let assign = Descendants(tree.Root).OfType[MemberFieldAssignmentExpressionSyntax]().Single()
        let index = Assert.IsType[IndexExpressionSyntax](assign.Receiver)
        Assert.IsType[IndexExpressionSyntax](Assert.Single(index.Indices))
        Assert.DoesNotContain(Descendants(tree.Root).ToList(), (node SyntaxNode) -> node is GenericNameExpressionSyntax)
    }

    @Fact
    func ParenthesizedNestedIndexerMemberAccess_ParsesAsIndexExpression() {
        const source = `
package p
func F(samples []string, jobs []int32, slot int32) int32 {
    return samples[(jobs[slot])].Length
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let returnStmt = Descendants(tree.Root).OfType[ReturnStatementSyntax]().Single()
        let accessor = Assert.IsType[AccessorExpressionSyntax](returnStmt.Expression)
        let index = Assert.IsType[IndexExpressionSyntax](accessor.LeftPart)
        let paren = Assert.IsType[ParenthesizedExpressionSyntax](Assert.Single(index.Indices))
        Assert.IsType[IndexExpressionSyntax](paren.Expression)
        Assert.DoesNotContain(Descendants(tree.Root).ToList(), (node SyntaxNode) -> node is GenericNameExpressionSyntax)
    }

    @Fact
    func InterpolatedNestedIndexerMemberAccess_ParsesAsIndexExpression() {
        const source = `
package p
func F(samples []string, jobs []int32, slot int32) string {
    return "${samples[jobs[slot]].Length}"
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let nodes = Descendants(tree.Root).ToList()
        Assert.Contains(nodes, (node SyntaxNode) -> node is IndexExpressionSyntax)
        Assert.DoesNotContain(nodes, (node SyntaxNode) -> node is GenericNameExpressionSyntax)
    }

    @Fact
    func UnambiguousGenericStaticMemberAccesses_ParseAsGenericName() {
        const nullableNestedSource = `
package p
func F() int32 {
    return Box[List[int32?]].Create()
}
`
        let nullableNestedTree = SyntaxTree.Parse(nullableNestedSource)
        Assert.Empty(nullableNestedTree.Diagnostics)
        let nullableReturn = Descendants(nullableNestedTree.Root).OfType[ReturnStatementSyntax]().Single()
        let nullableAccessor = Assert.IsType[AccessorExpressionSyntax](nullableReturn.Expression)
        Assert.IsType[GenericNameExpressionSyntax](nullableAccessor.LeftPart)

        const multiArgSource = `
package p
func F() int32 {
    return Dictionary[string, List[int32]].Empty.Count
}
`
        let multiArgTree = SyntaxTree.Parse(multiArgSource)
        Assert.Empty(multiArgTree.Diagnostics)
        let multiArgReturn = Descendants(multiArgTree.Root).OfType[ReturnStatementSyntax]().Single()
        let multiArgAccessor = Assert.IsType[AccessorExpressionSyntax](multiArgReturn.Expression)
        let multiArgGeneric = Assert.IsType[GenericNameExpressionSyntax](multiArgAccessor.LeftPart)
        Assert.Equal(2, multiArgGeneric.TypeArgumentList.Arguments.Count)

        const groupedArraySource = `
package p
func F() int32 {
    return Box[[](int32)].Create()
}
`
        let groupedArrayTree = SyntaxTree.Parse(groupedArraySource)
        Assert.Empty(groupedArrayTree.Diagnostics)
        let groupedArrayReturn = Descendants(groupedArrayTree.Root).OfType[ReturnStatementSyntax]().Single()
        let groupedArrayAccessor = Assert.IsType[AccessorExpressionSyntax](groupedArrayReturn.Expression)
        Assert.IsType[GenericNameExpressionSyntax](groupedArrayAccessor.LeftPart)
    }

    shared {
        private func Descendants(node SyntaxNode) sequence[SyntaxNode] {
            for child in node.GetChildren() {
                yield child
                for d in Descendants(child) {
                    yield d
                }
            }
        }
    }
}
