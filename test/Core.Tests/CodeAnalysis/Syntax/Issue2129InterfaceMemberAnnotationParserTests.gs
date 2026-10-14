// <copyright file="Issue2129InterfaceMemberAnnotationParserTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Syntax

import GSharp.Core.CodeAnalysis.Syntax
import System.Linq
import Xunit
import Xunit.Sdk

/// Issue #2129: the interface-member parse loop had no branch for a leading
/// `@` annotation, so an attribute applied to an interface property
/// (or event / method signature) fell through to the recovery arm and
/// reported GS0005 (`Unexpected token <AtToken>, expected
/// <FuncKeyword>`) — even though the identical attribute parses on a
/// class member. These tests verify that Kotlin-style `@annotations`
/// (ADR-0047) now parse without diagnostics on all three interface member
/// kinds and are attached to the produced syntax node.
open class Issue2129InterfaceMemberAnnotationParserTests {
    @Fact
    func AnnotationOnInterfaceProperty_ParsesWithoutDiagnostics() {
        const Source = `package P
interface IPerson {
  @Note("asin")
  prop Asin string
}
`
        let tree = SyntaxTree.Parse(Source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IPerson")
        let prop = iface.Properties.Single()
        Assert.Equal("Asin", prop.Identifier.Text)
        let annotation = Assert.Single(prop.Annotations)
        Assert.Equal("Note", annotation.NameSegments.Single().Text)
    }

    @Fact
    func AnnotationOnInterfaceEvent_ParsesWithoutDiagnostics() {
        const Source = `package P
interface IPerson {
  @Note("evt")
  event Changed Action
}
`
        let tree = SyntaxTree.Parse(Source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IPerson")
        let ev = iface.Events.Single()
        Assert.Equal("Changed", ev.Identifier.Text)
        Assert.Single(ev.Annotations)
    }

    @Fact
    func AnnotationOnInterfaceMethodSignature_ParsesWithoutDiagnostics() {
        const Source = `package P
interface IPerson {
  @Note("greet")
  func Greet() string;
}
`
        let tree = SyntaxTree.Parse(Source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IPerson")
        let method = iface.Methods.Single()
        Assert.Equal("Greet", method.Identifier.Text)
        Assert.Single(method.Annotations)
    }

    @Fact
    func MultipleAnnotationsOnInterfaceMembers_ParseWithoutDiagnostics() {
        const Source = `package P
interface IPerson {
` + `  @Note("a")
  @Note("b")
  prop Asin string
` + `  @Note("c")
  func Greet() string;
}
`
        let tree = SyntaxTree.Parse(Source)
        Assert.Empty(tree.Diagnostics)
        let iface = FindInterface(tree, "IPerson")
        Assert.Equal(2, iface.Properties.Single().Annotations.Length)
        Assert.Single(iface.Methods.Single().Annotations)
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
