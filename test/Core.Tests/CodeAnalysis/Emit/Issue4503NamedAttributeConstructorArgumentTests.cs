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
        var assembly = Assembly.Load(result.Image);
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
        var result = Emit(
            """
            import GSharp.Core.Tests.Fixtures

            @ImportedNamedConstructor("first", third: 30, Label = "ok", Code = 40)
            class Tagged {
            }
            """);

        Assert.True(result.Success, FormatDiagnostics(result));
        var assembly = Assembly.Load(result.Image);
        var tagged = assembly.GetTypes().Single(type => type.Name == "Tagged");

        var data = tagged.GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType == typeof(ImportedNamedConstructorAttribute));
        Assert.Equal(new object[] { "first", 2, 30 }, data.ConstructorArguments.Select(argument => argument.Value));
        Assert.Equal(
            new[] { "Code", "Label" },
            data.NamedArguments.Select(argument => argument.MemberName).OrderBy(name => name));
        Assert.True(data.NamedArguments.Single(argument => argument.MemberName == "Label").IsField == false);
        Assert.True(data.NamedArguments.Single(argument => argument.MemberName == "Code").IsField);

        var instance = Assert.IsType<ImportedNamedConstructorAttribute>(
            tagged.GetCustomAttributes(typeof(ImportedNamedConstructorAttribute), inherit: false).Single());
        Assert.Equal("first", instance.First);
        Assert.Equal(2, instance.Second);
        Assert.Equal(30, instance.Third);
        Assert.Equal("ok", instance.Label);
        Assert.Equal(40, instance.Code);
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
        var assembly = Assembly.Load(result.Image);
        var tagged = assembly.GetTypes().Single(type => type.Name == "Tagged");
        var data = tagged.GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType.Name == "LocalAttribute");
        Assert.Equal(new object[] { "first", 2, 30 }, data.ConstructorArguments.Select(argument => argument.Value));
    }

    [Fact]
    public void ParamsConstructorArguments_PreserveDirectAndExpandedForms()
    {
        var result = Emit(
            """
            import GSharp.Core.Tests.Fixtures

            @ImportedParamsConstructor("expanded", 1, 2)
            class Expanded {
            }

            @ImportedParamsConstructor(values: []int32{3, 4}, name: "direct")
            class Direct {
            }
            """);

        Assert.True(result.Success, FormatDiagnostics(result));
        var assembly = Assembly.Load(result.Image);
        var expanded = Assert.IsType<ImportedParamsConstructorAttribute>(
            assembly.GetTypes().Single(type => type.Name == "Expanded")
                .GetCustomAttributes(typeof(ImportedParamsConstructorAttribute), inherit: false).Single());
        var direct = Assert.IsType<ImportedParamsConstructorAttribute>(
            assembly.GetTypes().Single(type => type.Name == "Direct")
                .GetCustomAttributes(typeof(ImportedParamsConstructorAttribute), inherit: false).Single());

        Assert.Equal("expanded", expanded.Name);
        Assert.Equal(new[] { 1, 2 }, expanded.Values);
        Assert.Equal("direct", direct.Name);
        Assert.Equal(new[] { 3, 4 }, direct.Values);
    }

    [Fact]
    public void InPositionNamedArguments_CanPrecedePositionalArguments()
    {
        var result = Emit(
            """
            import System
            import GSharp.Core.Tests.Fixtures

            @ImportedNamedConstructor(first: "imported", 20, third: 30)
            class ImportedMixed {
            }

            class LocalAttribute(First string, Second int32, Third int32) : Attribute {
            }

            @Local(First: "local", 20, Third: 30)
            class LocalMixed {
            }
            """);

        Assert.True(result.Success, FormatDiagnostics(result));
        var assembly = Assembly.Load(result.Image);
        var importedData = assembly.GetTypes().Single(type => type.Name == "ImportedMixed")
            .GetCustomAttributesData()
            .Single(attribute => attribute.AttributeType == typeof(ImportedNamedConstructorAttribute));
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
        var assembly = Assembly.Load(result.Image);
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
        var assembly = Assembly.Load(result.Image);
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
        var result = Emit(
            $$"""
            import GSharp.Core.Tests.Fixtures

            {{annotation}}
            class Tagged {
            }
            """);

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
        var result = Emit(
            """
            import GSharp.Core.Tests.Fixtures

            @ImportedReservedNamed($params: "a", params__: "b")
            class Tagged {
            }
            """);

        var diagnostic = Assert.Single(result.Diagnostics, item => item.Id == "GS0245");
        Assert.Equal(2, diagnostic.Location.StartLine);
        Assert.False(result.Success);
    }

    private static EmitResult Emit(string source)
    {
        using var resolver = ReferenceResolver.WithReferences(
            new[] { typeof(ImportedNamedConstructorAttribute).Assembly.Location });
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
