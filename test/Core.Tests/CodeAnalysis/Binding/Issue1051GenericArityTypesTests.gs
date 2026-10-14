// <copyright file="Issue1051GenericArityTypesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Linq
import Xunit

/// Issue #1051: C#/CLR key types by (simple name, generic arity), so a type and
/// a same-named generic of a different arity — `Foo` and `Foo[T]`,
/// mirroring `Task`/`Task<T>` — coexist as distinct types. The
/// binder must not report GS0102 ("already declared") for that pair, must resolve
/// a reference to the type matching the supplied number of type arguments, and
/// must still report GS0102 for a genuine duplicate (same name AND same arity).
open class Issue1051GenericArityTypesTests {
    @Fact
    func ClassAndSameNamedGeneric_DifferentArity_BindsWithNoDiagnostics() {
        const source = `package p
open class Mp4Operation { }
open class Mp4Operation[TOutput] : Mp4Operation { }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ClassAndSameNamedGeneric_BothSymbolsAreDeclared() {
        const source = `package p
open class Mp4Operation { }
open class Mp4Operation[TOutput] : Mp4Operation { }`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let byName = compilation.GlobalScope.Structs.Where((s StructSymbol) -> s.Name == "Mp4Operation").ToList()
        Assert.Equal(2, byName.Count)
        Assert.Contains(byName, (s StructSymbol) -> s.TypeParameters.Length == 0)
        Assert.Contains(byName, (s StructSymbol) -> s.TypeParameters.Length == 1)
        // The generic's base type resolves to the arity-0 type.
        let generic = byName.Single((s StructSymbol) -> s.TypeParameters.Length == 1)
        let baseClass StructSymbol? = generic.BaseClass
        Assert.NotNull(baseClass)
        Assert.Equal("Mp4Operation", baseClass!!.Name)
        Assert.Empty(baseClass!!.TypeParameters)
    }

    @Fact
    func InterfaceAndSameNamedGeneric_DifferentArity_BindsWithNoDiagnostics() {
        const source = `package p
interface I { }
interface I[T] { }
class C : I { }
class D[T] : I[T] { }`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenuineDuplicateClass_SameArity0_ReportsGS0102() {
        const source = `package p
open class X { }
open class X { }`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func GenuineDuplicateGeneric_SameArity1_ReportsGS0102() {
        const source = `package p
class X[T] { }
class X[T] { }`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0102")
    }

    @Fact
    func ReferenceWithoutTypeArgs_ResolvesArity0_NoSpuriousNotGeneric() {
        const source = `package p
open class Box { }
open class Box[T] : Box { }
func F(b Box) { }`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0149")
        Assert.Empty(diagnostics)
    }

    @Fact
    func ReferenceWithTypeArgs_ResolvesGenericArity_NoSpuriousNotGeneric() {
        const source = `package p
open class Box { }
open class Box[T] : Box { var V T }
func F(b Box[int32]) { }`
        let diagnostics = Bind(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0149")
        Assert.Empty(diagnostics)
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
