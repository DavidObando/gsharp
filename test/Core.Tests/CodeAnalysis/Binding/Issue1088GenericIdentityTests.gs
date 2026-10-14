// <copyright file="Issue1088GenericIdentityTests.cs" company="GSharp">
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
import System.Threading.Channels
import Xunit

/// Regression tests for issue #1088: assigning the result of a
/// constructed-generic factory/method call to a variable or field of the SAME
/// constructed-generic type must bind when the type argument is a
/// <em>same-compilation</em> user type.
///
/// A same-compilation user type used as a CLR generic argument has a
/// `null` `ClrType` during binding and erases to `object` on the
/// closed (cref:GSharp.Core.CodeAnalysis.Symbols.ImportedTypeSymbol).
/// Comparing the erased `ClrType`s of the declared type
/// (`Channel[BufferEntry]`) against the method return type spuriously
/// reported `GS0155` with two IDENTICAL display names. The conversion
/// classifier now compares the SYMBOLIC type arguments structurally, so genuine
/// identity binds while distinct user-type arguments still fail.
open class Issue1088GenericIdentityTests {
    @Fact
    func Constructed_Generic_With_UserType_Arg_Binds_In_Method_Body() {
        // The exact repro from issue #1088.
        let source = `package p
import System.Threading.Channels

class BufferEntry {
}

class C {
    func M() {
        let ch Channel[BufferEntry] = Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Constructed_Generic_With_UserType_Arg_Binds_In_Field_Initializer() {
        let source = `package p
import System.Threading.Channels

class BufferEntry {
}

class C {
    private let ch Channel[BufferEntry] = Channel.CreateBounded[BufferEntry](BoundedChannelOptions(2))
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Constructed_Generic_With_BclType_Arg_Still_Binds_In_Field_Initializer() {
        // Control: the all-BCL type argument case worked before the fix and
        // must keep working.
        let source = `package p
import System.Threading.Channels

class C {
    private let ch Channel[int32] = Channel.CreateBounded[int32](BoundedChannelOptions(2))
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Constructed_Generic_With_BclType_Arg_Still_Binds_In_Method_Body() {
        let source = `package p
import System.Threading.Channels

class C {
    func M() {
        let ch Channel[int32] = Channel.CreateBounded[int32](BoundedChannelOptions(2))
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Same_Compilation_User_Generic_Identity_Binds() {
        // The fallback repro: a same-compilation user generic with a
        // same-compilation user-type argument round-trips through a factory.
        let source = `package p

class Box[T] {
}

class BufferEntry {
}

class C {
    func mk() Box[BufferEntry] {
        return Box[BufferEntry]()
    }

    func use() {
        let b Box[BufferEntry] = mk()
    }
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func Distinct_User_Type_Arguments_Still_Report_GS0155() {
        // Negative: distinct user-type arguments must NOT be treated as
        // identical, so the spurious-conversion guard does not over-match.
        let source = `package p

class Box[T] {
}

class A {
}

class B {
}

class C {
    func mk() Box[A] {
        return Box[A]()
    }

    func use() {
        let b Box[B] = mk()
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    @Fact
    func Mismatched_Bcl_And_User_Type_Arguments_Still_Report_GS0155() {
        // Negative: a BCL-arg construction is not assignable to a user-type-arg
        // declaration of the same open generic.
        let source = `package p
import System.Threading.Channels

class BufferEntry {
}

class C {
    func M() {
        let ch Channel[BufferEntry] = Channel.CreateBounded[int32](BoundedChannelOptions(2))
    }
}`
        Assert.Contains(Bind(source), (d Diagnostic) -> d.Id == "GS0155")
    }

    shared {
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Channel).Assembly.Location,
                typeof(BoundedChannelOptions).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                MetadataLoadContextResolver()
            )
            let program = Binder.BindProgram(globalScope, MetadataLoadContextResolver())
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }
    }
}
