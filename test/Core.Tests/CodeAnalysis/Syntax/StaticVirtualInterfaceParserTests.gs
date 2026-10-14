// <copyright file="StaticVirtualInterfaceParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit
import Xunit.Sdk

/// ADR-0089 / issue #755 (issue #865 revision): parser surface tests for
/// static-virtual interface members. Verifies that the parser accepts the
/// `shared { … }` form inside an `interface` body for both abstract
/// (body-less) and default-body shapes, that the syntax tree marks those
/// methods as static, and that the removed `static func` modifier form is
/// rejected.
open class StaticVirtualInterfaceParserTests {
    @Fact
    func Abstract_SharedFunc_Parses() {
        const source = `package P
interface IFoo {
  shared {
    func F() int32;
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Default_SharedFunc_WithBody_Parses() {
        const source = `package P
interface IFoo {
  shared {
    func F() int32 { return 1 }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func Abstract_SharedFunc_CarriesStaticModifierInSyntax() {
        const source = `package P
interface IFoo {
  shared {
    func F() int32;
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IFoo")
        let method = iface.Methods.Single()
        Assert.True(method.HasStaticModifier)
        Assert.Equal("shared", method.StaticModifier!!.Text)
        Assert.Null(method.Body)
    }

    @Fact
    func Default_SharedFunc_CarriesStaticModifierAndBody() {
        const source = `package P
interface IFoo {
  shared {
    func F() int32 { return 1 }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IFoo")
        let method = iface.Methods.Single()
        Assert.True(method.HasStaticModifier)
        Assert.Equal("shared", method.StaticModifier!!.Text)
        Assert.NotNull(method.Body)
    }

    @Fact
    func StaticAndInstance_Methods_CanCoexistInInterface() {
        const source = `package P
interface IBoth {
    shared {
        func S() int32;
    }
    func I() int32;
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IBoth")
        let methods = iface.Methods.ToArray()
        Assert.Equal(2, methods.Length)
        let staticMethod = methods.Single((m FunctionDeclarationSyntax) -> m.HasStaticModifier)
        let instanceMethod = methods.Single((m FunctionDeclarationSyntax) -> !m.HasStaticModifier)
        Assert.Equal("S", staticMethod.Identifier.Text)
        Assert.Equal("I", instanceMethod.Identifier.Text)
    }

    @Fact
    func PrivateSharedFunc_CarriesStaticAndPrivateModifiers() {
        const source = `package P
interface IFoo {
    shared {
        private func Helper() int32 { return 0 }
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IFoo")
        let method = iface.Methods.Single()
        Assert.True(method.HasStaticModifier)
        Assert.NotNull(method.AccessibilityModifier)
        Assert.Equal("private", method.AccessibilityModifier!!.Text)
    }

    @Fact
    func RemovedStaticFuncModifier_IsRejected() {
        // Issue #865 revision: `static` is no longer a contextual keyword on
        // interface members. The old `static func` form now falls through to
        // the generic "unexpected token" parser error (GS0005).
        const source = `package P
interface IFoo {
  static func F() int32
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0005")
    }

    @Fact
    func NonFunc_InInterfaceSharedBlock_ReportsGS0330() {
        // Issue #1030: `var`/`let`/`const` interface static state and `prop`
        // static-virtual properties parse cleanly inside a shared block. A
        // non-field, non-func, non-prop member (e.g. `event`) is still
        // rejected with GS0330.
        const source = `package P
interface IFoo {
    shared {
        event Changed System.Action
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.Contains(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0330")
    }

    @Fact
    func StaticFieldVarLetConst_InInterfaceSharedBlock_ParsesCleanly() {
        // Issue #1030: interface static *state* — `var`/`let`/`const` fields
        // in an interface shared block parse without diagnostics.
        const source = `package P
interface ICounter {
    shared {
        var Count int32
        let Label string = "c"
        const Max int32 = 100
    }
}`
        let tree = SyntaxTree.Parse(source)
        Assert.DoesNotContain(tree.Diagnostics, (d Diagnostic) -> d.Id == "GS0330")
        let iface = FindInterface(tree, "ICounter")
        Assert.Equal(3, iface.StaticFields.Length)
    }

    shared {
        private func FindInterface(tree SyntaxTree, name string) InterfaceDeclarationSyntax {
            let root = cast[CompilationUnitSyntax](tree.Root)
            for member in root.Members {
                if member is InterfaceDeclarationSyntax iface && iface.Identifier.Text == name {
                    return iface
                }
            }
            throw XunitException("interface $name not found")
        }
    }
}
