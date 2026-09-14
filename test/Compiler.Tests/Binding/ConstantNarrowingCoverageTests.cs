// <copyright file="ConstantNarrowingCoverageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Compilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using SyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Compiler.Tests.Binding;

public class ConstantNarrowingCoverageTests
{
    [Fact]
    public void ImportedInstanceCall_InRangeIntegerLiteral_IsAccepted()
    {
        AssertCompiles("""
            package constant_narrowing_instance_ok
            import GSharp.Compiler.Tests.Binding

            func Main() {
                var target = ConstantNarrowingMethodTarget()
                target.Instance(5)
            }
            """);
    }

    [Fact]
    public void ImportedInstanceCall_OutOfRangeIntegerLiteral_IsRejected()
    {
        AssertGs0159("""
            package constant_narrowing_instance_bad
            import GSharp.Compiler.Tests.Binding

            func Main() {
                var target = ConstantNarrowingMethodTarget()
                target.Instance(300)
            }
            """);
    }

    [Fact]
    public void ConstrainedImportedInterfaceCall_InRangeIntegerLiteral_IsAccepted()
    {
        AssertCompiles("""
            package constant_narrowing_constraint_ok
            import GSharp.Compiler.Tests.Binding

            func Call[T IConstantNarrowingSink](sink T) {
                sink.Take(5)
            }
            """);
    }

    [Fact]
    public void ConstrainedImportedInterfaceCall_OutOfRangeIntegerLiteral_IsRejected()
    {
        AssertGs0159("""
            package constant_narrowing_constraint_bad
            import GSharp.Compiler.Tests.Binding

            func Call[T IConstantNarrowingSink](sink T) {
                sink.Take(300)
            }
            """);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(5)]
    [InlineData(255)]
    public void ImportedBaseConstructorInitializer_InRangeIntegerLiteral_IsAccepted(int value)
    {
        AssertCompiles($$"""
            package constant_narrowing_base_ok
            import GSharp.Compiler.Tests.Binding

            class Derived : ConstantNarrowingBase {
                init() : base({{value}}) {}
            }
            """);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(256)]
    [InlineData(300)]
    public void ImportedBaseConstructorInitializer_OutOfRangeIntegerLiteral_IsRejected(int value)
    {
        var result = Compile($$"""
            package constant_narrowing_base_bad
            import GSharp.Compiler.Tests.Binding

            class Derived : ConstantNarrowingBase {
                init() : base({{value}}) {}
            }
            """);
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0267");
        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0157" || d.Id == "GS0213");
    }

    [Fact]
    public void ImportedOperator_InRangeIntegerLiteral_StillRejectedUntilOperatorBinderPassesOperands()
    {
        AssertRejected("""
            package constant_narrowing_operator_gap
            import GSharp.Compiler.Tests.Binding

            func Main() {
                var value = ConstantNarrowingOperatorTarget()
                var _ = value + 5
            }
            """);
    }

    private static void AssertCompiles(string source)
    {
        var result = Compile(source);
        Assert.True(
            result.Success,
            "Expected successful compilation; got: " + string.Join("; ", result.Diagnostics.Select(d => $"[{d.Id}] {d.Message}")));
    }

    private static void AssertGs0159(string source)
    {
        var result = Compile(source);
        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    private static void AssertRejected(string source)
    {
        var result = Compile(source);
        Assert.False(result.Success);
        Assert.NotEmpty(result.Diagnostics);
    }

    private static EmitResult Compile(string source)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "constant-narrowing", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            // #4129/#4206: these are imported C# contracts, not G# fixtures.
            // Migrating the ambient test assembly sealed the otherwise unsealed base.
            var referencePath = Path.Combine(directory, "ConstantNarrowingContracts.dll");
            var contracts = CSharpCompilation.Create(
                "ConstantNarrowingContracts",
                new[] { CSharpSyntaxTree.ParseText(ContractsSource) },
                new[] { MetadataReference.CreateFromFile(typeof(object).Assembly.Location) },
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using (var referenceStream = File.Create(referencePath))
            {
                var emitted = contracts.Emit(referenceStream);
                Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics));
            }

            using var references = ReferenceResolver.WithReferences(new[] { referencePath });
            Assert.True(references.TryResolveType("GSharp.Compiler.Tests.Binding.ConstantNarrowingBase", out var baseType));
            Assert.False(baseType.IsSealed);
            Assert.Equal("System.Byte", Assert.Single(Assert.Single(baseType.GetConstructors()).GetParameters()).ParameterType.FullName);

            var sourceText = SourceText.From(source, "constant_narrowing_coverage.gs");
            var tree = SyntaxTree.Parse(sourceText);
            var compilation = new Compilation(references, tree) { IsLibrary = true };

            using var peStream = new MemoryStream();
            return compilation.Emit(peStream, refStream: null);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private const string ContractsSource = """
        namespace GSharp.Compiler.Tests.Binding;

        public class ConstantNarrowingMethodTarget
        {
            public void Instance(byte value) {}
        }

        public interface IConstantNarrowingSink
        {
            void Take(byte value);
        }

        public class ConstantNarrowingBase
        {
            public ConstantNarrowingBase(byte value) {}
        }

        public readonly struct ConstantNarrowingOperatorTarget
        {
            public static ConstantNarrowingOperatorTarget operator +(ConstantNarrowingOperatorTarget left, byte right) => left;
        }
        """;
}
