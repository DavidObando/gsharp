// <copyright file="Issue3826CrossCompilationTypeIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>
/// Issue #3826, in the #3705 load-context family: a CLR <see cref="Type"/> from
/// one compilation must never reach a later compilation's binder.
/// <para>
/// The carrier was <c>ImportedTypeSymbol</c>'s process-wide cache. Its outer
/// bucket is keyed by <c>type.Assembly</c> and its inner dictionary compared
/// types with <c>TypeIdentityComparer</c>, i.e. by
/// <see cref="Type.AssemblyQualifiedName"/>. Two copies of one assembly loaded
/// into two private reference contexts share that name, so the two lookups
/// collided. The outer bucket did not separate them either, because for a
/// constructed generic whose definition lives in a SHARED assembly — e.g.
/// <c>ImmutableArray&lt;SyntaxNode&gt;</c>, keyed by the host's single
/// <c>System.Collections.Immutable</c> — both compilations land in the same
/// bucket.
/// </para>
/// <para>
/// The consequence was opaque. The second compilation received the first's
/// symbol, so a loop variable bound from
/// <c>ImmutableArray&lt;SyntaxNode&gt;</c> carried the FIRST compilation's
/// <c>SyntaxNode</c> while an explicit type argument came from the second's;
/// <see cref="MethodInfo.MakeGenericMethod"/> then throws, overload resolution
/// drops the sole candidate silently (C# §7.5.2), and the call reports "Cannot
/// find function" about a method that plainly exists (#3818).
/// </para>
/// </summary>
public class Issue3826CrossCompilationTypeIdentityTests : IDisposable
{
    private readonly string workDirectory;

    /// <summary>Initializes a new instance of the <see cref="Issue3826CrossCompilationTypeIdentityTests"/> class.</summary>
    public Issue3826CrossCompilationTypeIdentityTests()
    {
        this.workDirectory = Path.Combine(
            Path.GetTempPath(), "gs-issue3826-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(this.workDirectory);

        // A copy at a path the host has not loaded is a genuinely private
        // reference: #3825's path-equality reuse does not apply, so each
        // resolver really does mint its own copy — the case #3826 says is
        // still reachable in production (a real /reference: to a user
        // assembly, cross-targeting).
        string hostDirectory = Path.GetDirectoryName(typeof(SyntaxNode).Assembly.Location)
            ?? throw new InvalidOperationException("the host assembly has a directory");
        foreach (string dll in Directory.GetFiles(hostDirectory, "*.dll"))
        {
            File.Copy(dll, Path.Combine(this.workDirectory, Path.GetFileName(dll)), overwrite: true);
        }
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        try
        {
            Directory.Delete(this.workDirectory, recursive: true);
        }
        catch (IOException)
        {
            // A best-effort cleanup; a locked file must not fail the test.
        }

        GC.SuppressFinalize(this);
    }

    [Fact]
    public void TwoPrivateReferenceContextsOverTheSamePath_ProduceDistinctTypes()
    {
        (Type first, Type second) = ResolveFromTwoPrivateContexts();

        Assert.NotSame(first, second);
        Assert.NotSame(first.Assembly, second.Assembly);

        // The two are indistinguishable by name — which is precisely why a
        // name-keyed cache aliased them.
        Assert.Equal(first.AssemblyQualifiedName, second.AssemblyQualifiedName);
    }

    [Fact]
    public void ConstructedGenericFromASharedAssembly_DoesNotAliasAcrossContexts()
    {
        (Type firstNode, Type secondNode) = ResolveFromTwoPrivateContexts();

        // ImmutableArray<T> itself comes from the host's single
        // System.Collections.Immutable, so both constructions share the cache's
        // outer per-assembly bucket; only the inner key can separate them.
        Type firstArray = typeof(ImmutableArray<>).MakeGenericType(firstNode);
        Type secondArray = typeof(ImmutableArray<>).MakeGenericType(secondNode);
        Assert.Same(firstArray.Assembly, secondArray.Assembly);
        Assert.Equal(firstArray.AssemblyQualifiedName, secondArray.AssemblyQualifiedName);

        ImportedTypeSymbol firstSymbol = ImportedTypeSymbol.Get(firstArray);
        ImportedTypeSymbol secondSymbol = ImportedTypeSymbol.Get(secondArray);

        Assert.NotSame(firstSymbol, secondSymbol);
        Assert.Same(firstArray, firstSymbol.Type);
        Assert.Same(secondArray, secondSymbol.Type);
    }

    [Fact]
    public void ACachedSymbolNeverHandsBackAnotherContextsTypeArgument()
    {
        (Type firstNode, Type secondNode) = ResolveFromTwoPrivateContexts();

        _ = ImportedTypeSymbol.Get(typeof(ImmutableArray<>).MakeGenericType(firstNode));
        ImportedTypeSymbol second = ImportedTypeSymbol.Get(
            typeof(ImmutableArray<>).MakeGenericType(secondNode));

        Type element = second.Type.GetGenericArguments().Single();
        Assert.Same(secondNode, element);

        // The operation #3818 died on: the receiver's type and the explicit
        // type argument must be closable together.
        MethodInfo open = element.GetMethods()
            .Single(m => m.Name == nameof(SyntaxNode.FirstAncestorOrSelf) && m.IsGenericMethodDefinition);
        Type argument = element.Assembly.GetType(
            "GSharp.Core.CodeAnalysis.Syntax.FunctionDeclarationSyntax", throwOnError: true)
            ?? throw new InvalidOperationException("the copy declares FunctionDeclarationSyntax");
        _ = open.MakeGenericMethod(argument);
    }

    private (Type First, Type Second) ResolveFromTwoPrivateContexts()
    {
        string corePath = Path.Combine(this.workDirectory, "GSharp.Core.dll");

        Type first;
        using (ReferenceResolver resolver = ReferenceResolver.WithRuntimeReferences(new[] { corePath }))
        {
            Assert.True(resolver.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.SyntaxNode", out first));
        }

        Type second;
        using (ReferenceResolver resolver = ReferenceResolver.WithRuntimeReferences(new[] { corePath }))
        {
            Assert.True(resolver.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.SyntaxNode", out second));
        }

        return (first, second);
    }
}
