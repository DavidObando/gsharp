// <copyright file="Issue1196TypeParameterToInterfaceConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1196: a generic type parameter <c>T</c> constrained to an interface
/// (or base class) is implicitly convertible to that interface — for
/// assignment, argument passing, and return values — mirroring C# §10.2.12.
/// These binder tests assert the conversion no longer produces GS0155
/// ("Cannot convert type 'T' to ...").
/// </summary>
public class Issue1196TypeParameterToInterfaceConversionTests
{
    [Fact]
    public void TypeParameter_AssignedToConstraintInterface_NoGS0155()
    {
        const string source =
            "package p\n" +
            "interface IPrim { func V() int32; }\n" +
            "func Use[T IPrim](t T) {\n" +
            "    var x IPrim = t\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void TypeParameter_PassedAsConstraintInterfaceArgument_NoGS0155()
    {
        const string source =
            "package p\n" +
            "interface IPrim { func V() int32; }\n" +
            "func Take(p IPrim) { }\n" +
            "func Use[T IPrim](t T) {\n" +
            "    Take(t)\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void TypeParameter_ReturnedAsConstraintInterface_NoGS0155()
    {
        const string source =
            "package p\n" +
            "interface IPrim { func V() int32; }\n" +
            "func Use[T IPrim](t T) IPrim {\n" +
            "    return t\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0155");
    }

    [Fact]
    public void TypeParameter_ConvertedToTransitiveBaseInterface_NoGS0155()
    {
        // T : IDerived, and IDerived : IBase — converting T to IBase must work
        // because IBase is transitively in T's effective interface set.
        const string source =
            "package p\n" +
            "interface IBase { func B() int32; }\n" +
            "interface IDerived : IBase { func D() int32; }\n" +
            "func Use[T IDerived](t T) IBase {\n" +
            "    return t\n" +
            "}\n";

        var diagnostics = GetDiagnostics(source);

        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0155");
    }

    private static IEnumerable<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(source);
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics.ToList();
    }
}
