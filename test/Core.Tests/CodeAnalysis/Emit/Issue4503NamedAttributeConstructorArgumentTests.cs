// <copyright file="Issue4503NamedAttributeConstructorArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.Fixtures;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>Issue #4503: named constructor arguments belong in fixed-argument slots.</summary>
public sealed class Issue4503NamedAttributeConstructorArgumentTests
{
    [Fact]
    public void GeneratedRegexNamedTimeout_IsAReadableConstructorArgument()
    {
        var result = Emit(
            """
            import System.Text.RegularExpressions

            @GeneratedRegex("a", RegexOptions.None, matchTimeoutMilliseconds: 1000)
            func Pattern() {
            }
            """);

        Assert.True(result.Success, FormatDiagnostics(result));
        var assembly = EmittedFixture.Load(result.Image);
        var method = assembly.GetTypes().Single(type => type.Name == "<Program>").GetMethod("Pattern");
        var data = Assert.Single(
            method.GetCustomAttributesData(),
            attribute => attribute.AttributeType == typeof(System.Text.RegularExpressions.GeneratedRegexAttribute));
        Assert.Equal(
            new object[] { "a", 0, 1000 },
            data.ConstructorArguments.Select(argument => argument.Value));
        Assert.Empty(data.NamedArguments);
    }

    [Fact]
    public void NamedConstructorArguments_AreReordered_Defaulted_AndReadable()
    {
        using var contracts = new Issue4503ImportedAttributeContracts();
        var result = Emit(
            """
            import Issue4503.Contracts

            @ImportedNamedConstructor("first", third: 30, Label = "ok", Code = 40)
            class Tagged {
            }
            """,
            contracts.Path);

        Assert.True(result.Success, FormatDiagnostics(result));
        var (contractAssembly, assembly) = contracts.LoadWith(result.Image);
        var tagged = assembly.GetTypes().Single(type => type.Name == "Tagged");

        var namedAttributeType = contractAssembly.GetTypes()
            .Single(type => type.Name == "ImportedNamedConstructorAttribute");
        var data = tagged.GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType == namedAttributeType);
        Assert.Equal(new object[] { "first", 2, 30 }, data.ConstructorArguments.Select(argument => argument.Value));
        Assert.Equal(
            new[] { "Code", "Label" },
            data.NamedArguments.Select(argument => argument.MemberName).OrderBy(name => name));
        Assert.True(data.NamedArguments.Single(argument => argument.MemberName == "Label").IsField == false);
        Assert.True(data.NamedArguments.Single(argument => argument.MemberName == "Code").IsField);

        var instance = tagged.GetCustomAttributes(namedAttributeType, inherit: false).Single();
        Assert.Equal("first", namedAttributeType.GetProperty("First")?.GetValue(instance));
        Assert.Equal(2, namedAttributeType.GetProperty("Second")?.GetValue(instance));
        Assert.Equal(30, namedAttributeType.GetProperty("Third")?.GetValue(instance));
        Assert.Equal("ok", namedAttributeType.GetProperty("Label")?.GetValue(instance));
        Assert.Equal(40, namedAttributeType.GetField("Code")?.GetValue(instance));
    }

    [Fact]
    public void SameCompilationNamedConstructorArguments_AreReorderedAndDefaulted()
    {
        var result = Emit(
            """
            import System

            class LocalAttribute(First string, Second int32 = 2, Third int32 = 3) : Attribute {
            }

            @Local("first", Third: 30)
            class Tagged {
            }
            """);

        Assert.True(result.Success, FormatDiagnostics(result));
        var assembly = EmittedFixture.Load(result.Image);
        var tagged = assembly.GetTypes().Single(type => type.Name == "Tagged");
        var data = tagged.GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType.Name == "LocalAttribute");
        Assert.Equal(new object[] { "first", 2, 30 }, data.ConstructorArguments.Select(argument => argument.Value));
    }

    [Fact]
    public void ParamsConstructorArguments_PreserveDirectAndExpandedForms()
    {
        using var contracts = new Issue4503ImportedAttributeContracts();
        var result = Emit(
            """
            import Issue4503.Contracts

            @ImportedParamsConstructor("expanded", 1, 2)
            class Expanded {
            }

            @ImportedParamsConstructor(values: []int32{3, 4}, name: "direct")
            class Direct {
            }
            """,
            contracts.Path);

        Assert.True(result.Success, FormatDiagnostics(result));
        var (contractAssembly, assembly) = contracts.LoadWith(result.Image);
        var paramsAttributeType = contractAssembly.GetTypes()
            .Single(type => type.Name == "ImportedParamsConstructorAttribute");
        var expanded = assembly.GetTypes().Single(type => type.Name == "Expanded")
            .GetCustomAttributes(paramsAttributeType, inherit: false).Single();
        var direct = assembly.GetTypes().Single(type => type.Name == "Direct")
            .GetCustomAttributes(paramsAttributeType, inherit: false).Single();

        Assert.Equal("expanded", paramsAttributeType.GetProperty("Name")?.GetValue(expanded));
        Assert.Equal(new[] { 1, 2 }, paramsAttributeType.GetProperty("Values")?.GetValue(expanded));
        Assert.Equal("direct", paramsAttributeType.GetProperty("Name")?.GetValue(direct));
        Assert.Equal(new[] { 3, 4 }, paramsAttributeType.GetProperty("Values")?.GetValue(direct));
    }

    [Fact]
    public void InPositionNamedArguments_CanPrecedePositionalArguments()
    {
        using var contracts = new Issue4503ImportedAttributeContracts();
        var result = Emit(
            """
            import System
            import Issue4503.Contracts

            @ImportedNamedConstructor(first: "imported", 20, third: 30)
            class ImportedMixed {
            }

            class LocalAttribute(First string, Second int32, Third int32) : Attribute {
            }

            @Local(First: "local", 20, Third: 30)
            class LocalMixed {
            }
            """,
            contracts.Path);

        Assert.True(result.Success, FormatDiagnostics(result));
        var (contractAssembly, assembly) = contracts.LoadWith(result.Image);
        var namedAttributeType = contractAssembly.GetTypes()
            .Single(type => type.Name == "ImportedNamedConstructorAttribute");
        var importedData = assembly.GetTypes().Single(type => type.Name == "ImportedMixed")
            .GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType == namedAttributeType);
        var localData = assembly.GetTypes().Single(type => type.Name == "LocalMixed")
            .GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType.Name == "LocalAttribute");

        Assert.Equal(new object[] { "imported", 20, 30 }, importedData.ConstructorArguments.Select(argument => argument.Value));
        Assert.Equal(new object[] { "local", 20, 30 }, localData.ConstructorArguments.Select(argument => argument.Value));
    }

    [Fact]
    public void SameCompilationOverloads_WithDifferentParameterNames_SelectMatchingCandidate()
    {
        var result = Emit(
            """
            import System

            class LocalAttribute : Attribute {
                init(Value int32) {
                }

                init(Text string) {
                }
            }

            @Local(Text: "ok")
            class Tagged {
            }
            """);

        Assert.True(result.Success, FormatDiagnostics(result));
        var assembly = EmittedFixture.Load(result.Image);
        var data = assembly.GetTypes().Single(type => type.Name == "Tagged")
            .GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType.Name == "LocalAttribute");
        Assert.Equal("ok", Assert.Single(data.ConstructorArguments).Value);
    }

    [Fact]
    public void SameCompilationExactConstructor_OutranksOptionalPrimaryConstructor()
    {
        var result = Emit(
            """
            import System

            class LocalAttribute(Value int32 = 1) : Attribute {
                init() {
                }
            }

            @Local
            class Tagged {
            }
            """);

        Assert.True(result.Success, FormatDiagnostics(result));
        var assembly = EmittedFixture.Load(result.Image);
        var data = assembly.GetTypes().Single(type => type.Name == "Tagged")
            .GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType.Name == "LocalAttribute");
        Assert.Empty(data.ConstructorArguments);
    }

    [Theory]
    [InlineData("@ImportedNamedConstructor(\"a\", first: \"b\")", "GS0247")]
    [InlineData("@ImportedNamedConstructor(\"a\", second: 2, second: 3)", "GS0245")]
    [InlineData("@ImportedNamedConstructor(\"a\", Missing: 1)", "GS0613")]
    [InlineData("@ImportedNamedConstructor(\"a\", Missing = 1)", "GS0613")]
    [InlineData("@ImportedNamedConstructor(Missing = 1)", "GS0613")]
    [InlineData("@ImportedNamedConstructor(\"a\", Label = 1)", "GS0614")]
    [InlineData("@ImportedNamedConstructor(\"a\", Item = 1)", "GS0613")]
    [InlineData("@ImportedNamedConstructor(\"a\", Unsupported = nil)", "GS0615")]
    [InlineData("@ImportedNamedConstructor(third: 3, 2)", "GS0583")]
    [InlineData("@ImportedNamedConstructor(Label = \"ok\", \"a\")", "GS0616")]
    public void InvalidNamedAttributeArguments_ReportClearDiagnostics(string annotation, string expectedId)
    {
        using var contracts = new Issue4503ImportedAttributeContracts();
        var result = Emit(
            $$"""
            import Issue4503.Contracts

            {{annotation}}
            class Tagged {
            }
            """,
            contracts.Path);

        var diagnostic = Assert.Single(result.Diagnostics, item => item.Id == expectedId);
        Assert.Equal(2, diagnostic.Location.StartLine);
        Assert.False(result.Success);
    }

    [Fact]
    public void SameCompilationDuplicateNamedConstructorArgument_ReportsDuplicateDiagnostic()
    {
        var result = Emit(
            """
            import System

            class LocalAttribute(Value int32 = 0) : Attribute {
            }

            @Local(Value: 1, Value: 2)
            class Tagged {
            }
            """);

        var diagnostic = Assert.Single(result.Diagnostics, item => item.Id == "GS0245");
        Assert.Equal(5, diagnostic.Location.StartLine);
        Assert.False(result.Success);
    }

    [Fact]
    public void ConstructorParameterAliases_ReportDuplicateNamedDiagnostic()
    {
        using var contracts = new Issue4503ImportedAttributeContracts();
        var result = Emit(
            """
            import Issue4503.Contracts

            @ImportedReservedNamed($params: "a", params__: "b")
            class Tagged {
            }
            """,
            contracts.Path);

        var diagnostic = Assert.Single(result.Diagnostics, item => item.Id == "GS0245");
        Assert.Equal(2, diagnostic.Location.StartLine);
        Assert.False(result.Success);
    }

    private static EmitResult Emit(string source, string referencePath = null)
    {
        using var resolver = ReferenceResolver.WithReferences(
            referencePath is null ? Array.Empty<string>() : new[] { referencePath });
        var compilation = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(source)));
        using var stream = new MemoryStream();
        var result = compilation.Emit(stream);
        return new EmitResult(result.Success, result.Diagnostics, stream.ToArray());
    }

    private static string FormatDiagnostics(EmitResult result)
        => string.Join(Environment.NewLine, result.Diagnostics.Select(diagnostic => diagnostic.ToString()));

    private sealed record EmitResult(
        bool Success,
        System.Collections.Immutable.ImmutableArray<Diagnostic> Diagnostics,
        byte[] Image);
}
