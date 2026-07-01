// <copyright file="Issue1585StaticBareCallTests.cs" company="GSharp">
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
/// Issue #1585: an unqualified (bare-name) call from inside a static
/// (<c>shared</c>) method body to a sibling static method of the same type must
/// resolve — just like the same call qualified with the type name, and just
/// like a bare call to a static sibling from an instance method body. Before
/// the fix static-method bodies were not searched against the enclosing type's
/// own static method group, so such calls reported <c>GS0130</c>
/// ("Function '…' doesn't exist.").
/// Every scenario is asserted under BOTH the live-reflection
/// (<see cref="ReferenceResolver.Default"/>) resolver and the
/// <see cref="System.Reflection.MetadataLoadContext"/>-backed
/// (<see cref="ReferenceResolver.WithReferences"/>) resolver, since the SDK
/// build path uses the latter.
/// </summary>
public class Issue1585StaticBareCallTests
{
    // Non-generic static -> static bare call.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void StaticToStatic_BareCall_NonGeneric_Resolves(bool withReferences)
    {
        var source = @"
package p
class M {
    shared {
        func Caller() int32 { return Helper() }
        private func Helper() int32 { return 1 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Generic static -> static bare call with explicit type arguments.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void StaticToStatic_BareCall_GenericExplicitTypeArgs_Resolves(bool withReferences)
    {
        var source = @"
package p
class M {
    shared {
        func Caller[T class init()]() T { return Helper[T]() }
        private func Helper[T class init()]() T { return T() }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Generic static -> static bare call with INFERRED type arguments.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void StaticToStatic_BareCall_GenericInferredTypeArgs_Resolves(bool withReferences)
    {
        var source = @"
package p
class M {
    shared {
        func Caller(x int32) int32 { return Ident(x) }
        private func Ident[T](v T) T { return v }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Overloaded static siblings — the correct overload is picked by arity.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void StaticToStatic_BareCall_OverloadedSiblings_Resolve(bool withReferences)
    {
        var source = @"
package p
class M {
    shared {
        func Caller() int32 { return Add(1) + Add(1, 2) }
        private func Add(a int32) int32 { return a }
        private func Add(a int32, b int32) int32 { return a + b }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Default-parameter static sibling — the omitted trailing slot is filled.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void StaticToStatic_BareCall_DefaultParameter_Resolves(bool withReferences)
    {
        var source = @"
package p
class M {
    shared {
        func Caller() int32 { return Add(1) }
        private func Add(a int32, b int32 = 5) int32 { return a + b }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // A user struct behaves the same as a class for static-self dispatch.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void StaticToStatic_BareCall_OnStruct_Resolves(bool withReferences)
    {
        var source = @"
package p
struct S {
    shared {
        func Caller() int32 { return Helper() }
        private func Helper() int32 { return 7 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Control — the qualified `Type.Helper[T]()` static call still resolves.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void QualifiedStaticCall_FromStaticCaller_StillResolves(bool withReferences)
    {
        var source = @"
package p
class M {
    shared {
        func Caller[T class init()]() T { return M.Helper[T]() }
        private func Helper[T class init()]() T { return T() }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Control — a bare call to a static sibling from an INSTANCE body still
    // resolves (the path that always worked; guards against a regression).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void InstanceToStatic_BareCall_StillResolves(bool withReferences)
    {
        var source = @"
package p
class M {
    func Caller[T class init()]() T { return Helper[T]() }
    shared {
        private func Helper[T class init()]() T { return T() }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Control — a genuinely undefined bare call from a static body still reports
    // GS0130 (the fix must not swallow real "not found" diagnostics).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void StaticBareCall_UndefinedName_StillReportsGs0130(bool withReferences)
    {
        var source = @"
package p
class M {
    shared {
        func Caller() int32 { return Nope() }
    }
}
";
        var diagnostics = Bind(source, withReferences);
        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains("'Nope' doesn't exist"));
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
            typeof(System.Console).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }
}
