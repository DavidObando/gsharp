// <copyright file="Issue1582MetadataBaseInheritedMemberTests.cs" company="GSharp">
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
/// Issue #1582: when a G# class derives from a metadata (BCL / referenced
/// assembly) base class, inherited members — methods, properties, AND fields,
/// of any accessibility visible to the derived type — must resolve identically
/// to a user-defined base, both unqualified (bare name) and <c>this.</c>
/// qualified. Two historic defects are covered:
/// <list type="bullet">
///   <item>Defect A: unqualified simple-name lookup skipped the metadata base
///   chain for properties/fields (inherited methods already resolved).</item>
///   <item>Defect B: qualified member lookup did not find inherited
///   <c>protected</c> fields of a metadata base (inherited properties did).</item>
/// </list>
/// Every scenario is asserted under BOTH the live-reflection
/// (<see cref="ReferenceResolver.Default"/>) resolver and the
/// <see cref="System.Reflection.MetadataLoadContext"/>-backed
/// (<see cref="ReferenceResolver.WithReferences"/>) resolver, since the SDK
/// build path uses the latter.
/// </summary>
public class Issue1582MetadataBaseInheritedMemberTests
{
    // Defect A — unqualified inherited PROPERTY from a metadata base.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void Unqualified_InheritedProperty_FromMetadataBase_Resolves(bool withReferences)
    {
        var source = @"
package p
import System
class A : Exception { func F() string { return Message } }
";
        AssertNoErrors(source, withReferences);
    }

    // Defect A — unqualified inherited protected FIELD from a metadata base.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void Unqualified_InheritedField_FromMetadataBase_Resolves(bool withReferences)
    {
        var source = @"
package p
import System.Security.Cryptography
open class A : HashAlgorithm {
    func Initialize() { }
    protected func HashCore(a []uint8, s int32, c int32) { }
    protected func HashFinal() []uint8 { return HashValue }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Defect B — qualified inherited protected FIELD from a metadata base
    // (read AND write).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void Qualified_InheritedField_FromMetadataBase_Resolves(bool withReferences)
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

    // Regression — unqualified inherited METHOD from a metadata base still
    // resolves (this path always worked; guards against a regression).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void Unqualified_InheritedMethod_FromMetadataBase_Resolves(bool withReferences)
    {
        var source = @"
package p
import System
class A : Exception { func F() string? { return ToString() } }
";
        AssertNoErrors(source, withReferences);
    }

    // Generalization — a metadata base reached THROUGH a user class exposes the
    // inherited property both bare and qualified (full base-chain walk).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void Inherited_MetadataBase_ThroughUserClass_Resolves(bool withReferences)
    {
        var source = @"
package p
import System
open class Base : Exception { }
class Derived : Base {
    func F() string { return Message }
    func G() string { return this.Message }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Control — a USER-defined base works for unqualified/qualified property AND
    // field, confirming the metadata-base behavior now matches it.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void UserDefinedBase_AllMemberKinds_Resolve(bool withReferences)
    {
        var source = @"
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
