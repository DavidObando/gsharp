// <copyright file="Issue1007GenericInterfaceMethodTests.cs" company="GSharp">
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

/// Issue #1007: a generic method declared inside an interface body
/// (`func IsPrim[T]() bool;`) failed to parse and therefore never bound.
/// The interface-member binding path now binds the method's generic
/// type-parameter list (mirroring class methods), producing a
/// (cref:FunctionSymbol) with arity > 0. An implementing class can
/// satisfy the generic slot, and a generic-arity mismatch is still rejected
/// with GS0187.
open class Issue1007GenericInterfaceMethodTests {
    @Fact
    func GenericInterfaceMethod_BindsWithNoDiagnostics() {
        const source = "package t\ninterface A { func IsPrim[T]() bool; }"
        Assert.Empty(Bind(source))
    }

    @Fact
    func GenericInterfaceMethod_RecordsTypeParametersOnMethodSymbol() {
        const source = "package t\ninterface A { func IsPrim[T]() bool; }"
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let iface = compilation.GlobalScope.Interfaces.Single((i InterfaceSymbol) -> i.Name == "A")
        let method = iface.Methods.Single((m FunctionSymbol) -> m.Name == "IsPrim")
        Assert.True(method.IsGeneric)
        Assert.Single(method.TypeParameters)
        Assert.Equal("T", method.TypeParameters[0].Name)
    }

    @Fact
    func GenericInterfaceMethod_MultipleTypeParameters_RecordsArityTwo() {
        const source = "package t\ninterface A { func Pair[T, U](a T, b U) U; }"
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let iface = compilation.GlobalScope.Interfaces.Single((i InterfaceSymbol) -> i.Name == "A")
        let method = iface.Methods.Single((m FunctionSymbol) -> m.Name == "Pair")
        Assert.True(method.IsGeneric)
        Assert.Equal(2, method.TypeParameters.Length)
        Assert.Equal("T", method.TypeParameters[0].Name)
        Assert.Equal("U", method.TypeParameters[1].Name)
    }

    @Fact
    func ClassImplementingGenericInterfaceMethod_SatisfiesContract() {
        const source = `package t
interface A { func Echo[T](x T) T; }
class C : A {
    func Echo[T](x T) T { return x }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ClassImplementingGenericInterfaceMethod_MultipleTypeParameters_SatisfiesContract() {
        const source = `package t
interface A { func Pair[T, U](a T, b U) U; }
class C : A {
    func Pair[T, U](a T, b U) U { return b }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func ClassWithNonGenericMethod_DoesNotSatisfyGenericInterfaceMethod_ReportsGS0187() {
        // A same-name non-generic class method has a different arity and must
        // not be treated as implementing the generic interface slot.
        const source = `package t
interface A { func Echo[T](x T) T; }
class C : A {
    func Echo(x int32) int32 { return x }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func CallingGenericInterfaceMethodWithExplicitTypeArg_BindsCleanly() {
        const source = `package t
import System
interface A { func Echo[T](x T) T; }
class C : A {
    func Echo[T](x T) T { return x }
}
var a A = C()
Console.WriteLine(a.Echo[int32](42))`
        Assert.Empty(Bind(source))
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
