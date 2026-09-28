// <copyright file="Issue4449ArrayPlatformReaderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Core.Tests.ReaderAgreement;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Symbols;

/// <summary>Issue #4449: oblivious array positions have one canonical reading.</summary>
public sealed class Issue4449ArrayPlatformReaderTests : IDisposable
{
    private readonly IDisposable nullabilityScope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes);

    private const string Contract = """
        #nullable disable

        namespace Issue4449.Contract
        {
            public sealed class Surface
            {
                public string[] Field;
                public string[] Property { get; set; }
                public string[] Return() => null;
                public void Parameter(string[] value) { }
                public string[] this[string[] key] => null;
            }
        }
        """;

    /// <inheritdoc/>
    public void Dispose() => this.nullabilityScope.Dispose();

    [Fact]
    public void ObliviousStringArray_Readers_Agree_OnPlatformArrayAndElement()
    {
        using var fixture = new CSharpFixture(Contract);
        var type = Assert.IsAssignableFrom<Type>(
            fixture.Load().GetType("Issue4449.Contract.Surface", throwOnError: true));
        var receiver = ImportedTypeSymbol.Get(type);
        var field = Assert.IsAssignableFrom<FieldInfo>(type.GetField("Field"));
        var property = Assert.IsAssignableFrom<PropertyInfo>(type.GetProperty("Property"));
        var method = Assert.IsAssignableFrom<MethodInfo>(type.GetMethod("Return"));
        var parameterMethod = Assert.IsAssignableFrom<MethodInfo>(type.GetMethod("Parameter"));
        var parameter = parameterMethod.GetParameters()[0];
        var indexer = Assert.IsAssignableFrom<PropertyInfo>(type.GetProperty("Item"));
        var indexParameter = indexer.GetIndexParameters()[0];

        var readers = new Dictionary<string, TypeSymbol>
        {
            ["field-direct"] = ClrNullability.GetFieldTypeSymbol(field),
            ["field-member"] = MemberLookup.GetClrFieldTypeSymbol(receiver, field),
            ["property-direct"] = ClrNullability.GetPropertyTypeSymbol(property),
            ["property-member"] = MemberLookup.GetClrPropertyTypeSymbol(receiver, property),
            ["return-direct"] = ClrNullability.GetReturnTypeSymbol(method),
            ["return-member"] = MemberLookup.GetClrMethodReturnTypeSymbol(receiver, method),
            ["parameter-direct"] = ClrNullability.GetParameterTypeSymbol(parameter),
            ["parameter-member"] = MemberLookup.GetClrMethodParameterTypeSymbol(receiver, parameterMethod, 0),
            ["indexer-direct"] = ClrNullability.GetPropertyTypeSymbol(indexer),
            ["indexer-member"] = MemberLookup.GetClrPropertyTypeSymbol(receiver, indexer),
            ["index-parameter-direct"] = ClrNullability.GetParameterTypeSymbol(indexParameter),
            ["index-parameter-member"] = MemberLookup.GetIndexerParameterTypeSymbol(receiver, indexer, 0),
        };

        Assert.All(readers, pair => Assert.Equal("!<!>", ReaderAgreementHarness.Shape(pair.Value)));
        Assert.Single(readers.Values.Select(typeSymbol => ReaderAgreementHarness.Shape(typeSymbol)).Distinct());
    }

    [Theory]
    [InlineData("Surface().Field")]
    [InlineData("Surface().Property")]
    [InlineData("Surface().Return()")]
    [InlineData("Surface()[Surface().Field]")]
    public void BoundMemberReads_UseTheSameCanonicalShape(string expression)
    {
        using var fixture = new CSharpFixture(Contract);

        Assert.Equal("[]!string!", ProbeType(fixture, expression));
    }

    [Fact]
    public void FileReadAllLines_FromNetStandard20_IsPlatformAtBothArrayPositions()
    {
        var referenceDirectory = Assert.IsType<string>(typeof(Issue4449ArrayPlatformReaderTests).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "NetStandard20ReferenceDirectory")
            .Value);
        var paths = Directory.EnumerateFiles(referenceDirectory, "*.dll").ToArray();
        using var resolver = ReferenceResolver.WithReferences(paths);
        var fileType = Assert.IsAssignableFrom<Type>(resolver.Assemblies
            .Select(assembly => assembly.GetType("System.IO.File"))
            .FirstOrDefault(type => type != null));
        var method = fileType.GetMethods()
            .Single(candidate => candidate.Name == "ReadAllLines"
                && candidate.GetParameters() is [{ ParameterType.FullName: "System.String" }]);

        var result = ClrNullability.GetReturnTypeSymbol(method);

        Assert.Equal("!<!>", ReaderAgreementHarness.Shape(result));
        Assert.Equal("[]!string!", SymbolDisplay.ToTypeDisplayString(result));
    }

    [Fact]
    public void AnnotatedAndValueTypeArrays_KeepTheirDeclaredPositions()
    {
        using var fixture = new CSharpFixture("""
            #nullable enable

            public sealed class Controls
            {
                public string[] NonNull = [];
                public string?[] NullableElement = [];
                public string[]? NullableArray;
                public int[] Values = [];
                public string?[,] Grid = new string?[1, 1];
            }
            """);
        var type = Assert.IsAssignableFrom<Type>(
            fixture.Load().GetType("Controls", throwOnError: true));

        Assert.Equal("n<n>", Shape(type, "NonNull"));
        Assert.Equal("n<?>", Shape(type, "NullableElement"));
        Assert.Equal("?<n>", Shape(type, "NullableArray"));
        Assert.Equal("n<v>", Shape(type, "Values"));
        Assert.Equal("n<?>", Shape(type, "Grid"));

        static string Shape(Type type, string fieldName)
            => ReaderAgreementHarness.Shape(
                ClrNullability.GetFieldTypeSymbol(
                    Assert.IsAssignableFrom<FieldInfo>(type.GetField(fieldName))));
    }

    [Fact]
    public void SymbolicGenericAndByRefArrayPositions_KeepTheirElementFacts()
    {
        using var fixture = new CSharpFixture("""
            #nullable disable

            public sealed class Box<T>
            {
                public T[] Values;
                public ref T[] RefReturn() => throw null;
                public void RefParameter(ref T[] values) { }
            }
            """);
        var type = Assert.IsAssignableFrom<Type>(
            fixture.Load().GetType("Box`1", throwOnError: true)).MakeGenericType(typeof(string));
        var receiver = ImportedTypeSymbol.Get(type);
        var field = Assert.IsAssignableFrom<FieldInfo>(type.GetField("Values"));
        var returnMethod = Assert.IsAssignableFrom<MethodInfo>(type.GetMethod("RefReturn"));
        var parameterMethod = Assert.IsAssignableFrom<MethodInfo>(type.GetMethod("RefParameter"));

        Assert.Equal("!<n>", ReaderAgreementHarness.Shape(MemberLookup.GetClrFieldTypeSymbol(receiver, field)));
        Assert.Equal(
            "!<n>",
            ReaderAgreementHarness.Shape(
                Assert.IsType<ByRefTypeSymbol>(
                    MemberLookup.GetClrMethodReturnTypeSymbol(receiver, returnMethod)).PointeeType));
        Assert.Equal(
            "!<n>",
            ReaderAgreementHarness.Shape(
                Assert.IsType<ByRefTypeSymbol>(
                    MemberLookup.GetClrMethodParameterTypeSymbol(receiver, parameterMethod, 0)).PointeeType));
    }

    [Theory]
    [InlineData("surface.Field")]
    [InlineData("surface.Property")]
    [InlineData("surface.Return()")]
    [InlineData("surface[surface.Field]")]
    public void PlatformElementArray_DoesNotConvertToNonNullElementArray(string expression)
    {
        using var fixture = new CSharpFixture(Contract);
        var diagnostics = CompileErrors(
            fixture,
            $$"""
            import Issue4449.Contract
            func Probe(surface Surface) int32 {
                var values []string
                values = {{expression}}
                return values.Length
            }
            """);

        Assert.Contains(
            diagnostics,
            diagnostic => diagnostic.Id == "GS0155"
                && diagnostic.Message.Contains("[]!string!", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("surface.Field")]
    [InlineData("surface.Return()")]
    public void PlatformElementArray_StillConvertsToNullableElementArray(string expression)
    {
        using var fixture = new CSharpFixture(Contract);
        var diagnostics = CompileErrors(
            fixture,
            $$"""
            import Issue4449.Contract
            func Probe(surface Surface) int32 {
                var values []string?
                values = {{expression}}
                return values.Length
            }
            """);

        Assert.Empty(diagnostics);
    }

    private static string ProbeType(CSharpFixture fixture, string expression)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture.AssemblyPath });
        var compilation = new Compilation(
            resolver,
            GsSyntaxTree.Parse(SourceText.From(
                "import Issue4449.Contract\nlet probe = " + expression)))
        {
            Nullability = NullabilityMode.PlatformTypes,
        };
        Assert.Empty(compilation.GlobalScope.Diagnostics.Where(diagnostic => diagnostic.IsError));
        var type = Assert.Single(compilation.GlobalScope.Variables, variable => variable.Name == "probe").Type;
        return SymbolDisplay.ToTypeDisplayString(type);
    }

    private static IReadOnlyList<GSharp.Core.CodeAnalysis.Diagnostic> CompileErrors(
        CSharpFixture fixture,
        string source)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { fixture.AssemblyPath });
        var compilation = new Compilation(resolver, GsSyntaxTree.Parse(SourceText.From(source)))
        {
            Nullability = NullabilityMode.PlatformTypes,
        };
        return compilation.GlobalScope.Diagnostics
            .Concat(compilation.BoundProgram.Diagnostics)
            .Where(diagnostic => diagnostic.IsError)
            .ToArray();
    }
}
