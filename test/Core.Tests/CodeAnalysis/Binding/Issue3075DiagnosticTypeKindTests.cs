// <copyright file="Issue3075DiagnosticTypeKindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #3075: interface-implementation diagnostics name the actual aggregate kind.</summary>
public class Issue3075DiagnosticTypeKindTests
{
    [Theory]
    [InlineData("class", "Class")]
    [InlineData("struct", "Struct")]
    public void MissingInterfaceMethod_UsesActualKind(string declarationKind, string displayKind)
    {
        var diagnostic = GetDiagnostic(
            "GS0187",
            $$"""
            interface IContract {
                func Required() int32;
            }

            {{declarationKind}} Lookup : IContract {
            }
            """);

        Assert.Equal(
            $"{displayKind} 'Lookup' does not implement interface method 'IContract.Required'.",
            diagnostic.Message);
    }

    [Theory]
    [InlineData("class", "Class")]
    [InlineData("struct", "Struct")]
    public void SealedInterfaceOutsidePackage_UsesActualKind(string declarationKind, string displayKind)
    {
        var diagnostic = GetDiagnostic(
            "GS0188",
            """
            package Contracts

            public sealed interface IContract {
            }
            """,
            $$"""
            package Implementers
            import Contracts

            {{declarationKind}} Lookup : IContract {
            }
            """);

        Assert.Equal(
            $"{displayKind} 'Lookup' cannot implement sealed interface 'IContract' from a different package ('Contracts').",
            diagnostic.Message);
    }

    [Theory]
    [InlineData("class", "Class")]
    [InlineData("struct", "Struct")]
    public void ConflictingDefaults_UsesActualKind(string declarationKind, string displayKind)
    {
        var diagnostic = GetDiagnostic(
            "GS0318",
            $$"""
            interface IA {
                func Required() int32 { return 11 }
            }

            interface IB {
                func Required() int32 { return 22 }
            }

            {{declarationKind}} Lookup : IA, IB {
            }
            """);

        Assert.Equal(
            $"{displayKind} 'Lookup' inherits conflicting default implementations of method 'Required' from interfaces 'IA' and 'IB'; declare an override on 'Lookup' to disambiguate (ADR-0085).",
            diagnostic.Message);
    }

    [Theory]
    [InlineData("class", "Class")]
    [InlineData("struct", "Struct")]
    public void AbstractMethodWithoutDefault_UsesActualKind(string declarationKind, string displayKind)
    {
        var diagnostic = GetDiagnostic(
            "GS0320",
            $$"""
            interface IContract {
                func Required() int32;
                func Supplied() int32 { return 33 }
            }

            {{declarationKind}} Lookup : IContract {
            }
            """);

        Assert.Equal(
            $"{displayKind} 'Lookup' does not implement abstract interface method 'IContract.Required', and the interface provides no default body (ADR-0085).",
            diagnostic.Message);
    }

    [Theory]
    [InlineData("class", "Class")]
    [InlineData("struct", "Struct")]
    public void MissingStaticVirtualMethod_UsesActualKind(string declarationKind, string displayKind)
    {
        var diagnostic = GetDiagnostic(
            "GS0331",
            $$"""
            interface IContract {
                shared {
                    func Required() int32;
                }
            }

            {{declarationKind}} Lookup : IContract {
            }
            """);

        Assert.Equal(
            $"{displayKind} 'Lookup' does not implement static-virtual interface method 'IContract.Required', and the interface provides no default body (ADR-0089).",
            diagnostic.Message);
    }

    [Theory]
    [InlineData("class", "Class")]
    [InlineData("struct", "Struct")]
    public void InstanceMethodForStaticVirtualSlot_UsesActualKind(string declarationKind, string displayKind)
    {
        var diagnostic = GetDiagnostic(
            "GS0332",
            $$"""
            interface IContract {
                shared {
                    func Required() int32;
                }
            }

            {{declarationKind}} Lookup : IContract {
                func Required() int32 -> 11
            }
            """);

        Assert.Equal(
            $"{displayKind} 'Lookup' declares instance method 'Required' but interface 'IContract.Required' is static-virtual; declare it inside a 'shared {{ ... }}' block (ADR-0089).",
            diagnostic.Message);
    }

    private static Diagnostic GetDiagnostic(string id, params string[] sources)
    {
        var trees = sources
            .Select((source, index) => SyntaxTree.Parse(SourceText.From(source, $"issue3075-{index}.gs")))
            .ToArray();
        var compilation = new Compilation(trees);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return Assert.Single(result.Diagnostics.Where(diagnostic => diagnostic.Id == id));
    }
}
