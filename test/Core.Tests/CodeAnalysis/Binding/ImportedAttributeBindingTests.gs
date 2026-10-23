// <copyright file="ImportedAttributeBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System.Collections.Immutable
import System.Linq
import Xunit

/// Regression tests for issue #288: applying an attribute defined in a
/// referenced/imported assembly must not crash binding. Attribute types loaded
/// through a (cref:System.Reflection.MetadataLoadContext) cannot be read
/// with runtime reflection (`Attribute.GetCustomAttribute` throws
/// (cref:System.InvalidOperationException)), so
/// (cref:KnownAttributes.GetAttributeUsage) must read
/// `[AttributeUsage]` via (cref:System.Reflection.CustomAttributeData).
open class ImportedAttributeBindingTests {
    @Fact
    func Imported_Attribute_With_Usage_Binds_Without_Crash() {
        let source = `package Demo
import GSharp.Core.Tests.Fixtures

@ImportedMarker
class Hello {
}`
        let globalScope = BindWithFixtures(source)
        let hello = globalScope.Structs.Single((s StructSymbol) -> s.Name == "Hello")
        let attr = Assert.Single(hello.Attributes)
        Assert.Equal("GSharp.Core.Tests.Fixtures.ImportedMarkerAttribute", attr.AttributeType.Name)
        Assert.Equal(AttributeTargetKind.Type, attr.Target)
        // The attribute's [AttributeUsage] permits Class targets, so there must
        // be no invalid-use-site (GS0201) diagnostic.
        Assert.DoesNotContain(globalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0201")
    }

    @Fact
    func Imported_Attribute_On_Method_Binds_Without_Crash() {
        let source = `package Demo
import GSharp.Core.Tests.Fixtures

class Hello {
    @ImportedMarker
    func Index() string {
        return "hi"
    }
}`
        let globalScope = BindWithFixtures(source)
        Assert.DoesNotContain(globalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0201")
    }

    @Fact
    func Imported_Attribute_Without_Usage_Defaults_To_All() {
        // ImportedDefaultAttribute carries no [AttributeUsage]; the CLR default
        // (AttributeTargets.All) must apply, so applying it to a type is valid.
        let source = `package Demo
import GSharp.Core.Tests.Fixtures

@ImportedDefault
class Hello {
}`
        let globalScope = BindWithFixtures(source)
        let hello = globalScope.Structs.Single((s StructSymbol) -> s.Name == "Hello")
        Assert.Single(hello.Attributes)
        Assert.DoesNotContain(globalScope.Diagnostics, (d Diagnostic) -> d.Id == "GS0201")
    }

    @Fact
    func NamedConstructorArguments_UseTheCompleteAllocatedParameterScope() {
        let globalScope = BindWithIssue4503Contracts(`package Demo
import Issue4503.Contracts

@ImportedReservedNamed(params__: "a", params_: "b")
class Hello {
}`)
        let attribute = Assert.Single(globalScope.Structs.Single((s StructSymbol) -> s.Name == "Hello").Attributes)
        Assert.Equal("a", attribute.GetConstructorArgument(0, "params")?.Value)
        Assert.Equal("b", attribute.GetConstructorArgument(1, "params_")?.Value)
    }

    @Fact
    func NamedConstructorMetadataName_ComesFromTheSelectedOverload() {
        let globalScope = BindWithIssue4503Contracts(`package Demo
import Issue4503.Contracts

@ImportedOverloadedReserved(params_: 1)
class Hello {
}`)
        let attribute = Assert.Single(globalScope.Structs.Single((s StructSymbol) -> s.Name == "Hello").Attributes)
        let argument = Assert.Single(attribute.PositionalArguments)
        Assert.Equal("params", attribute.GetConstructorParameterMetadataName(argument))
    }

    @Fact
    func EscapedRawClrConstructorParameterName_IsRecognized() {
        let globalScope = BindWithIssue4503Contracts(`package Demo
import Issue4503.Contracts

@ImportedReservedNamed($params: "a", params_: "b")
class Hello {
}`)
        let attribute = Assert.Single(globalScope.Structs.Single((s StructSymbol) -> s.Name == "Hello").Attributes)
        Assert.Equal("a", attribute.GetConstructorArgument(0, "params")?.Value)
        Assert.Equal("b", attribute.GetConstructorArgument(1, "params_")?.Value)
    }

    shared {
        private func FixtureResolver() ReferenceResolver {
            // Supplying a real reference path forces the compiler to load attribute
            // types through a MetadataLoadContext, reproducing the issue #288 crash.
            let fixturePath = typeof(ImportedMarkerAttribute).Assembly.Location
            return ReferenceResolver.WithReferences([]string{fixturePath})
        }

        private func BindWithFixtures(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), FixtureResolver())
        }

        private func BindWithIssue4503Contracts(source string) BoundGlobalScope {
            using let contracts = Issue4503ImportedAttributeContracts()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            // The returned scope is inspected after this method returns, and its imported
            // types are read from the resolver's load context on first use, so the
            // resolver must outlive the call. It holds no file handles; the collector
            // reclaims it.
            let resolver = ReferenceResolver.WithReferences([]string{contracts.Path})
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), resolver)
        }
    }
}
