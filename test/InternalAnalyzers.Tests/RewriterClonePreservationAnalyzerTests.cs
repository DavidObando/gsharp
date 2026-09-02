// <copyright file="RewriterClonePreservationAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Threading.Tasks;
using Xunit;

namespace GSharp.InternalAnalyzers.Tests;

/// <summary>
/// GSA0005 guards the shape behind issues #1644 and #3333: a
/// <c>BoundTreeRewriter</c> override that rebuilds its node through a
/// constructor that silently omits a member the base rewriter carries.
/// </summary>
public sealed class RewriterClonePreservationAnalyzerTests
{
    /// <summary>
    /// The node model the tests share: a two-form union, in the shape of
    /// <c>BoundFieldAssignmentExpression</c> — a variable-receiver form and an
    /// interface-static form, the latter leaving <c>Receiver</c> unset and
    /// carrying <c>InterfaceType</c> instead.
    /// </summary>
    private const string Model = """
class Node { }

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
}
""";

    [Fact]
    public Task ReportsAnOverrideThatRebuildsWithoutTheDiscriminator()
    {
        // The #1644 / #3333 shape exactly: the override rebuilds through the
        // variable-receiver constructor on every path, so an interface-static
        // node silently loses InterfaceType.
        string source = Model + """

class Broken : BoundTreeRewriter
{
    protected override Node [|RewriteFieldNode|](FieldNode node)
    {
        return new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source, "GSA0005");
    }

    [Fact]
    public Task AcceptsAnOverrideThatBranchesOnTheDiscriminator()
    {
        string source = Model + """

class Fixed : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, node.Value)
            : new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source);
    }

    [Fact]
    public Task AcceptsAnOverrideThatDoesNotRebuild()
    {
        // Delegating or returning the node unchanged cannot drop anything.
        string source = Model + """

class Delegating : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.Field == "skip" ? node : base.RewriteFieldNode(node);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source);
    }

    [Fact]
    public Task DelegatingOnOnePathDoesNotExcuseDroppingOnAnother()
    {
        // The regression that made this rule worth having: an override with a
        // `base` fallback still has to preserve members on the path it rebuilds.
        string source = Model + """

class PartlyDelegating : BoundTreeRewriter
{
    protected override Node [|RewriteFieldNode|](FieldNode node)
    {
        if (node.Field == "skip")
        {
            return base.RewriteFieldNode(node);
        }

        return new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source, "GSA0005");
    }

    [Fact]
    public Task AcceptsReadsReachedThroughAHelper()
    {
        // Lowering/BoundNodeForm.cs extracts a recurring union invariant into a
        // helper; the members it reads still count as preserved.
        string source = Model + """

class ViaHelper : BoundTreeRewriter
{
    private static string Discriminator(FieldNode node) => node.InterfaceType;

    protected override Node RewriteFieldNode(FieldNode node)
    {
        var owner = Discriminator(node);
        return owner != null
            ? new FieldNode(node.Field, owner, node.Value)
            : new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source);
    }

    [Fact]
    public Task AcceptsReadsReachedThroughAQualifiedStaticHelper()
    {
        // The shape the compiler actually uses: Lowering/BoundNodeForm.cs is a
        // separate static class, so the hop is a QUALIFIED call
        // (`BoundNodeForm.DeclaringType(node)`), not a bare one. Issue #3822 --
        // G# splits a qualified call across two syntax nodes and the semantic
        // model answered for only one of them, so the migrated analyzer
        // reported five methods Roslyn does not.
        string source = Model + """

static class Form
{
    public static string Discriminator(FieldNode node) => node.InterfaceType;
}

class ViaQualifiedHelper : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        var owner = Form.Discriminator(node);
        return owner != null
            ? new FieldNode(node.Field, owner, node.Value)
            : new FieldNode(node.Receiver, node.Field, node.Value);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source);
    }

    [Fact]
    public Task AQualifiedStaticHelperThatReadsSomethingElseStillReports()
    {
        // The negative's twin, on the same FollowHelper path: the qualified
        // helper resolves and is followed, but it reads Field rather than the
        // discriminator, so the drop is still reported. An analyzer that
        // silenced the qualified-helper shape wholesale -- or that stopped
        // resolving qualified calls again -- fails here rather than passing
        // quietly.
        string source = Model + """

static class OtherForm
{
    public static string Label(FieldNode node) => node.Field;
}

class ViaWrongQualifiedHelper : BoundTreeRewriter
{
    protected override Node [|RewriteFieldNode|](FieldNode node)
    {
        var label = OtherForm.Label(node);
        return new FieldNode(node.Receiver, label, node.Value);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source, "GSA0005");
    }

    [Fact]
    public Task AcceptsReadsThroughTheRewrittenBaseResult()
    {
        // `var rewritten = (T)base.RewriteX(node);` makes `rewritten` the node's
        // stand-in, so members read off it are preserved.
        string source = Model + """

class ViaBaseResult : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        var rewritten = (FieldNode)base.RewriteFieldNode(node);
        return rewritten.InterfaceType != null
            ? new FieldNode(rewritten.Field, rewritten.InterfaceType, rewritten.Value)
            : new FieldNode(rewritten.Receiver, rewritten.Field, rewritten.Value);
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source);
    }

    [Fact]
    public Task IgnoresMembersEveryConstructorRequires()
    {
        // An override that replaces the node with a different shape is a design
        // choice, not a silent drop: a member no constructor can omit is never
        // reported. Here Value is required by both forms.
        string source = Model + """

class Replacing : BoundTreeRewriter
{
    protected override Node RewriteFieldNode(FieldNode node)
    {
        return node.InterfaceType != null
            ? new FieldNode(node.Field, node.InterfaceType, new Node())
            : new FieldNode(node.Receiver, node.Field, new Node());
    }
}
""";

        return AnalyzerTestHelper.AssertDiagnosticsAsync(new RewriterClonePreservationAnalyzer(), source);
    }
}
