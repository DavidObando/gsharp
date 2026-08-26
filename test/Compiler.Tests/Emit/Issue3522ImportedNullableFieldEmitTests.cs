// <copyright file="Issue3522ImportedNullableFieldEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3522ImportedNullableFieldEmitTests
{
    private static readonly byte[] Tuple8Flags = { 0, 2, 1, 1, 1, 1, 1, 1, 0, 2 };
    private static readonly byte[] Tuple15Flags = { 0, 2, 1, 1, 1, 1, 1, 1, 0, 2, 1, 1, 1, 1, 1, 1, 0, 2 };

    private const string MetadataSource = """
        #nullable enable
        using System;
        using System.Collections.Generic;

        namespace Issue3522.Metadata
        {
            public sealed class PairContainer<TFirst, TSecond>
            {
                public TFirst First = default!;
                public TSecond Second = default!;
            }

            public struct ValueContainer<T>
            {
                public T Value;
            }

            public class GenericBase<T>
            {
                public T Value = default!;
            }

            public sealed class GenericDerived<TFirst, TSecond>
                : GenericBase<TSecond>
            {
            }

            public class GenericMiddle<TLeft, TRight>
                : GenericBase<TLeft>
            {
            }

            public sealed class GenericLeaf<TFirst, TSecond>
                : GenericMiddle<TSecond, TFirst>
            {
            }

            public static class DirectFields
            {
                public static string Required = "";
                public static string?[]? ScalarNullableArray;
                public static List<string?>? ScalarNullableGeneric = new();
                public static string[]? NullableOuterArray;
                public static List<string>? NullableOuterGeneric;
                public static Dictionary<ValueTuple<string?>, object> ValueTupleKey = new();
                public static (object Value, string? Text)? NullableTuple;
                public static PairContainer<KeyValuePair<string?, object>?, string>
                    NullablePairContainer = new();
                public static (List<string?>? Values, string Required) NestedScalarTuple =
                    (new(), "");
                public static (
                    string? E1,
                    string E2,
                    string E3,
                    string E4,
                    string E5,
                    string E6,
                    string E7,
                    string? E8) Tuple8 =
                    (null, "", "", "", "", "", "", null);
                public static (
                    string? E1,
                    string E2,
                    string E3,
                    string E4,
                    string E5,
                    string E6,
                    string E7,
                    string? E8,
                    string E9,
                    string E10,
                    string E11,
                    string E12,
                    string E13,
                    string E14,
                    string? E15) Tuple15 =
                    (null, "", "", "", "", "", "", null, "", "", "", "", "", "", null);
                public static string[] NonNullArray = Array.Empty<string>();
                public static GenericDerived<string?, string>
                    DerivedSecondNonNull = new();
                public static GenericDerived<string, string?>
                    DerivedSecondNullable = new();
                public static GenericLeaf<string?, string>
                    LeafSecondNonNull = new();
                public static GenericLeaf<string, string?>
                    LeafSecondNullable = new();
            }

            public static class GenericMethods
            {
                public static PairContainer<T, string?> MakeStructPair<T>()
                    where T : struct => new();

                public static PairContainer<T, string> MakeRequiredStructPair<T>()
                    where T : struct => new();

                public static ValueContainer<T> MakeStructValue<T>()
                    where T : struct => default;
            }

            public static class ContextFields
            {
                public static string?[]? Values;
                public static string? Marker;
            }
        }

        #nullable disable
        namespace Issue3522.Metadata
        {
            public static class ObliviousFields
            {
                public static string[] Values;
            }
        }
        """;

    private const string LibrarySource = """
        package Issue3522.Library
        import System.Collections.Generic

        public data struct Badge {
          public var Content string?
        }

        public data struct RequiredBadge {
          public var Content string
        }

        public data struct FieldShapes {
          public var OptionalCount int32?
          public var Nested Dictionary[string, List[string?]?]
          public var Values []string?
        }
        """;

    [Fact]
    public void NullableReferenceField_LiteralAndWith_RunAndVerifyAcrossProjectReference()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3522.App

            import Issue3522.Library

            func Main() int32 {
              let first = Badge{ Content:nil }
              let second = first with{ Content = nil }
              return second.Content == nil ? 0 : 1
            }
            """;

        var result = Compile(
            artifacts.Directory,
            "Issue3522.App",
            source,
            target: "exe",
            artifacts.LibraryPath);

        Assert.True(result.ExitCode == 0, result.Diagnostics);
        IlVerifier.Verify(result.OutputPath, new[] { artifacts.LibraryPath });
        Assert.Equal(0, Run(result.OutputPath));
    }

    [Fact]
    public void SemanticAggregate_DecodesDirectContextValueGenericAndArrayFieldShapes()
    {
        using var artifacts = new TestArtifacts();
        using var resolver = ReferenceResolver.WithReferences(new[] { artifacts.LibraryPath });
        resolver.CurrentAssemblyName = "Issue3522.Consumer";

        Assert.True(resolver.TryResolveType("Issue3522.Library.Badge", out var badgeType));
        Assert.True(resolver.TryResolveType("Issue3522.Library.RequiredBadge", out var requiredBadgeType));
        Assert.True(resolver.TryResolveType("Issue3522.Library.FieldShapes", out var shapesType));

        Assert.Equal(new byte[] { 2 }, GetNullableFlags(badgeType.GetField("Content")!));
        Assert.Empty(GetNullableFlags(requiredBadgeType.GetField("Content")!));
        Assert.Equal((byte)1, GetNullableContext(requiredBadgeType));
        Assert.Equal(new byte[] { 1, 1, 2, 2 }, GetNullableFlags(shapesType.GetField("Nested")!));
        Assert.Equal(new byte[] { 1, 2 }, GetNullableFlags(shapesType.GetField("Values")!));

        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(badgeType, resolver, out var badge));
        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(requiredBadgeType, resolver, out var requiredBadge));
        Assert.True(ImportedTypeSymbol.TryCreateSemanticAggregate(shapesType, resolver, out var shapes));

        var optionalContent = Assert.IsType<NullableTypeSymbol>(badge.Fields.Single().Type);
        Assert.Same(TypeSymbol.String, optionalContent.UnderlyingType);
        Assert.Same(TypeSymbol.String, requiredBadge.Fields.Single().Type);

        var optionalCount = Assert.IsType<NullableTypeSymbol>(
            shapes.Fields.Single(field => field.Name == "OptionalCount").Type);
        Assert.Same(TypeSymbol.Int32, optionalCount.UnderlyingType);

        var nested = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            shapes.Fields.Single(field => field.Name == "Nested").Type);
        Assert.Same(TypeSymbol.String, nested.GetTypeArgumentSymbol(0));
        var nullableList = Assert.IsType<NullableTypeSymbol>(nested.GetTypeArgumentSymbol(1));
        var list = Assert.IsType<NullabilityAnnotatedTypeSymbol>(nullableList.UnderlyingType);
        var nullableListItem = Assert.IsType<NullableTypeSymbol>(list.GetTypeArgumentSymbol(0));
        Assert.Same(TypeSymbol.String, nullableListItem.UnderlyingType);

        var values = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            shapes.Fields.Single(field => field.Name == "Values").Type);
        var nullableElement = Assert.IsType<NullableTypeSymbol>(
            values.GetTypeArgumentSymbolForClrType(values.ClrType!.GetElementType()));
        Assert.Same(TypeSymbol.String, nullableElement.UnderlyingType);
    }

    [Fact]
    public void MetadataFixture_CoversScalarContextObliviousValueTupleAndOuterNullableShapes()
    {
        using var artifacts = new TestArtifacts();
        using var resolver = ReferenceResolver.WithReferences(new[] { artifacts.MetadataPath });

        Assert.True(resolver.TryResolveType("Issue3522.Metadata.DirectFields", out var direct));
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.GenericMethods", out var genericMethods));
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.ContextFields", out var context));
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.ObliviousFields", out var oblivious));

        Assert.Equal((byte)1, GetNullableContext(direct));
        Assert.Equal(new byte[] { 2 }, GetNullableFlags(direct.GetField("ScalarNullableArray")!));
        Assert.Equal(new byte[] { 2 }, GetNullableFlags(direct.GetField("ScalarNullableGeneric")!));
        Assert.Equal(new byte[] { 2, 1 }, GetNullableFlags(direct.GetField("NullableOuterArray")!));
        Assert.Equal(new byte[] { 2, 1 }, GetNullableFlags(direct.GetField("NullableOuterGeneric")!));
        Assert.Equal(new byte[] { 1, 0, 2, 1 }, GetNullableFlags(direct.GetField("ValueTupleKey")!));
        Assert.Equal(new byte[] { 0, 1, 2 }, GetNullableFlags(direct.GetField("NullableTuple")!));
        Assert.Equal(
            new byte[] { 1, 0, 2, 1, 1 },
            GetNullableFlags(direct.GetField("NullablePairContainer")!));
        Assert.Equal(
            new byte[] { 0, 2, 2, 1 },
            GetNullableFlags(direct.GetField("NestedScalarTuple")!));
        Assert.Equal(Tuple8Flags, GetNullableFlags(direct.GetField("Tuple8")!));
        Assert.Equal(Tuple15Flags, GetNullableFlags(direct.GetField("Tuple15")!));
        Assert.Empty(GetNullableFlags(direct.GetField("NonNullArray")!));

        var pairMethod = genericMethods.GetMethod("MakeStructPair")!;
        Assert.Equal(
            new byte[] { 1, 0, 2 },
            GetNullableFlags(pairMethod.ReturnParameter));
        Assert.Equal(
            new byte[] { 1, 0, 1 },
            GetNullableFlags(
                genericMethods.GetMethod("MakeRequiredStructPair")!.ReturnParameter));
        var metadataInt = resolver.MapClrTypeToReferences(typeof(int));
        var closedOptionalPair = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(
                pairMethod.MakeGenericMethod(metadataInt)));
        Assert.IsType<NullableTypeSymbol>(
            closedOptionalPair.GetTypeArgumentSymbol(1));
        var closedRequiredPair = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(
                genericMethods.GetMethod("MakeRequiredStructPair")!
                    .MakeGenericMethod(metadataInt)));
        Assert.IsNotType<NullableTypeSymbol>(
            closedRequiredPair.GetTypeArgumentSymbol(1));
        var valueMethod = genericMethods.GetMethod("MakeStructValue")!;
        Assert.Empty(GetNullableFlags(valueMethod.ReturnParameter));
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(valueMethod.ReturnType));
        var valueSymbol = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.GetReturnTypeSymbol(valueMethod));
        Assert.Equal(
            new byte[] { 0, 0 },
            NullableFlagsBuilder.Build(valueSymbol).ToArray());

        Assert.Equal((byte)2, GetNullableContext(context));
        Assert.Empty(GetNullableFlags(context.GetField("Values")!));

        Assert.Null(TryGetNullableContext(oblivious));
        Assert.Empty(GetNullableFlags(oblivious.GetField("Values")!));
    }

    [Fact]
    public void MetadataFields_DecodeScalarContextObliviousAndValueTuplePositions()
    {
        using var artifacts = new TestArtifacts();
        using var resolver = ReferenceResolver.WithReferences(new[] { artifacts.MetadataPath });

        Assert.True(resolver.TryResolveType("Issue3522.Metadata.DirectFields", out var direct));
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.ContextFields", out var context));
        Assert.True(resolver.TryResolveType("Issue3522.Metadata.ObliviousFields", out var oblivious));

        AssertArray(
            direct.GetField("ScalarNullableArray")!,
            outerNullable: true,
            elementNullable: true);
        AssertArray(
            context.GetField("Values")!,
            outerNullable: true,
            elementNullable: true);
        AssertArray(
            oblivious.GetField("Values")!,
            outerNullable: true,
            elementNullable: true);
        AssertArray(
            direct.GetField("NonNullArray")!,
            outerNullable: false,
            elementNullable: false);

        var dictionary = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.GetFieldTypeSymbol(direct.GetField("ValueTupleKey")!));
        var tuple = Assert.IsType<NullabilityAnnotatedTypeSymbol>(dictionary.GetTypeArgumentSymbol(0));
        var nullableTupleItem = Assert.IsType<NullableTypeSymbol>(tuple.GetTypeArgumentSymbol(0));
        Assert.Same(TypeSymbol.String, nullableTupleItem.UnderlyingType);
        Assert.Same(TypeSymbol.Object, dictionary.GetTypeArgumentSymbol(1));

        var nullableTuple = Assert.IsType<NullableTypeSymbol>(
            ClrNullability.GetFieldTypeSymbol(direct.GetField("NullableTuple")!));
        var tupleValue = Assert.IsType<TupleTypeSymbol>(nullableTuple.UnderlyingType);
        Assert.Same(TypeSymbol.Object, tupleValue.ElementTypes[0]);
        Assert.IsType<NullableTypeSymbol>(tupleValue.ElementTypes[1]);

        var pairContainer = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            ClrNullability.GetFieldTypeSymbol(direct.GetField("NullablePairContainer")!));
        var nullablePair = Assert.IsType<NullableTypeSymbol>(
            pairContainer.GetTypeArgumentSymbol(0));
        var pair = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            nullablePair.UnderlyingType);
        Assert.IsType<NullableTypeSymbol>(pair.GetTypeArgumentSymbol(0));
        Assert.Same(TypeSymbol.Object, pair.GetTypeArgumentSymbol(1));
        Assert.Same(TypeSymbol.String, pairContainer.GetTypeArgumentSymbol(1));

        var nestedScalarTuple = AssertTupleField(
            direct.GetField("NestedScalarTuple")!,
            2,
            0);
        var nestedList = Assert.IsType<NullabilityAnnotatedTypeSymbol>(
            Assert.IsType<NullableTypeSymbol>(
                nestedScalarTuple.ElementTypes[0]).UnderlyingType);
        Assert.IsType<NullableTypeSymbol>(nestedList.GetTypeArgumentSymbol(0));
        AssertTupleField(direct.GetField("Tuple8")!, 8, 0, 7);
        AssertTupleField(direct.GetField("Tuple15")!, 15, 0, 7, 14);
    }

    [Fact]
    public void MetadataArrayFields_AcceptNilAtNullableOuterAndElementPositions()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3522.MetadataConsumer

            import Issue3522.Metadata

            func Main() int32 {
              let values = []string?{nil}

              DirectFields.ScalarNullableArray = nil
              DirectFields.ScalarNullableArray = values
              DirectFields.ScalarNullableArray!![0] = nil

              ContextFields.Values = nil
              ContextFields.Values = values
              ContextFields.Values!![0] = nil

              ObliviousFields.Values = nil
              ObliviousFields.Values = values
              ObliviousFields.Values!![0] = nil

              return DirectFields.ScalarNullableArray!![0] == nil
                && ContextFields.Values!![0] == nil
                && ObliviousFields.Values!![0] == nil ? 0 : 1
            }
            """;

        var result = Compile(
            artifacts.Directory,
            "Issue3522.MetadataConsumer",
            source,
            target: "exe",
            artifacts.MetadataPath);

        Assert.True(result.ExitCode == 0, result.Diagnostics);
        IlVerifier.Verify(result.OutputPath, new[] { artifacts.MetadataPath });
        Assert.Equal(0, Run(result.OutputPath));
    }

    [Fact]
    public void InheritedGenericFields_ProjectDeclaringTypeArguments()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3522.InheritedFields

            import Issue3522.Metadata

            func Main() int32 {
              DirectFields.DerivedSecondNonNull.Value = "derived"
              let derived string = DirectFields.DerivedSecondNonNull.Value
              DirectFields.DerivedSecondNullable.Value = nil
              let derivedNullable string? = DirectFields.DerivedSecondNullable.Value

              DirectFields.LeafSecondNonNull.Value = "leaf"
              let leaf string = DirectFields.LeafSecondNonNull.Value
              DirectFields.LeafSecondNullable.Value = nil
              let leafNullable string? = DirectFields.LeafSecondNullable.Value

              return derived == "derived"
                && derivedNullable == nil
                && leaf == "leaf"
                && leafNullable == nil ? 0 : 1
            }
            """;

        var result = Compile(
            artifacts.Directory,
            "Issue3522.InheritedFields",
            source,
            target: "exe",
            artifacts.MetadataPath);

        Assert.True(result.ExitCode == 0, result.Diagnostics);
        IlVerifier.Verify(result.OutputPath, new[] { artifacts.MetadataPath });
        Assert.Equal(0, Run(result.OutputPath));
    }

    [Fact]
    public void InheritedGenericFields_RejectNilInProjectedNonNullableSlots()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3522.InheritedFieldsNegative

            import Issue3522.Metadata

            func Break() {
              DirectFields.DerivedSecondNonNull.Value = nil
              let derived string = DirectFields.DerivedSecondNullable.Value
              DirectFields.LeafSecondNonNull.Value = nil
              let leaf string = DirectFields.LeafSecondNullable.Value
            }
            """;

        var result = Compile(
            artifacts.Directory,
            "Issue3522.InheritedFieldsNegative",
            source,
            target: "library",
            artifacts.MetadataPath);

        Assert.NotEqual(0, result.ExitCode);
        Assert.True(
            Regex.Matches(result.Diagnostics, @"\berror GS0155:").Count == 4,
            result.Diagnostics);
        Assert.DoesNotContain("GS9998", result.Diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void MetadataNonNullablePositions_RejectNil()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3522.MetadataNegative

            import Issue3522.Metadata

            func Break() {
              DirectFields.NonNullArray = nil
              DirectFields.NonNullArray[0] = nil

              DirectFields.NullablePairContainer.First = nil
              DirectFields.NullablePairContainer.Second = nil

              var optionalPair = GenericMethods.MakeStructPair[int32]()
              optionalPair.Second = nil
              var requiredPair = GenericMethods.MakeRequiredStructPair[int32]()
              requiredPair.Second = nil
            }
            """;

        var result = Compile(
            artifacts.Directory,
            "Issue3522.MetadataNegative",
            source,
            target: "library",
            artifacts.MetadataPath);

        Assert.NotEqual(0, result.ExitCode);
        Assert.True(
            Regex.Matches(result.Diagnostics, @"\berror GS0155:").Count == 4,
            result.Diagnostics);
        Assert.Contains("Cannot convert type 'nil' to 'string[]'.", result.Diagnostics, StringComparison.Ordinal);
        Assert.Contains("Cannot convert type 'nil' to 'string'.", result.Diagnostics, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedNullableOuterArrayAndGeneric_ReemitExactInnerFlags()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3522.Reemit

            import Issue3522.Metadata

            public func ReemitStructPair[T struct]() PairContainer[T, string?] ->
              GenericMethods.MakeStructPair[T]()
            public func ReemitRequiredStructPair[T struct]() PairContainer[T, string] ->
              GenericMethods.MakeRequiredStructPair[T]()
            public func ReemitStructValue[T struct]() ValueContainer[T] ->
              GenericMethods.MakeStructValue[T]()

            public var OuterArray = DirectFields.NullableOuterArray
            public var OuterGeneric = DirectFields.NullableOuterGeneric
            public var ScalarArray = DirectFields.ScalarNullableArray
            public var ScalarGeneric = DirectFields.ScalarNullableGeneric
            public var NullableTuple = DirectFields.NullableTuple
            public var NullablePairContainer = DirectFields.NullablePairContainer
            public var NestedScalarTuple = (DirectFields.ScalarNullableGeneric, "")
            public var Tuple8 = DirectFields.Tuple8
            public var Tuple15 = DirectFields.Tuple15

            NestedScalarTuple.Item1!!.Add(nil)
            """;

        var result = Compile(
            artifacts.Directory,
            "Issue3522.Reemit",
            source,
            target: "exe",
            artifacts.MetadataPath);

        Assert.True(result.ExitCode == 0, result.Diagnostics);
        IlVerifier.Verify(result.OutputPath, new[] { artifacts.MetadataPath });

        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location)!;
        var metadataResolver = new PathAssemblyResolver(
            Directory.GetFiles(runtimeDirectory, "*.dll")
                .Concat(new[] { artifacts.MetadataPath, result.OutputPath }));
        using (var metadataContext = new MetadataLoadContext(metadataResolver, "System.Private.CoreLib"))
        {
            var assembly = metadataContext.LoadFromAssemblyPath(result.OutputPath);
            var program = assembly.GetTypes().Single(type => type.Name == "<Program>");
            Assert.Equal(new byte[] { 2, 1 }, GetNullableFlags(program.GetField("OuterArray")!));
            Assert.Equal(new byte[] { 2, 1 }, GetNullableFlags(program.GetField("OuterGeneric")!));
            Assert.Equal(new byte[] { 2 }, GetNullableFlags(program.GetField("ScalarArray")!));
            Assert.Equal(new byte[] { 2 }, GetNullableFlags(program.GetField("ScalarGeneric")!));
            Assert.Equal(new byte[] { 0, 1, 2 }, GetNullableFlags(program.GetField("NullableTuple")!));
            Assert.Equal(
                new byte[] { 1, 0, 2, 1, 1 },
                GetNullableFlags(program.GetField("NullablePairContainer")!));
            Assert.Equal(
                new byte[] { 0, 2, 2, 1 },
                GetNullableFlags(program.GetField("NestedScalarTuple")!));
            Assert.Equal(Tuple8Flags, GetNullableFlags(program.GetField("Tuple8")!));
            Assert.Equal(Tuple15Flags, GetNullableFlags(program.GetField("Tuple15")!));
            Assert.Equal(
                new byte[] { 1, 0, 2 },
                GetNullableFlags(
                    program.GetMethod("ReemitStructPair")!.ReturnParameter));
            Assert.Equal(
                new byte[] { 1, 0, 1 },
                GetNullableFlags(
                    program.GetMethod("ReemitRequiredStructPair")!.ReturnParameter));
            Assert.Equal(
                new byte[] { 0, 0 },
                GetNullableFlags(
                    program.GetMethod("ReemitStructValue")!.ReturnParameter));
        }

        Assert.Equal(0, Run(result.OutputPath));
    }

    [Fact]
    public void NonNullableReferenceField_StillRejectsNilInLiteralAndWith()
    {
        using var artifacts = new TestArtifacts();
        const string source = """
            package Issue3522.Negative

            import Issue3522.Library

            func Build() RequiredBadge {
              let first = RequiredBadge{ Content:nil }
              return first with{ Content = nil }
            }
            """;

        var result = Compile(
            artifacts.Directory,
            "Issue3522.Negative",
            source,
            target: "library",
            artifacts.LibraryPath);

        Assert.NotEqual(0, result.ExitCode);
        Assert.Equal(2, Regex.Matches(result.Diagnostics, @"\berror GS0155:").Count);
        Assert.Contains("Cannot convert type 'nil' to 'string'.", result.Diagnostics, StringComparison.Ordinal);
        Assert.DoesNotContain("GS9998", result.Diagnostics, StringComparison.Ordinal);
    }

    private static (int ExitCode, string Diagnostics, string OutputPath) Compile(
        string directory,
        string assemblyName,
        string source,
        string target,
        params string[] references)
    {
        var sourcePath = Path.Combine(directory, assemblyName + ".gs");
        var outputPath = Path.Combine(directory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references)
        {
            args.Add("/reference:" + reference);
        }

        args.Add(sourcePath);
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            var exitCode = Program.Main(args.ToArray());
            return (exitCode, stdout.ToString() + stderr, outputPath);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static int Run(string assemblyPath)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        }) ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(process.ExitCode >= 0, $"process failed\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return process.ExitCode;
    }

    private static byte[] GetNullableFlags(ICustomAttributeProvider provider)
    {
        var attributes = provider switch
        {
            MemberInfo member => member.GetCustomAttributesData(),
            ParameterInfo parameter => parameter.GetCustomAttributesData(),
            _ => throw new ArgumentException("Unsupported attribute provider.", nameof(provider)),
        };
        var attribute = attributes.SingleOrDefault(
            data => data.AttributeType.FullName == "System.Runtime.CompilerServices.NullableAttribute");
        if (attribute == null)
        {
            return Array.Empty<byte>();
        }

        var value = attribute.ConstructorArguments.Single().Value;
        if (value is byte scalar)
        {
            return new[] { scalar };
        }

        return ((IEnumerable<CustomAttributeTypedArgument>)value!)
            .Select(argument => (byte)argument.Value!)
            .ToArray();
    }

    private static byte GetNullableContext(MemberInfo member)
        => Assert.IsType<byte>(TryGetNullableContext(member));

    private static byte? TryGetNullableContext(MemberInfo member)
    {
        var attribute = member.GetCustomAttributesData().SingleOrDefault(
            data => data.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");
        return attribute == null
            ? null
            : (byte)attribute.ConstructorArguments.Single().Value!;
    }

    private static void AssertArray(FieldInfo field, bool outerNullable, bool elementNullable)
    {
        var fieldType = ClrNullability.GetFieldTypeSymbol(field);
        var array = outerNullable
            ? Assert.IsType<NullabilityAnnotatedTypeSymbol>(
                Assert.IsType<NullableTypeSymbol>(fieldType).UnderlyingType)
            : Assert.IsType<NullabilityAnnotatedTypeSymbol>(fieldType);
        var element = array.GetTypeArgumentSymbolForClrType(array.ClrType!.GetElementType());
        if (elementNullable)
        {
            var nullable = Assert.IsType<NullableTypeSymbol>(element);
            Assert.Same(TypeSymbol.String, nullable.UnderlyingType);
        }
        else
        {
            Assert.Same(TypeSymbol.String, element);
        }
    }

    private static TupleTypeSymbol AssertTupleField(
        FieldInfo field,
        int arity,
        params int[] nullableIndices)
    {
        var tuple = Assert.IsType<TupleTypeSymbol>(
            ClrNullability.GetFieldTypeSymbol(field));
        Assert.Equal(arity, tuple.Arity);
        for (var i = 0; i < tuple.Arity; i++)
        {
            if (nullableIndices.Contains(i))
            {
                Assert.IsType<NullableTypeSymbol>(tuple.ElementTypes[i]);
            }
            else
            {
                Assert.IsNotType<NullableTypeSymbol>(tuple.ElementTypes[i]);
            }
        }

        return tuple;
    }

    private sealed class TestArtifacts : IDisposable
    {
        public TestArtifacts()
        {
            Directory = Path.Combine(
                AppContext.BaseDirectory,
                nameof(Issue3522ImportedNullableFieldEmitTests),
                Guid.NewGuid().ToString("N"));
            System.IO.Directory.CreateDirectory(Directory);
            var result = Compile(Directory, "Issue3522.Library", LibrarySource, target: "library");
            Assert.True(result.ExitCode == 0, result.Diagnostics);
            LibraryPath = result.OutputPath;
            IlVerifier.Verify(LibraryPath);

            MetadataPath = Path.Combine(Directory, "Issue3522.Metadata.dll");
            var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
                .Split(Path.PathSeparator)
                .Select(path => MetadataReference.CreateFromFile(path));
            var compilation = CSharpCompilation.Create(
                "Issue3522.Metadata",
                new[] { CSharpSyntaxTree.ParseText(MetadataSource, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    nullableContextOptions: NullableContextOptions.Enable));
            var metadataResult = compilation.Emit(MetadataPath);
            Assert.True(metadataResult.Success, string.Join(Environment.NewLine, metadataResult.Diagnostics));
        }

        public string Directory { get; }

        public string LibraryPath { get; }

        public string MetadataPath { get; }

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch
            {
            }
        }
    }
}
