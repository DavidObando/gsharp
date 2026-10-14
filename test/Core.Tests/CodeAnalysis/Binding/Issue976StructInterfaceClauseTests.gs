// <copyright file="Issue976StructInterfaceClauseTests.cs" company="GSharp">
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

/// Issue #976: a G# `struct` (CLR value type) may declare an
/// implemented-interface clause (`struct S : I { … }`), mirroring a
/// `class`. The parser already accepts the base/interface clause for
/// structs; the binder accepts interfaces but rejects a class/struct base type
/// with GS0382, and enforces interface satisfaction via the same GS0187
/// channel classes use.
open class Issue976StructInterfaceClauseTests {
    @Fact
    func StructInterfaceClause_Parses_WithNoDiagnostics() {
        const source = `package P
import System
struct Money : IEquatable[Money] {
    var Cents int32
    func Equals(other Money) bool { return Cents == other.Cents }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func StructInterfaceClause_Binds_WithNoDiagnostics() {
        const source = `package P
import System
struct Money : IEquatable[Money] {
    var Cents int32
    func Equals(other Money) bool { return Cents == other.Cents }
}`
        let diagnostics = Bind(source)
        Assert.Empty(diagnostics)
    }

    @Fact
    func StructImplementsUserInterface_RecordsInterfaceOnSymbol() {
        const source = `package P
interface IShape {
    func Area() int32;
}
struct Square : IShape {
    var Side int32
    func Area() int32 { return Side * Side }
}`
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let square = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Square")
        Assert.False(square.IsClass, "Square must be a value-type struct")
        Assert.Contains(square.Interfaces, (i InterfaceSymbol) -> i.Name == "IShape")
    }

    @Fact
    func StructNamingClassAsBase_ReportsGS0382() {
        const source = `package P
class Base { var X int32 }
struct S : Base { var Y int32 }`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0382")
    }

    @Fact
    func StructNamingAnotherStructAsBase_ReportsGS0382() {
        const source = `package P
struct Other { var X int32 }
struct S : Other { var Y int32 }`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0382")
    }

    @Fact
    func StructMissingInterfaceMember_ReportsGS0187() {
        const source = `package P
import System
struct Money : IComparable[Money] {
    var Cents int32
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0187")
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }
    }
}
