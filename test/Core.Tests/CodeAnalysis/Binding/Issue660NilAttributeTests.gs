// <copyright file="Issue660NilAttributeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #660: tests for nil/null behaviour in attribute arguments.
open class Issue660NilAttributeTests {
    @Fact
    func Nil_In_Obsolete_Attribute_Succeeds() {
        // nil as a string argument to @Obsolete should work since string accepts null.
        let source = `import System

@Obsolete(nil)
func Helper() {
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        Assert.Empty(globalScope.Diagnostics)
    }

    @Fact
    func Null_Identifier_Reports_GS0273_Instead_Of_GS0125() {
        // Using C# spelling 'null' should produce GS0273 (friendly "use nil" message)
        // instead of the generic GS0125 "Variable 'null' doesn't exist".
        let source = `import System

@Obsolete(null)
func Helper() {
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        let diags = globalScope.Diagnostics.ToList()
        Assert.Contains(diags, (d Diagnostic) -> d.Id == "GS0273")
        Assert.DoesNotContain(diags, (d Diagnostic) -> d.Id == "GS0125")
    }

    @Fact
    func Null_Identifier_Message_Suggests_Nil() {
        let source = `import System

@Obsolete(null)
func Helper() {
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        let diag = globalScope.Diagnostics.First((d Diagnostic) -> d.Id == "GS0273")
        Assert.Contains("nil", diag.Message)
    }

    @Fact
    func Nil_In_Attribute_ParamsArray_Succeeds() {
        // nil in a params string[] attribute arg (like @MemberNotNull)
        let source = `import System.Diagnostics.CodeAnalysis

class Box {
    @MemberNotNull(nil)
    func Setup() {
    }
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        Assert.Empty(globalScope.Diagnostics)
    }

    shared {
        private func BindSource(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
