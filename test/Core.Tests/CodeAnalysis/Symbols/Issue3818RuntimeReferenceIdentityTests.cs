// <copyright file="Issue3818RuntimeReferenceIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #3818, in the #3705 load-context family: a runtime reference to an
/// assembly the host has ALREADY loaded from that exact path must resolve to
/// the host's instance rather than to a second private copy.
/// <para>
/// <see cref="ReferenceResolver.WithRuntimeReferences"/> used to load every
/// path into a fresh collectible context unconditionally, so each compilation
/// in a process minted a rival identity for every type in that assembly. Any
/// <see cref="Type"/> that then crossed from one compilation into the next —
/// the binder's process-wide symbol and member caches are keyed on
/// <see cref="Type"/> and outlive a single compilation — became a
/// cross-context operand. The visible failure was order-dependent and
/// entirely opaque: closing a generic method over a type argument from one
/// copy while the receiver came from the other makes
/// <see cref="MethodInfo.MakeGenericMethod"/> throw, overload resolution drops
/// the candidate silently (C# §7.5.2), and the call reports "Cannot find
/// function &lt;name&gt;" about a method that plainly exists.
/// </para>
/// </summary>
public class Issue3818RuntimeReferenceIdentityTests
{
    private static string CorePath => typeof(SyntaxNode).Assembly.Location;

    [Fact]
    public void RuntimeReferenceToAnAlreadyLoadedAssembly_ResolvesToTheHostInstance()
    {
        using ReferenceResolver resolver = ReferenceResolver.WithRuntimeReferences(new[] { CorePath });

        Assert.True(resolver.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.SyntaxNode", out Type resolved));
        Assert.Same(typeof(SyntaxNode), resolved);
    }

    [Fact]
    public void TwoRuntimeReferenceResolversOverTheSamePath_ShareTypeIdentity()
    {
        Type receiverType;
        using (ReferenceResolver first = ReferenceResolver.WithRuntimeReferences(new[] { CorePath }))
        {
            Assert.True(first.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.SyntaxNode", out receiverType));
        }

        Type typeArgument;
        using (ReferenceResolver second = ReferenceResolver.WithRuntimeReferences(new[] { CorePath }))
        {
            Assert.True(second.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.FunctionDeclarationSyntax", out typeArgument));
        }

        Assert.Same(receiverType.Assembly, typeArgument.Assembly);

        // The exact operation that failed in #3818: the two operands reach the
        // binder from different compilations, and MakeGenericMethod is what
        // rejects them when they are not the same identity.
        MethodInfo open = receiverType.GetMethods()
            .Single(m => m.Name == nameof(SyntaxNode.FirstAncestorOrSelf) && m.IsGenericMethodDefinition);
        _ = open.MakeGenericMethod(typeArgument);
    }
}
