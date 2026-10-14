// <copyright file="Issue1019StaticInterfacePropertyParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit
import Xunit.Sdk

/// ADR-0089 / issue #1019: parser surface tests for static-virtual interface
/// *properties*. Verifies that the parser accepts a `prop` declaration
/// inside an interface `shared { … }` block in the bare, get-only, and
/// get/set forms, and marks it with the `shared` static modifier.
open class Issue1019StaticInterfacePropertyParserTests {
    @Fact
    func BareStaticProperty_Parses() {
        const source = `package P
interface IData {
  shared {
    prop Name string;
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func GetOnlyStaticProperty_Parses() {
        const source = `package P
interface IData {
  shared {
    prop SizeInBytes int32 { get; }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func GetSetStaticProperty_Parses() {
        const source = `package P
interface IData {
  shared {
    prop Tag int32 { get; set }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
    }

    @Fact
    func StaticProperty_CarriesStaticModifierInSyntax() {
        const source = `package P
interface IData {
  shared {
    prop Name string { get; }
  }
}
`
        let tree = SyntaxTree.Parse(source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IData")
        let prop = iface.Properties.Single()
        Assert.True(prop.HasStaticModifier)
        Assert.Equal("shared", prop.StaticModifier!!.Text)
        Assert.Equal("Name", prop.Identifier.Text)
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
