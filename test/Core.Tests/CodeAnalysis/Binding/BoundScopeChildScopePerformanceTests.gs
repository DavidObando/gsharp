// <copyright file="BoundScopeChildScopePerformanceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import Xunit

// Issue #1647: BoundScope used to eagerly copy the parent's ENTIRE symbolKeys,
// functionKeys, imports, typeAliases and typeAliasKeys into every child scope,
// even though name resolution already walks the Parent chain. These tests pin
// down the observable behavior (shadowing, dedup, and GetDeclared* aggregation)
// that must be preserved now that those collections are kept per-scope and
// aggregated lazily via the Parent chain.
open class BoundScopeChildScopePerformanceTests {
    @Fact
    func TryLookupSymbol_ChildDeclaration_ShadowsParent() {
        let parent = BoundScope(nil, ReferenceResolver.Default())
        let parentVar = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)
        Assert.True(parent.TryDeclareVariable(parentVar))
        let child = BoundScope(parent)
        let childVar = LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.String)
        Assert.True(child.TryDeclareVariable(childVar))
        Assert.Same(childVar, child.TryLookupSymbol("x"))
        Assert.Same(parentVar, parent.TryLookupSymbol("x"))
    }

    @Fact
    func TryDeclareVariable_DuplicateInSameScope_Fails() {
        let scope_ = BoundScope(nil, ReferenceResolver.Default())
        Assert.True(scope_.TryDeclareVariable(LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)))
        Assert.False(scope_.TryDeclareVariable(LocalVariableSymbol("x", isReadOnly: false, TypeSymbol.Int32)))
    }

    @Fact
    func GetDeclaredVariables_OnChildScope_DoesNotIncludeParentVariables() {
        // Local symbols/functions were already per-scope before #1647 (the
        // `symbols`/`functions` dictionaries were never copied); only the
        // *key lists* were eagerly duplicated. GetDeclared* must keep
        // returning scope-local declarations only.
        let parent = BoundScope(nil, ReferenceResolver.Default())
        Assert.True(parent.TryDeclareVariable(LocalVariableSymbol("outer", isReadOnly: false, TypeSymbol.Int32)))
        let child = BoundScope(parent)
        Assert.True(child.TryDeclareVariable(LocalVariableSymbol("inner", isReadOnly: false, TypeSymbol.Int32)))
        let declared = child.GetDeclaredVariables()
        Assert.Single(declared)
        Assert.Equal("inner", declared[0].Name)
    }

    @Fact
    func TryImport_And_GetDeclaredImports_AggregateAcrossScopeChain() {
        let parent = BoundScope(nil, ReferenceResolver.Default())
        let parentImport = ImportSymbol("System", "System", declaration: nil)
        Assert.True(parent.TryImport(parentImport))
        let child = BoundScope(parent)
        let childImport = ImportSymbol("System.IO", "System.IO", declaration: nil)
        Assert.True(child.TryImport(childImport))
        // Order matches the old eager copy: ancestor imports first, then this
        // scope's own, in declaration order.
        let declared = child.GetDeclaredImports()
        Assert.Equal([]ImportSymbol{parentImport, childImport}, declared)
        // Parent's own view is unaffected by the child's later import.
        Assert.Equal([]ImportSymbol{parentImport}, parent.GetDeclaredImports())
        Assert.True(child.TryLookupImport("System", out var found))
        Assert.Same(parentImport, found)
    }

    @Fact
    func TryDeclareTypeAlias_DuplicateVisibleFromParent_IsRejected() {
        // Type-alias dedup is chain-wide (unlike symbols/functions): a name
        // already visible from an ancestor scope is still a genuine duplicate.
        let parent = BoundScope(nil, ReferenceResolver.Default())
        Assert.True(parent.TryDeclareTypeAlias("MyType", TypeSymbol.Int32))
        let child = BoundScope(parent)
        Assert.False(child.TryDeclareTypeAlias("MyType", TypeSymbol.Int32))
    }

    @Fact
    func TryLookupTypeAlias_ChildScope_SeesParentAlias() {
        let parent = BoundScope(nil, ReferenceResolver.Default())
        Assert.True(parent.TryDeclareTypeAlias("MyType", TypeSymbol.Int32))
        let child = BoundScope(parent)
        Assert.True(child.TryLookupTypeAlias("MyType", out var type))
        Assert.Same(TypeSymbol.Int32, type)
    }

    @Fact
    func GetDeclaredTypeAliases_ChildScope_AggregatesParentAndOwnAliases() {
        let parent = BoundScope(nil, ReferenceResolver.Default())
        Assert.True(parent.TryDeclareTypeAlias("FromParent", TypeSymbol.Int32))
        let child = BoundScope(parent)
        Assert.True(child.TryDeclareTypeAlias("FromChild", TypeSymbol.Bool))
        let declared = child.GetDeclaredTypeAliases()
        Assert.Equal(2, declared.Count)
        Assert.Same(TypeSymbol.Int32, declared["FromParent"])
        Assert.Same(TypeSymbol.Bool, declared["FromChild"])
        // Parent's own view is unaffected by the child's later declaration.
        let parentDeclared = parent.GetDeclaredTypeAliases()
        Assert.Single(parentDeclared)
    }
}
