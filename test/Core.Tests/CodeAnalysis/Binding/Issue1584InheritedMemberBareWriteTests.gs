// <copyright file="Issue1584InheritedMemberBareWriteTests.cs" company="GSharp">
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

/// Issue #1584 (follow-up to #1582): a bare (unqualified) WRITE or
/// COMPOUND-WRITE to an inherited CLR instance member (field or property) of a
/// metadata (BCL / referenced-assembly) base class must resolve identically to
/// the `this.`-qualified path and to a user-defined base — instead of
/// failing with `GS0125: Variable '…' doesn't exist`. #1582 fixed the READ
/// path and the qualified WRITE path but left the bare-name write /
/// compound-write target resolution unaware of the inherited-CLR base chain.
/// Every scenario is asserted under BOTH the live-reflection
/// ((cref:ReferenceResolver.Default)) resolver and the
/// (cref:System.Reflection.MetadataLoadContext)-backed
/// ((cref:ReferenceResolver.WithReferences)) resolver.
open class Issue1584InheritedMemberBareWriteTests {
    // Bare WRITE to an inherited protected FIELD of a metadata base.
    @Theory
    @MemberData("Resolvers")
    func BareWrite_InheritedField_FromMetadataBase_Resolves(withReferences bool) {
        let source = `
package p
import System.Security.Cryptography
open class A : HashAlgorithm {
    func Initialize() { }
    protected func HashCore(a []uint8, s int32, c int32) { }
    protected func HashFinal() []uint8 {
        HashValue = []uint8{}
        return []uint8{}
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Bare COMPOUND-WRITE to an inherited protected FIELD of a metadata base.
    @Theory
    @MemberData("Resolvers")
    func BareCompoundWrite_InheritedField_FromMetadataBase_Resolves(withReferences bool) {
        let source = `
package p
import System.Security.Cryptography
open class A : HashAlgorithm {
    func Initialize() { }
    protected func HashCore(a []uint8, s int32, c int32) { }
    protected func HashFinal() []uint8 {
        HashSizeValue += 1
        return []uint8{}
    }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Bare WRITE to an inherited PROPERTY of a metadata base.
    @Theory
    @MemberData("Resolvers")
    func BareWrite_InheritedProperty_FromMetadataBase_Resolves(withReferences bool) {
        let source = `
package p
import System
open class A : Exception {
    func F() { HResult = 5 }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Bare COMPOUND-WRITE to an inherited PROPERTY of a metadata base.
    @Theory
    @MemberData("Resolvers")
    func BareCompoundWrite_InheritedProperty_FromMetadataBase_Resolves(withReferences bool) {
        let source = `
package p
import System
open class A : Exception {
    func F() { HResult += 5 }
}
`
        AssertNoErrors(source, withReferences)
    }

    // Negative — a bare write to a get-only inherited property reports
    // "cannot assign" (GS0127), NOT GS0125 "doesn't exist".
    @Theory
    @MemberData("Resolvers")
    func BareWrite_InheritedGetOnlyProperty_ReportsCannotAssign(withReferences bool) {
        let source = `
package p
import System
open class A : Exception {
    func F() { Message = "x" }
}
`
        let diagnostics = Bind(source, withReferences)
        let errors = diagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.NotEmpty(errors)
        Assert.All(errors, (d Diagnostic) -> Assert.DoesNotContain("doesn't exist", d.Message))
        Assert.Contains(
            errors,
            (d Diagnostic) -> d.Message.Contains("read-only") || d.Message.Contains("cannot be assigned")
        )
    }

    // Negative — a bare compound-write to a get-only inherited property reports
    // "cannot assign" (GS0127), NOT GS0125 "doesn't exist".
    @Theory
    @MemberData("Resolvers")
    func BareCompoundWrite_InheritedGetOnlyProperty_ReportsCannotAssign(withReferences bool) {
        let source = `
package p
import System
open class A : Exception {
    func F() { StackTrace += "x" }
}
`
        let diagnostics = Bind(source, withReferences)
        let errors = diagnostics.Where((d Diagnostic) -> d.IsError).ToArray()
        Assert.NotEmpty(errors)
        Assert.All(errors, (d Diagnostic) -> Assert.DoesNotContain("doesn't exist", d.Message))
        Assert.Contains(
            errors,
            (d Diagnostic) -> d.Message.Contains("read-only") || d.Message.Contains("cannot be assigned")
        )
    }

    // Regression — a genuinely undefined bare write still reports GS0125.
    @Theory
    @MemberData("Resolvers")
    func BareWrite_UndefinedName_StillReportsDoesNotExist(withReferences bool) {
        let source = `
package p
import System
open class A : Exception {
    func F() { Nonexistent = 5 }
}
`
        let diagnostics = Bind(source, withReferences)
        Assert.Contains(
            diagnostics.Where((d Diagnostic) -> d.IsError),
            (d Diagnostic) -> d.Message.Contains("doesn't exist")
        )
    }

    // Control — the qualified WRITE (fixed by #1582) still resolves.
    @Theory
    @MemberData("Resolvers")
    func QualifiedWrite_InheritedMember_StillResolves(withReferences bool) {
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

    // Control — the bare READ (fixed by #1582) still resolves.
    @Theory
    @MemberData("Resolvers")
    func BareRead_InheritedMember_StillResolves(withReferences bool) {
        let source = `
package p
import System
class A : Exception { func F() string { return Message } }
`
        AssertNoErrors(source, withReferences)
    }

    // Control — a USER-defined base bare write / compound-write to inherited
    // field AND property resolves, confirming metadata-base parity.
    @Theory
    @MemberData("Resolvers")
    func UserDefinedBase_BareWriteAndCompound_Resolve(withReferences bool) {
        let source = `
package p
open class Base {
    protected var value int32
    prop Tag int32 { get set }
}
class Derived : Base {
    func WriteFieldBare() { value = 1 }
    func CompoundFieldBare() { value += 1 }
    func WritePropBare() { Tag = 1 }
    func CompoundPropBare() { Tag += 1 }
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
