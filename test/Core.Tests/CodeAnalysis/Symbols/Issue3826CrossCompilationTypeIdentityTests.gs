// <copyright file="Issue3826CrossCompilationTypeIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #3826, in the #3705 load-context family: a CLR (cref:Type) from
/// one compilation must never reach a later compilation's binder.
///
/// The carrier was `ImportedTypeSymbol`'s process-wide cache. Its outer
/// bucket is keyed by `type.Assembly` and its inner dictionary compared
/// types with `TypeIdentityComparer`, i.e. by
/// (cref:Type.AssemblyQualifiedName). Two copies of one assembly loaded
/// into two private reference contexts share that name, so the two lookups
/// collided. The outer bucket did not separate them either, because for a
/// constructed generic whose definition lives in a SHARED assembly — e.g.
/// `ImmutableArray<SyntaxNode>`, keyed by the host's single
/// `System.Collections.Immutable` — both compilations land in the same
/// bucket.
///
/// The consequence was opaque. The second compilation received the first's
/// symbol, so a loop variable bound from
/// `ImmutableArray<SyntaxNode>` carried the FIRST compilation's
/// `SyntaxNode` while an explicit type argument came from the second's;
/// (cref:MethodInfo.MakeGenericMethod) then throws, overload resolution
/// drops the sole candidate silently (C# §7.5.2), and the call reports "Cannot
/// find function" about a method that plainly exists (#3818).
open class Issue3826CrossCompilationTypeIdentityTests : IDisposable {
    private let workDirectory string

    /// Initializes a new instance of the (cref:Issue3826CrossCompilationTypeIdentityTests) class.
    init() {
        this.workDirectory = Path.Combine(Path.GetTempPath(), "gs-issue3826-" + Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(this.workDirectory)
        // A copy at a path the host has not loaded is a genuinely private
        // reference: #3825's path-equality reuse does not apply, so each
        // resolver really does mint its own copy — the case #3826 says is
        // still reachable in production (a real /reference: to a user
        // assembly, cross-targeting).
        let hostDirectory = Path.GetDirectoryName(typeof(SyntaxNode).Assembly.Location) ??
            throw InvalidOperationException("the host assembly has a directory")
        for dll in Directory.GetFiles(hostDirectory, "*.dll") {
            File.Copy(dll, Path.Combine(this.workDirectory, Path.GetFileName(dll)), overwrite: true)
        }
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Dispose() {
        try {
            Directory.Delete(this.workDirectory, recursive: true)
        } catch (IOException) {
            // A best-effort cleanup; a locked file must not fail the test.

        }
        GC.SuppressFinalize(this)
    }

    @Fact
    func TwoPrivateReferenceContextsOverTheSamePath_ProduceDistinctTypes() {
        let (first, second) = ResolveFromTwoPrivateContexts()
        Assert.NotSame(first, second)
        Assert.NotSame(first.Assembly, second.Assembly)
        // The two are indistinguishable by name — which is precisely why a
        // name-keyed cache aliased them.
        Assert.Equal(first.AssemblyQualifiedName, second.AssemblyQualifiedName)
    }

    @Fact
    func ConstructedGenericFromASharedAssembly_DoesNotAliasAcrossContexts() {
        let (firstNode, secondNode) = ResolveFromTwoPrivateContexts()
        // ImmutableArray<T> itself comes from the host's single
        // System.Collections.Immutable, so both constructions share the cache's
        // outer per-assembly bucket; only the inner key can separate them.
        let firstArray = typeof(ImmutableArray[_]).MakeGenericType(firstNode)
        let secondArray = typeof(ImmutableArray[_]).MakeGenericType(secondNode)
        Assert.Same(firstArray.Assembly, secondArray.Assembly)
        Assert.Equal(firstArray.AssemblyQualifiedName, secondArray.AssemblyQualifiedName)
        let firstSymbol = ImportedTypeSymbol.Get(firstArray)
        let secondSymbol = ImportedTypeSymbol.Get(secondArray)
        Assert.NotSame(firstSymbol, secondSymbol)
        Assert.Same(firstArray, firstSymbol.Type)
        Assert.Same(secondArray, secondSymbol.Type)
    }

    @Fact
    func ACachedSymbolNeverHandsBackAnotherContextsTypeArgument() {
        let (firstNode, secondNode) = ResolveFromTwoPrivateContexts()
        let _ = ImportedTypeSymbol.Get(typeof(ImmutableArray[_]).MakeGenericType(firstNode))
        let second = ImportedTypeSymbol.Get(typeof(ImmutableArray[_]).MakeGenericType(secondNode))
        let element = second.Type.GetGenericArguments().Single()
        Assert.Same(secondNode, element)
        // The operation #3818 died on: the receiver's type and the explicit
        // type argument must be closable together.
        let open_ = element.GetMethods().Single(
            (m MethodInfo) -> m.Name == "FirstAncestorOrSelf" && m.IsGenericMethodDefinition
        )
        let argument = element.Assembly.GetType(
            "GSharp.Core.CodeAnalysis.Syntax.FunctionDeclarationSyntax",
            throwOnError: true
        ) ??
            throw InvalidOperationException("the copy declares FunctionDeclarationSyntax")
        let _ = open_.MakeGenericMethod(argument)
    }

    private func ResolveFromTwoPrivateContexts()(First Type, Second Type) {
        let corePath = Path.Combine(this.workDirectory, "GSharp.Core.dll")
        var first Type
        {
            using let resolver = ReferenceResolver.WithRuntimeReferences([]string{corePath})
            Assert.True(resolver.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.SyntaxNode", out first))
        }
        var second Type
        {
            using let resolver = ReferenceResolver.WithRuntimeReferences([]string{corePath})
            Assert.True(resolver.TryResolveType("GSharp.Core.CodeAnalysis.Syntax.SyntaxNode", out second))
        }
        return (first, second)
    }
}
