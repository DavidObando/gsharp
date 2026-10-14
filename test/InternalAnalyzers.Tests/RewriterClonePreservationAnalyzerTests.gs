// <copyright file="RewriterClonePreservationAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers.Tests

import GSharp.InternalAnalyzers
import System.Threading.Tasks
import Xunit

/// GSA0005 guards the shape behind issues #1644 and #3333: a
/// `BoundTreeRewriter` override that rebuilds its node through a
/// constructor that silently omits a member the base rewriter carries.
class RewriterClonePreservationAnalyzerTests {
    @Fact
    func ReportsAnOverrideThatRebuildsWithoutTheDiscriminator() Task {
        // The #1644 / #3333 shape exactly: the override rebuilds through the
        // variable-receiver constructor on every path, so an interface-static
        // node silently loses InterfaceType.
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal open class Broken : BoundTreeRewriter {
    protected open override func [|RewriteFieldNode|](node FieldNode) Node {
        return FieldNode(node.Receiver, node.Field, node.Value)
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source, "GSA0005")
    }

    @Fact
    func AcceptsAnOverrideThatBranchesOnTheDiscriminator() Task {
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal open class Fixed : BoundTreeRewriter {
    protected open override func RewriteFieldNode(node FieldNode) Node {
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, node.Value) } else { FieldNode(node.Receiver, node.Field, node.Value) }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source)
    }

    @Fact
    func AcceptsAnOverrideThatDoesNotRebuild() Task {
        // Delegating or returning the node unchanged cannot drop anything.
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal open class Delegating : BoundTreeRewriter {
    protected open override func RewriteFieldNode(node FieldNode) Node {
        return if node.Field == "skip" { cast[Node](node) } else { base.RewriteFieldNode(node) }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source)
    }

    @Fact
    func DelegatingOnOnePathDoesNotExcuseDroppingOnAnother() Task {
        // The regression that made this rule worth having: an override with a
        // `base` fallback still has to preserve members on the path it rebuilds.
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal open class PartlyDelegating : BoundTreeRewriter {
    protected open override func [|RewriteFieldNode|](node FieldNode) Node {
        if node.Field == "skip" {
            return base.RewriteFieldNode(node)
        }
        return FieldNode(node.Receiver, node.Field, node.Value)
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source, "GSA0005")
    }

    @Fact
    func AcceptsReadsReachedThroughAHelper() Task {
        // Lowering/BoundNodeForm.cs extracts a recurring union invariant into a
        // helper; the members it reads still count as preserved.
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal open class ViaHelper : BoundTreeRewriter {
    protected open override func RewriteFieldNode(node FieldNode) Node {
        let owner string? = Discriminator(node)
        return if owner != nil { FieldNode(node.Field, owner, node.Value) } else { FieldNode(node.Receiver, node.Field, node.Value) }
    }

    shared {
        private func Discriminator(node FieldNode) string? -> node.InterfaceType
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source)
    }

    @Fact
    func AcceptsReadsReachedThroughAQualifiedStaticHelper() Task {
        // The shape the compiler actually uses: Lowering/BoundNodeForm.cs is a
        // separate static class, so the hop is a QUALIFIED call
        // (`BoundNodeForm.DeclaringType(node)`), not a bare one. Issue #3822 --
        // G# splits a qualified call across two syntax nodes and the semantic
        // model answered for only one of them, so the migrated analyzer
        // reported five methods Roslyn does not.
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal shared class Form {
    func Discriminator(node FieldNode) string? -> node.InterfaceType
}

internal open class ViaQualifiedHelper : BoundTreeRewriter {
    protected open override func RewriteFieldNode(node FieldNode) Node {
        let owner string? = Form.Discriminator(node)
        return if owner != nil { FieldNode(node.Field, owner, node.Value) } else { FieldNode(node.Receiver, node.Field, node.Value) }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source)
    }

    @Fact
    func AQualifiedStaticHelperThatReadsSomethingElseStillReports() Task {
        // The negative's twin, on the same FollowHelper path: the qualified
        // helper resolves and is followed, but it reads Field rather than the
        // discriminator, so the drop is still reported. An analyzer that
        // silenced the qualified-helper shape wholesale -- or that stopped
        // resolving qualified calls again -- fails here rather than passing
        // quietly.
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal shared class OtherForm {
    func Label(node FieldNode) string -> node.Field
}

internal open class ViaWrongQualifiedHelper : BoundTreeRewriter {
    protected open override func [|RewriteFieldNode|](node FieldNode) Node {
        let label = OtherForm.Label(node)
        return FieldNode(node.Receiver, label, node.Value)
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source, "GSA0005")
    }

    @Fact
    func AcceptsReadsThroughTheRewrittenBaseResult() Task {
        // `var rewritten = (T)base.RewriteX(node);` makes `rewritten` the node's
        // stand-in, so members read off it are preserved.
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal open class ViaBaseResult : BoundTreeRewriter {
    protected open override func RewriteFieldNode(node FieldNode) Node {
        let rewritten = cast[FieldNode](base.RewriteFieldNode(node))
        return if rewritten.InterfaceType != nil { FieldNode(rewritten.Field, rewritten.InterfaceType!!, rewritten.Value) } else { FieldNode(rewritten.Receiver, rewritten.Field, rewritten.Value) }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source)
    }

    @Fact
    func IgnoresMembersEveryConstructorRequires() Task {
        // An override that replaces the node with a different shape is a design
        // choice, not a silent drop: a member no constructor can omit is never
        // reported. Here Value is required by both forms.
        let source = `internal open class Node {
}

internal class FieldNode : Node {
    init(receiver Node, field string, value Node) {
        Receiver = receiver
        Field = field
        Value = value
    }

    init(field string, interfaceType string, value Node) {
        Field = field
        InterfaceType = interfaceType
        Value = value
    }

    prop Receiver Node {
        get;
    }

    prop InterfaceType string? {
        get;
    }

    prop Field string {
        get;
    }

    prop Value Node {
        get;
    }
}

internal open class BoundTreeRewriter {
    protected open func RewriteFieldNode(node FieldNode) Node {
        let value = node.Value
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, value) } else { FieldNode(node.Receiver, node.Field, value) }
    }
}

internal open class Replacing : BoundTreeRewriter {
    protected open override func RewriteFieldNode(node FieldNode) Node {
        return if node.InterfaceType != nil { FieldNode(node.Field, node.InterfaceType!!, Node()) } else { FieldNode(node.Receiver, node.Field, Node()) }
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(RewriterClonePreservationAnalyzer(), source)
    }

    shared {
        /// The node model the tests share: a two-form union, in the shape of
        /// `BoundFieldAssignmentExpression` — a variable-receiver form and an
        /// interface-static form, the latter leaving `Receiver` unset and
        /// carrying `InterfaceType` instead.
        private const Model string = `class Node { }

class FieldNode : Node
{
    public FieldNode(Node receiver, string field, Node value) { Receiver = receiver; Field = field; Value = value; }

    public FieldNode(string field, string interfaceType, Node value) { Field = field; InterfaceType = interfaceType; Value = value; }

    public Node Receiver { get; }

    public string InterfaceType { get; }

    public string Field { get; }

    public Node Value { get; }
}

class BoundTreeRewriter
{
    protected virtual Node RewriteFieldNode(FieldNode node)
    {
        var value = node.Value;
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, value)
            : new FieldNode(node.Receiver, node.Field, value);
    }
}`
    }
}
