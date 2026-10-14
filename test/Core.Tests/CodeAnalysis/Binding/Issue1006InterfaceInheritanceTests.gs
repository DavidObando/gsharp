// <copyright file="Issue1006InterfaceInheritanceTests.cs" company="GSharp">
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

/// Issue #1006: a G# `interface` may extend other interfaces via a
/// `: A, B` base clause (mirroring C# `interface B : A`). The binder
/// records the base interfaces on the (cref:InterfaceSymbol), surfaces
/// their members through the extending interface, expands an implementer's
/// interface set to the transitive closure, and rejects a class/struct base
/// with GS0391.
open class Issue1006InterfaceInheritanceTests {
    @Fact
    func InterfaceExtendsInterface_BindsWithNoDiagnostics() {
        const source = `package t
interface A { func F() int32; }
interface B : A { func G() int32; }`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func InterfaceExtendsInterface_RecordsBaseInterfaceOnSymbol() {
        const source = `package t
interface A { func F() int32; }
interface B : A { func G() int32; }`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let b = compilation.GlobalScope.Interfaces.Single((i InterfaceSymbol) -> i.Name == "B")
        Assert.Contains(b.BaseInterfaces, (i InterfaceSymbol) -> i.Name == "A")
        // The extending interface surfaces its own and the inherited members.
        let memberNames = b
            .SelfAndAllBaseInterfaces()
            .SelectMany(
            func (i InterfaceSymbol) IEnumerable[FunctionSymbol] {
                return i.Methods
            }
        )
            .Select((m FunctionSymbol) -> m.Name)
            .ToList()
        Assert.Contains("F", memberNames)
        Assert.Contains("G", memberNames)
    }

    @Fact
    func ClassImplementingDerivedInterface_SatisfiesInheritedAndOwnMembers() {
        const source = `package t
interface A { func F() int32; }
interface B : A { func G() int32; }
class C : B {
    func F() int32 { return 10 }
    func G() int32 { return 32 }
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        // Issue #1006: the implementer's interface set is expanded to the
        // transitive closure, so both B and the inherited A appear.
        let c = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "C")
        Assert.Contains(c.Interfaces, (i InterfaceSymbol) -> i.Name == "B")
        Assert.Contains(c.Interfaces, (i InterfaceSymbol) -> i.Name == "A")
    }

    @Fact
    func ClassImplementingDerivedInterface_MissingInheritedMember_ReportsGS0187() {
        const source = `package t
interface A { func F() int32; }
interface B : A { func G() int32; }
class C : B {
    func G() int32 { return 32 }
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    @Fact
    func InterfaceWithMultipleBases_BindsWithNoDiagnostics() {
        const source = `package t
interface A { func F() int32; }
interface C { func H() int32; }
interface B : A, C { func G() int32; }
class Impl : B {
    func F() int32 { return 1 }
    func G() int32 { return 2 }
    func H() int32 { return 3 }
}`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func InterfaceNamingClassAsBase_ReportsGS0391() {
        const source = `package t
open class Base { func H() int32 { return 1 } }
interface Bad : Base { func F() int32; }`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0391")
    }

    @Fact
    func InterfaceNamingStructAsBase_ReportsGS0391() {
        const source = `package t
struct S { var X int32 }
interface Bad : S { func F() int32; }`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0391")
    }

    @Fact
    func InterfaceCallThroughBaseTypedReference_ResolvesInheritedMember() {
        // Calling an inherited member (F, declared on A) through a B-typed
        // reference must bind cleanly — member lookup walks the base chain.
        const source = `package t
import System
interface A { func F() int32; }
interface B : A { func G() int32; }
class C : B {
    func F() int32 { return 10 }
    func G() int32 { return 32 }
}
var b B = C{}
Console.WriteLine(b.F() + b.G())`
        let diagnostics = Bind(source)
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
