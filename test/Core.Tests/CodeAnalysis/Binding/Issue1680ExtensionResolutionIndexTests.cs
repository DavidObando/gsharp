// <copyright file="Issue1680ExtensionResolutionIndexTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1680: <see cref="BoundScope"/> used to resolve every extension-function
/// call site by scanning the FULL flat extension list of every scope in the
/// chain (an O(callsites x extensions) full scan, plus an O(E^2) inner pass in
/// the subtype-specificity ranking). The fix buckets declared extensions by
/// name per scope so a call site probes only the candidates that share its
/// method name, then runs the exact same receiver-matching logic (identity/CLR
/// equality, generic-receiver unification, implicit-conversion subtyping) over
/// that narrowed set. These tests pin down that the narrowed lookup still finds
/// every extension shape the old full scan found: via a base class, via an
/// implemented interface, via generic-receiver unification, and with the same
/// scope-priority (innermost-first) order when two scopes both declare a
/// same-named extension.
/// </summary>
public class Issue1680ExtensionResolutionIndexTests
{
    [Fact]
    public void Extension_OnBaseClass_Dispatches_ViaDerivedReceiver()
    {
        // Issue #1548 subtype-convertibility pass: an extension declared on the
        // BASE class must still be found for a call site whose static receiver
        // type is the DERIVED class. Receiver-clause methods are reserved for
        // types the extension's own package doesn't own (ADR-0079), so the
        // types and the extension live in separate packages, like the
        // pre-existing cross-package extension tests.
        var typeTree = SyntaxTree.Parse(SourceText.From(@"
package Zoo
open class Animal { var Name string }
class Dog : Animal { }
"));
        var extensionTree = SyntaxTree.Parse(SourceText.From(@"
package ZooExtensions
func (a Animal) Speak() string {
    return ""...""
}

var d = Dog{Name: ""Rex""}
d.Speak()
"));
        var result = Evaluate(typeTree, extensionTree);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("...", result.Value);
    }

    [Fact]
    public void Extension_OnInterface_Dispatches_ViaImplementingReceiver()
    {
        // An extension declared on an INTERFACE must be found for a call site
        // whose static receiver type is a class that implements it.
        var typeTree = SyntaxTree.Parse(SourceText.From(@"
package Greeting
interface IGreeter {
    func Hello() string;
}
class Person : IGreeter {
    func Hello() string -> ""hi""
}
"));
        var extensionTree = SyntaxTree.Parse(SourceText.From(@"
package GreetingExtensions
func (g IGreeter) Greet() string {
    return g.Hello()
}

var p = Person{}
p.Greet()
"));
        var result = Evaluate(typeTree, extensionTree);
        Assert.Empty(result.Diagnostics);
        Assert.Equal("hi", result.Value);
    }

    [Fact]
    public void Extension_GenericReceiver_Unifies_OnConcreteInstantiation()
    {
        // Issue #773 generic-receiver unification pass: the declared receiver
        // carries the function's own type parameter, so it is never
        // reference-equal to the concrete call-site receiver and must be found
        // via unification, not identity.
        const string source = @"
package P
import System
import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T any](fb T) T {
    return fb
}

var arr = []int32{10, 20, 30}
arr.MyFirst(99)
";
        var result = Evaluate(source);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(99, result.Value);
    }

    [Fact]
    public void Extension_DeclaredInTwoScopes_InnerScopeWins()
    {
        // Scope-priority / shadowing: TryLookupExtensionFunction walks from
        // `this` outward to Parent, returning the FIRST matching scope. The
        // name-keyed index must preserve this order — a child scope's
        // same-named extension must win over the parent's, exactly like the
        // old full linear scan (which iterated the same scope chain).
        var parent = new BoundScope(null, ReferenceResolver.Default());
        var parentExtension = MakeExtension("Speak", TypeSymbol.Int32, TypeSymbol.String);
        Assert.True(parent.TryDeclareExtensionFunction(parentExtension));

        var child = new BoundScope(parent);
        var childExtension = MakeExtension("Speak", TypeSymbol.Int32, TypeSymbol.String);
        Assert.True(child.TryDeclareExtensionFunction(childExtension));

        Assert.True(child.TryLookupExtensionFunction(TypeSymbol.Int32, "Speak", out var found));
        Assert.Same(childExtension, found);

        // Looked up directly from the parent scope, only the parent's
        // extension is visible.
        Assert.True(parent.TryLookupExtensionFunction(TypeSymbol.Int32, "Speak", out var foundFromParent));
        Assert.Same(parentExtension, foundFromParent);
    }

    [Fact]
    public void Extension_UnrelatedNameInSameScope_DoesNotMatch()
    {
        // The name-keyed bucket must not leak candidates across different
        // names sharing a scope.
        var scope = new BoundScope(null, ReferenceResolver.Default());
        Assert.True(scope.TryDeclareExtensionFunction(MakeExtension("Foo", TypeSymbol.Int32, TypeSymbol.String)));
        Assert.True(scope.TryDeclareExtensionFunction(MakeExtension("Bar", TypeSymbol.Int32, TypeSymbol.String)));

        Assert.False(scope.TryLookupExtensionFunction(TypeSymbol.Int32, "Baz", out var found));
        Assert.Null(found);

        Assert.True(scope.TryLookupExtensionFunction(TypeSymbol.Int32, "Foo", out var foo));
        Assert.Equal("Foo", foo.Name);
    }

    private static FunctionSymbol MakeExtension(string name, TypeSymbol receiverType, TypeSymbol returnType)
    {
        var function = new FunctionSymbol(
            name,
            ImmutableArray<ParameterSymbol>.Empty,
            returnType,
            declaration: null,
            package: null,
            accessibility: Accessibility.Public);
        function.IsExtension = true;
        function.ExtensionReceiverType = receiverType;
        return function;
    }

    private static EvaluationResult Evaluate(string source)
    {
        var syntaxTree = SyntaxTree.Parse(SourceText.From(source));
        return Evaluate(syntaxTree);
    }

    private static EvaluationResult Evaluate(params SyntaxTree[] syntaxTrees)
    {
        var compilation = new Compilation(syntaxTrees);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
