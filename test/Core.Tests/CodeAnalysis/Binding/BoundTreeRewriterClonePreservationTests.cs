// <copyright file="BoundTreeRewriterClonePreservationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #1644: <see cref="BoundTreeRewriter"/> clone
/// paths must not silently drop properties the binder sets after
/// construction (or via an alternate constructor) when they rebuild a node
/// whose children changed. Each test forces a clone via a rewriter subclass
/// that always constructs a fresh leaf node, then asserts the rebuilt parent
/// still carries the extra state.
/// </summary>
public class BoundTreeRewriterClonePreservationTests
{
    /// <summary>A no-op rewriter that always replaces literal expressions with an equivalent new instance, forcing every ancestor to clone.</summary>
    private sealed class ForceCloneRewriter : BoundTreeRewriter
    {
        public new BoundExpression RewriteExpression(BoundExpression node) => base.RewriteExpression(node);

        protected override BoundExpression RewriteLiteralExpression(BoundLiteralExpression node)
        {
            return new BoundLiteralExpression(node.Syntax, node.Value);
        }
    }

    [Fact]
    public void RewriteCallExpression_PreservesStaticGenericOwnerType()
    {
        // Arrange: Box[int32].Make() — static call parented at a constructed generic struct's TypeSpec (#1209).
        var function = new FunctionSymbol("Make", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int32);
        var owner = new StructSymbol("Box", ImmutableArray<FieldSymbol>.Empty, Accessibility.Public, declaration: null, packageName: "main");
        var arg = new BoundLiteralExpression(null, 1);
        var call = new BoundCallExpression(null, function, ImmutableArray.Create<BoundExpression>(arg), returnType: null)
        {
            StaticGenericOwnerType = owner,
        };

        // Act
        var result = (BoundCallExpression)new ForceCloneRewriter().RewriteExpression(call);

        // Assert: a clone actually happened (argument was rebuilt) and the owner type survived.
        Assert.NotSame(call, result);
        Assert.Same(owner, result.StaticGenericOwnerType);
        Assert.Null(result.StaticGenericInterfaceOwnerType);
    }

    [Fact]
    public void RewriteCallExpression_PreservesStaticGenericInterfaceOwnerType()
    {
        // Arrange: IBox[int32].Create() — static call parented at a constructed generic interface's TypeSpec (#1433).
        var function = new FunctionSymbol("Create", ImmutableArray<ParameterSymbol>.Empty, TypeSymbol.Int32);
        var owner = new InterfaceSymbol("IBox", Accessibility.Public, declaration: null, packageName: "main");
        var arg = new BoundLiteralExpression(null, 1);
        var call = new BoundCallExpression(null, function, ImmutableArray.Create<BoundExpression>(arg), returnType: null)
        {
            StaticGenericInterfaceOwnerType = owner,
        };

        // Act
        var result = (BoundCallExpression)new ForceCloneRewriter().RewriteExpression(call);

        // Assert
        Assert.NotSame(call, result);
        Assert.Same(owner, result.StaticGenericInterfaceOwnerType);
        Assert.Null(result.StaticGenericOwnerType);
    }

    [Fact]
    public void RewriteFieldAssignmentExpression_PreservesInterfaceStaticField()
    {
        // Arrange: an interface static field write (ADR-0089 / #1030) — built via
        // the (syntax, field, interfaceType, value) constructor: Receiver and
        // StructType are both null, InterfaceType carries the owning interface.
        var interfaceType = new InterfaceSymbol("IBox", Accessibility.Public, declaration: null, packageName: "main");
        var field = new FieldSymbol("Count", TypeSymbol.Int32, Accessibility.Public, isStatic: true);
        var value = new BoundLiteralExpression(null, 42);
        var assignment = new BoundFieldAssignmentExpression(null, field, interfaceType, value);

        // Act
        var result = (BoundFieldAssignmentExpression)new ForceCloneRewriter().RewriteExpression(assignment);

        // Assert: clone happened (value rebuilt) and the interface-static routing survived.
        Assert.NotSame(assignment, result);
        Assert.Same(interfaceType, result.InterfaceType);
        Assert.Null(result.Receiver);
        Assert.Null(result.StructType);
        Assert.Null(result.ReceiverExpression);
    }
}
