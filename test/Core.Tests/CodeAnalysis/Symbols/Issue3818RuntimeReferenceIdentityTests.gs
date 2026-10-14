// <copyright file="Issue3818RuntimeReferenceIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Linq
import System.Reflection
import Xunit

/// Issue #3818, in the #3705 load-context family: a runtime reference to an
/// assembly the host has ALREADY loaded from that exact path must resolve to
/// the host's instance rather than to a second private copy.
///
/// (cref:ReferenceResolver.WithRuntimeReferences) used to load every
/// path into a fresh collectible context unconditionally, so each compilation
/// in a process minted a rival identity for every type in that assembly. Any
/// (cref:Type) that then crossed from one compilation into the next —
/// the binder's process-wide symbol and member caches are keyed on
/// (cref:Type) and outlive a single compilation — became a
/// cross-context operand. The visible failure was order-dependent and
/// entirely opaque: closing a generic method over a type argument from one
/// copy while the receiver came from the other makes
/// (cref:MethodInfo.MakeGenericMethod) throw, overload resolution drops
/// the candidate silently (C# §7.5.2), and the call reports "Cannot find
/// function <name>" about a method that plainly exists.
open class Issue3818RuntimeReferenceIdentityTests {
    @Fact
    func RuntimeReferenceToAnAlreadyLoadedAssembly_ResolvesToTheHostInstance() {
        using let resolver = ReferenceResolver.WithRuntimeReferences([]string{CorePath})
        Assert.True(resolver.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.SyntaxNode", out var resolved))
        Assert.Same(typeof(SyntaxNode), resolved)
    }

    @Fact
    func TwoRuntimeReferenceResolversOverTheSamePath_ShareTypeIdentity() {
        var receiverType Type
        {
            using let first = ReferenceResolver.WithRuntimeReferences([]string{CorePath})
            Assert.True(first.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.SyntaxNode", out receiverType))
        }
        var typeArgument Type
        {
            using let second = ReferenceResolver.WithRuntimeReferences([]string{CorePath})
            Assert.True(
                second.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.FunctionDeclarationSyntax", out typeArgument)
            )
        }
        Assert.Same(receiverType.Assembly, typeArgument.Assembly)
        // The exact operation that failed in #3818: the two operands reach the
        // binder from different compilations, and MakeGenericMethod is what
        // rejects them when they are not the same identity.
        let open_ = receiverType.GetMethods().Single(
            (m MethodInfo) -> m.Name == "FirstAncestorOrSelf" && m.IsGenericMethodDefinition
        )
        let _ = open_.MakeGenericMethod(typeArgument)
    }

    shared {
        private prop CorePath string -> typeof(SyntaxNode).Assembly.Location
    }
}
