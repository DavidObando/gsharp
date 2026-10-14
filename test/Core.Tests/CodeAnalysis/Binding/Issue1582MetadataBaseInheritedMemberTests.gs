// <copyright file="Issue1582MetadataBaseInheritedMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import System.Security.Cryptography
import Xunit

/// Issue #1582: when a G# class derives from a metadata (BCL / referenced
/// assembly) base class, inherited members — methods, properties, AND fields,
/// of any accessibility visible to the derived type — must resolve identically
/// to a user-defined base, both unqualified (bare name) and `this.`
/// qualified. Two historic defects are covered:
/// - Defect A: unqualified simple-name lookup skipped the metadata base chain for properties/fields
/// (inherited methods already resolved).
/// - Defect B: qualified member lookup did not find inherited `protected` fields of a metadata base
/// (inherited properties did).
/// Every scenario is asserted under BOTH the live-reflection
/// ((cref:ReferenceResolver.Default)) resolver and the
/// (cref:System.Reflection.MetadataLoadContext)-backed
/// ((cref:ReferenceResolver.WithReferences)) resolver, since the SDK
/// build path uses the latter.
open class Issue1582MetadataBaseInheritedMemberTests {
    // Defect A — unqualified inherited PROPERTY from a metadata base.
    @Theory
    @MemberData("Resolvers")
    func Unqualified_InheritedProperty_FromMetadataBase_Resolves(withReferences bool) {
        let source = `
package p
import System
class A : Exception { func F() string { return Message } }
`
        AssertNoErrors(source, withReferences)
    }

    // Defect A — unqualified inherited protected FIELD from a metadata base.
    @Theory
    @MemberData("Resolvers")
    func Unqualified_InheritedField_FromMetadataBase_Resolves(withReferences bool) {
        let source = `
package p
import System.Security.Cryptography
open class A : HashAlgorithm {
    func Initialize() { }
    protected func HashCore(a []uint8, s int32, c int32) { }
    protected func HashFinal() []uint8 { return HashValue ?? []uint8{} }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Defect B — qualified inherited protected FIELD from a metadata base
    // (read AND write).
    @Theory
    @MemberData("Resolvers")
    func Qualified_InheritedField_FromMetadataBase_Resolves(withReferences bool) {
        let source = `
package p
import System.Security.Cryptography
open class A : HashAlgorithm {
    func Initialize() { }
    protected func HashCore(a []uint8, s int32, c int32) { }
    protected func HashFinal() []uint8 {
        this.HashValue = []uint8{}
        return this.HashValue ?? []uint8{}
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Regression — unqualified inherited METHOD from a metadata base still
    // resolves (this path always worked; guards against a regression).
    @Theory
    @MemberData("Resolvers")
    func Unqualified_InheritedMethod_FromMetadataBase_Resolves(withReferences bool) {
        let source = `
package p
import System
class A : Exception { func F() string? { return ToString() } }
`
        AssertNoErrors(source, withReferences)
    }

    // Generalization — a metadata base reached THROUGH a user class exposes the
    // inherited property both bare and qualified (full base-chain walk).
    @Theory
    @MemberData("Resolvers")
    func Inherited_MetadataBase_ThroughUserClass_Resolves(withReferences bool) {
        let source = `
package p
import System
open class Base : Exception { }
class Derived : Base {
    func F() string { return Message }
    func G() string { return this.Message }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Control — a USER-defined base works for unqualified/qualified property AND
    // field, confirming the metadata-base behavior now matches it.
    @Theory
    @MemberData("Resolvers")
    func UserDefinedBase_AllMemberKinds_Resolve(withReferences bool) {
        let source = `
package p
open class Base {
    protected let value int32
    prop Tag string { get set }
}
class Derived : Base {
    func ReadFieldBare() int32 { return value }
    func ReadFieldQualified() int32 { return this.value }
    func ReadPropBare() string { return Tag }
    func ReadPropQualified() string { return this.Tag }
}
`
        AssertNoErrors(source, withReferences)
    }

    shared {
        func Resolvers() TheoryData[bool] -> TheoryData[bool]{false, true}

        private func AssertNoErrors(source string, withReferences bool) {
            let diagnostics = Bind(source, withReferences)
            Assert.Empty(diagnostics.Where((d Diagnostic) -> d.IsError))
        }

        private func Bind(source string, withReferences bool) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                CreateResolver(withReferences)
            )
            let program = Binder.BindProgram(globalScope, CreateResolver(withReferences))
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }

        private func CreateResolver(withReferences bool) ReferenceResolver {
            if !withReferences {
                return ReferenceResolver.Default()
            }
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(Exception).Assembly.Location,
                typeof(HashAlgorithm).Assembly.Location,
                typeof(Console).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }
    }
}
