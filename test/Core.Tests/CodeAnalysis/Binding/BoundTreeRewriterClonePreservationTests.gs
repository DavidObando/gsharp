// <copyright file="BoundTreeRewriterClonePreservationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System.Collections.Immutable
import Xunit

/// Regression tests for issue #1644: (cref:BoundTreeRewriter) clone
/// paths must not silently drop properties the binder sets after
/// construction (or via an alternate constructor) when they rebuild a node
/// whose children changed. Each test forces a clone via a rewriter subclass
/// that always constructs a fresh leaf node, then asserts the rebuilt parent
/// still carries the extra state.
open class BoundTreeRewriterClonePreservationTests {
    /// A no-op rewriter that always replaces literal expressions with an equivalent new instance, forcing
    /// every ancestor to clone.
    private class ForceCloneRewriter : BoundTreeRewriter {
        func RewriteExpression(node BoundExpression) BoundExpression -> base.RewriteExpression(node)

        protected override func RewriteLiteralExpression(node BoundLiteralExpression) BoundExpression {
            return BoundLiteralExpression(node.Syntax, node.Value)
        }
    }

    @Fact
    func RewriteCallExpression_PreservesStaticGenericOwnerType() {
        // Arrange: Box[int32].Make() — static call parented at a constructed generic struct's TypeSpec (#1209).
        let function = FunctionSymbol("Make", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let owner = StructSymbol(
            "Box",
            ImmutableArray[FieldSymbol].Empty,
            Accessibility.Public,
            declaration: nil,
            packageName: "main"
        )
        let arg = BoundLiteralExpression(nil, 1)
        let call = BoundCallExpression(nil, function, ImmutableArray.Create[BoundExpression](arg), returnType: nil){
            StaticGenericOwnerType = owner
        }
        // Act
        let result = cast[BoundCallExpression](ForceCloneRewriter().RewriteExpression(call))
        // Assert: a clone actually happened (argument was rebuilt) and the owner type survived.
        Assert.NotSame(call, result)
        Assert.Same(owner, result.StaticGenericOwnerType)
        Assert.Null(result.StaticGenericInterfaceOwnerType)
    }

    @Fact
    func RewriteCallExpression_PreservesStaticGenericInterfaceOwnerType() {
        // Arrange: IBox[int32].Create() — static call parented at a constructed generic interface's TypeSpec (#1433).
        let function = FunctionSymbol("Create", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Int32)
        let owner = InterfaceSymbol("IBox", Accessibility.Public, declaration: nil, packageName: "main")
        let arg = BoundLiteralExpression(nil, 1)
        let call = BoundCallExpression(nil, function, ImmutableArray.Create[BoundExpression](arg), returnType: nil){
            StaticGenericInterfaceOwnerType = owner
        }
        // Act
        let result = cast[BoundCallExpression](ForceCloneRewriter().RewriteExpression(call))
        // Assert
        Assert.NotSame(call, result)
        Assert.Same(owner, result.StaticGenericInterfaceOwnerType)
        Assert.Null(result.StaticGenericOwnerType)
    }

    @Fact
    func RewriteFieldAssignmentExpression_PreservesInterfaceStaticField() {
        // Arrange: an interface static field write (ADR-0089 / #1030) — built via
        // the (syntax, field, interfaceType, value) constructor: Receiver and
        // StructType are both null, InterfaceType carries the owning interface.
        let interfaceType = InterfaceSymbol("IBox", Accessibility.Public, declaration: nil, packageName: "main")
        let field = FieldSymbol("Count", TypeSymbol.Int32, Accessibility.Public, isStatic: true)
        let value = BoundLiteralExpression(nil, 42)
        let assignment = BoundFieldAssignmentExpression(nil, field, interfaceType, value)
        // Act
        let result = cast[BoundFieldAssignmentExpression](ForceCloneRewriter().RewriteExpression(assignment))
        // Assert: clone happened (value rebuilt) and the interface-static routing survived.
        Assert.NotSame(assignment, result)
        Assert.Same(interfaceType, result.InterfaceType)
        Assert.Null(result.Receiver)
        Assert.Null(result.StructType)
        Assert.Null(result.ReceiverExpression)
    }
}
