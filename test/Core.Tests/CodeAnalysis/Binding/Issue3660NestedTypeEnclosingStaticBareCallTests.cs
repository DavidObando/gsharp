// <copyright file="Issue3660NestedTypeEnclosingStaticBareCallTests.cs" company="GSharp">
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
/// Issue #3660: an unqualified (bare-name) call from inside a NESTED type's body
/// to a <c>shared</c> (static) method of a LEXICALLY ENCLOSING type must resolve
/// — C# §7.4 scoping, where a nested class sees the outer class's static members
/// (including its <c>private</c> ones) without qualification. Before the fix the
/// bare-call binder consulted only the nested type's own member set, its base
/// chain, package functions and imports, never the enclosing type chain
/// (<see cref="Symbol.ContainingType"/>, ADR-0110 / issue #910), so such calls
/// reported <c>GS0130</c> ("Function '…' doesn't exist.") plus a
/// <c>GS0159</c> cascade off the errored receiver of any chained call.
/// Every scenario is asserted under BOTH the live-reflection
/// (<see cref="ReferenceResolver.Default"/>) resolver and the
/// <see cref="System.Reflection.MetadataLoadContext"/>-backed
/// (<see cref="ReferenceResolver.WithReferences"/>) resolver, since the SDK
/// build path uses the latter.
/// </summary>
public class Issue3660NestedTypeEnclosingStaticBareCallTests
{
    // Instance body of a nested class -> non-generic static of the outer class.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedInstance_BareCall_OuterStatic_NonGeneric_Resolves(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Inner {
        func Caller() int32 { return Helper(3) }
    }
    shared {
        private func Helper(value int32) int32 { return value + 1 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // The self-migration shape: explicit type arguments plus a chained call on
    // the result (`FindNodes[T](root).ToArray()` in SemanticLookup.gs).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedInstance_BareCall_OuterStatic_GenericExplicitTypeArgs_Resolves(bool withReferences)
    {
        var source = @"
package p
import System.Collections.Generic
import System.Linq
class Outer {
    class Inner {
        func Caller() []string { return Wrap[string](""a"").ToArray() }
    }
    shared {
        private func Wrap[T](value T) sequence[T] { yield value }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Inferred type arguments resolve through the same path.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedInstance_BareCall_OuterStatic_GenericInferredTypeArgs_Resolves(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Inner {
        func Caller(x int32) int32 { return Ident(x) }
    }
    shared {
        private func Ident[T](v T) T { return v }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // An overload set on the enclosing type — the arity-correct member is picked.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedInstance_BareCall_OuterStaticOverloads_Resolve(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Inner {
        func Caller() int32 { return Add(1) + Add(1, 2) }
    }
    shared {
        private func Add(a int32) int32 { return a }
        private func Add(a int32, b int32) int32 { return a + b }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // A `shared` body of the nested type reaches the enclosing type's statics too
    // (no `this` in scope; the walk starts from StaticOwnerType).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedStatic_BareCall_OuterStatic_Resolves(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Inner {
        shared {
            func Caller() int32 { return Helper(3) }
        }
    }
    shared {
        private func Helper(value int32) int32 { return value + 1 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Two levels of nesting — the walk continues outward past the first
    // enclosing type that does not declare the name.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void DoublyNested_BareCall_OutermostStatic_Resolves(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Middle {
        class Inner {
            func Caller() int32 { return Helper(3) }
        }
    }
    shared {
        private func Helper(value int32) int32 { return value + 1 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // A nearer enclosing type shadows a farther one (innermost-first walk).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void DoublyNested_NearerEnclosingType_Shadows_Farther(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Middle {
        class Inner {
            func Caller() int32 { return Helper() }
        }
        shared {
            private func Helper() int32 { return 2 }
        }
    }
    shared {
        private func Helper() int32 { return 1 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // A struct nested in a class sees the class's statics.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedStruct_BareCall_OuterStatic_Resolves(bool withReferences)
    {
        var source = @"
package p
class Outer {
    struct Inner {
        func Caller() int32 { return Helper() }
    }
    shared {
        private func Helper() int32 { return 7 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Control — the nested type's own member still wins over the enclosing
    // type's same-named static.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedOwnMember_StillWins_OverEnclosingStatic(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Inner {
        func Caller() int32 { return Helper() }
        private func Helper() int32 { return 2 }
    }
    shared {
        private func Helper() int32 { return 1 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Control — the qualified `Outer.Helper(...)` form still resolves.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void QualifiedEnclosingStaticCall_FromNestedType_StillResolves(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Inner {
        func Caller() int32 { return Outer.Helper(3) }
    }
    shared {
        func Helper(value int32) int32 { return value + 1 }
    }
}
";
        AssertNoErrors(source, withReferences);
    }

    // Control — a genuinely undefined bare call from a nested type still reports
    // GS0130 (the walk must not swallow real "not found" diagnostics).
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedBareCall_UndefinedName_StillReportsGs0130(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Inner {
        func Caller() int32 { return Nope() }
    }
    shared {
        private func Helper() int32 { return 1 }
    }
}
";
        var diagnostics = Bind(source, withReferences);
        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains("'Nope' doesn't exist"));
    }

    // Control — an INSTANCE member of the enclosing type is NOT in scope from a
    // nested type (there is no outer `this`); the call must still fail.
    [Theory]
    [MemberData(nameof(Resolvers))]
    public void NestedBareCall_EnclosingInstanceMember_IsNotInScope(bool withReferences)
    {
        var source = @"
package p
class Outer {
    class Inner {
        func Caller() int32 { return Helper() }
    }
    private func Helper() int32 { return 1 }
}
";
        var diagnostics = Bind(source, withReferences);
        Assert.Contains(diagnostics, d => d.IsError && d.Message.Contains("'Helper' doesn't exist"));
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
            typeof(System.Linq.Enumerable).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }
}
