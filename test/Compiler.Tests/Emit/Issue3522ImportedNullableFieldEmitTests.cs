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
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue3522ImportedNullableFieldEmitTests
{
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
        string reference = null)
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
        if (reference != null)
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

    private static byte[] GetNullableFlags(MemberInfo member)
    {
        var attribute = member.GetCustomAttributesData().SingleOrDefault(
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
    {
        var attribute = member.GetCustomAttributesData().Single(
            data => data.AttributeType.FullName == "System.Runtime.CompilerServices.NullableContextAttribute");
        return (byte)attribute.ConstructorArguments.Single().Value!;
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
        }

        public string Directory { get; }

        public string LibraryPath { get; }

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
