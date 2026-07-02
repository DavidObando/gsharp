// <copyright file="BoundScopeChildScopePerformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

// Issue #1647: BoundScope used to eagerly copy the parent's ENTIRE symbolKeys,
// functionKeys, imports, typeAliases and typeAliasKeys into every child scope,
// even though name resolution already walks the Parent chain. These tests pin
// down the observable behavior (shadowing, dedup, and GetDeclared* aggregation)
// that must be preserved now that those collections are kept per-scope and
// aggregated lazily via the Parent chain.
public class BoundScopeChildScopePerformanceTests
{
    [Fact]
    public void TryLookupSymbol_ChildDeclaration_ShadowsParent()
    {
        var parent = new BoundScope(null, ReferenceResolver.Default());
        var parentVar = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32);
        Assert.True(parent.TryDeclareVariable(parentVar));

        var child = new BoundScope(parent);
        var childVar = new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.String);
        Assert.True(child.TryDeclareVariable(childVar));

        Assert.Same(childVar, child.TryLookupSymbol("x"));
        Assert.Same(parentVar, parent.TryLookupSymbol("x"));
    }

    [Fact]
    public void TryDeclareVariable_DuplicateInSameScope_Fails()
    {
        var scope = new BoundScope(null, ReferenceResolver.Default());
        Assert.True(scope.TryDeclareVariable(new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)));
        Assert.False(scope.TryDeclareVariable(new LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)));
    }

    [Fact]
    public void GetDeclaredVariables_OnChildScope_DoesNotIncludeParentVariables()
    {
        // Local symbols/functions were already per-scope before #1647 (the
        // `symbols`/`functions` dictionaries were never copied); only the
        // *key lists* were eagerly duplicated. GetDeclared* must keep
        // returning scope-local declarations only.
        var parent = new BoundScope(null, ReferenceResolver.Default());
        Assert.True(parent.TryDeclareVariable(new LocalVariableSymbol("outer", isReadOnly: false, TypeSymbol.Int32)));

        var child = new BoundScope(parent);
        Assert.True(child.TryDeclareVariable(new LocalVariableSymbol("inner", isReadOnly: false, TypeSymbol.Int32)));

        var declared = child.GetDeclaredVariables();
        Assert.Single(declared);
        Assert.Equal("inner", declared[0].Name);
    }

    [Fact]
    public void TryImport_And_GetDeclaredImports_AggregateAcrossScopeChain()
    {
        var parent = new BoundScope(null, ReferenceResolver.Default());
        var parentImport = new ImportSymbol("System", "System", declaration: null);
        Assert.True(parent.TryImport(parentImport));

        var child = new BoundScope(parent);
        var childImport = new ImportSymbol("System.IO", "System.IO", declaration: null);
        Assert.True(child.TryImport(childImport));

        // Order matches the old eager copy: ancestor imports first, then this
        // scope's own, in declaration order.
        var declared = child.GetDeclaredImports();
        Assert.Equal(new[] { parentImport, childImport }, declared);

        // Parent's own view is unaffected by the child's later import.
        Assert.Equal(new[] { parentImport }, parent.GetDeclaredImports());

        Assert.True(child.TryLookupImport("System", out var found));
        Assert.Same(parentImport, found);
    }

    [Fact]
    public void TryDeclareTypeAlias_DuplicateVisibleFromParent_IsRejected()
    {
        // Type-alias dedup is chain-wide (unlike symbols/functions): a name
        // already visible from an ancestor scope is still a genuine duplicate.
        var parent = new BoundScope(null, ReferenceResolver.Default());
        Assert.True(parent.TryDeclareTypeAlias("MyType", TypeSymbol.Int32));

        var child = new BoundScope(parent);
        Assert.False(child.TryDeclareTypeAlias("MyType", TypeSymbol.Int32));
    }

    [Fact]
    public void TryLookupTypeAlias_ChildScope_SeesParentAlias()
    {
        var parent = new BoundScope(null, ReferenceResolver.Default());
        Assert.True(parent.TryDeclareTypeAlias("MyType", TypeSymbol.Int32));

        var child = new BoundScope(parent);

        Assert.True(child.TryLookupTypeAlias("MyType", out var type));
        Assert.Same(TypeSymbol.Int32, type);
    }

    [Fact]
    public void GetDeclaredTypeAliases_ChildScope_AggregatesParentAndOwnAliases()
    {
        var parent = new BoundScope(null, ReferenceResolver.Default());
        Assert.True(parent.TryDeclareTypeAlias("FromParent", TypeSymbol.Int32));

        var child = new BoundScope(parent);
        Assert.True(child.TryDeclareTypeAlias("FromChild", TypeSymbol.Bool));

        var declared = child.GetDeclaredTypeAliases();
        Assert.Equal(2, declared.Count);
        Assert.Same(TypeSymbol.Int32, declared["FromParent"]);
        Assert.Same(TypeSymbol.Bool, declared["FromChild"]);

        // Parent's own view is unaffected by the child's later declaration.
        var parentDeclared = parent.GetDeclaredTypeAliases();
        Assert.Single(parentDeclared);
    }
}
