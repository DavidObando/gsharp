// <copyright file="Issue1584InheritedMemberBareWriteTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1584 (follow-up to #1582): a bare (unqualified) WRITE or
/// COMPOUND-WRITE to an inherited CLR instance member (field or property) of a
/// metadata (BCL / referenced-assembly) base class must resolve identically to
/// the <c>this.</c>-qualified path and to a user-defined base — instead of
/// failing with <c>GS0125: Variable '…' doesn't exist</c>. #1582 fixed the READ
/// path and the qualified WRITE path but left the bare-name write /
/// compound-write target resolution unaware of the inherited-CLR base chain.
/// Every scenario is asserted under BOTH the live-reflection
/// (<see cref="ReferenceResolver.Default"/>) resolver and the
/// <see cref="System.Reflection.MetadataLoadContext"/>-backed
/// (<see cref="ReferenceResolver.WithReferences"/>) resolver.
/// </summary>
public class Issue1584InheritedMemberBareWriteTests
{
    // Bare WRITE to an inherited protected FIELD of a metadata base.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void BareWrite_InheritedField_FromMetadataBase_Resolves(bool withReferences)
    {
        var source = @"
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
";
        AssertNoErrors(source, withReferences);
    }

    // Bare COMPOUND-WRITE to an inherited protected FIELD of a metadata base.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void BareCompoundWrite_InheritedField_FromMetadataBase_Resolves(bool withReferences)
    {
        var source = @"
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
";
        AssertNoErrors(source, withReferences);
    }

    // Bare WRITE to an inherited PROPERTY of a metadata base.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void BareWrite_InheritedProperty_FromMetadataBase_Resolves(bool withReferences)
    {
        var source = @"
package p
import System
open class A : Exception {
    func F() { HResult = 5 }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Bare COMPOUND-WRITE to an inherited PROPERTY of a metadata base.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void BareCompoundWrite_InheritedProperty_FromMetadataBase_Resolves(bool withReferences)
    {
        var source = @"
package p
import System
open class A : Exception {
    func F() { HResult += 5 }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Negative — a bare write to a get-only inherited property reports
    // "cannot assign" (GS0127), NOT GS0125 "doesn't exist".
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void BareWrite_InheritedGetOnlyProperty_ReportsCannotAssign(bool withReferences)
    {
        var source = @"
package p
import System
open class A : Exception {
    func F() { Message = ""x"" }
}
";
        var diagnostics = Bind(source, withReferences);
        var errors = diagnostics.Where(d => d.IsError).ToArray();
        Assert.NotEmpty(errors);
        Assert.All(errors, d => Assert.DoesNotContain("doesn't exist", d.Message));
        Assert.Contains(errors, d => d.Message.Contains("read-only") || d.Message.Contains("cannot be assigned"));
    }

    // Negative — a bare compound-write to a get-only inherited property reports
    // "cannot assign" (GS0127), NOT GS0125 "doesn't exist".
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void BareCompoundWrite_InheritedGetOnlyProperty_ReportsCannotAssign(bool withReferences)
    {
        var source = @"
package p
import System
open class A : Exception {
    func F() { StackTrace += ""x"" }
}
";
        var diagnostics = Bind(source, withReferences);
        var errors = diagnostics.Where(d => d.IsError).ToArray();
        Assert.NotEmpty(errors);
        Assert.All(errors, d => Assert.DoesNotContain("doesn't exist", d.Message));
        Assert.Contains(errors, d => d.Message.Contains("read-only") || d.Message.Contains("cannot be assigned"));
    }

    // Regression — a genuinely undefined bare write still reports GS0125.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void BareWrite_UndefinedName_StillReportsDoesNotExist(bool withReferences)
    {
        var source = @"
package p
import System
open class A : Exception {
    func F() { Nonexistent = 5 }
}
";
        var diagnostics = Bind(source, withReferences);
        Assert.Contains(diagnostics.Where(d => d.IsError), d => d.Message.Contains("doesn't exist"));
    }

    // Control — the qualified WRITE (fixed by #1582) still resolves.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void QualifiedWrite_InheritedMember_StillResolves(bool withReferences)
    {
        var source = @"
package p
import System.Security.Cryptography
open class A : HashAlgorithm {
    func Initialize() { }
    protected func HashCore(a []uint8, s int32, c int32) { }
    protected func HashFinal() []uint8 {
        this.HashValue = []uint8{}
        return this.HashValue
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Control — the bare READ (fixed by #1582) still resolves.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void BareRead_InheritedMember_StillResolves(bool withReferences)
    {
        var source = @"
package p
import System
class A : Exception { func F() string { return Message } }
";
        AssertNoErrors(source, withReferences);
    }

    // Control — a USER-defined base bare write / compound-write to inherited
    // field AND property resolves, confirming metadata-base parity.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void UserDefinedBase_BareWriteAndCompound_Resolve(bool withReferences)
    {
        var source = @"
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
";
        AssertNoErrors(source, withReferences);
    }

    public static TheoryData<bool> Resolvers() => new() { false, true };

    private static void AssertNoErrors(string source, bool withReferences)
    {
        var diagnostics = Bind(source, withReferences);
        Assert.Empty(diagnostics.Where(d => d.IsError));
    }

    private static ImmutableArray<Diagnostic> Bind(string source, bool withReferences)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            CreateResolver(withReferences));
        var program = Binder.BindProgram(globalScope, CreateResolver(withReferences));
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    private static ReferenceResolver CreateResolver(bool withReferences)
    {
        if (!withReferences)
        {
            return ReferenceResolver.Default();
        }

        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Exception).Assembly.Location,
            typeof(System.Security.Cryptography.HashAlgorithm).Assembly.Location,
            typeof(System.Console).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }
}
