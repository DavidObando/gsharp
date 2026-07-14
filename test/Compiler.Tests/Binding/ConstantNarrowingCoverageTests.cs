// <copyright file="ConstantNarrowingCoverageTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

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

    [Fact]
    public void ImportedBaseConstructorInitializer_InRangeIntegerLiteral_IsAccepted()
    {
        AssertCompiles("""
            package constant_narrowing_base_ok
            import GSharp.Compiler.Tests.Binding

            class Derived : ConstantNarrowingBase {
                init() : base(5) {}
            }
            """);
    }

    [Fact]
    public void ImportedBaseConstructorInitializer_OutOfRangeIntegerLiteral_IsRejected()
    {
        AssertRejected("""
            package constant_narrowing_base_bad
            import GSharp.Compiler.Tests.Binding

            class Derived : ConstantNarrowingBase {
                init() : base(300) {}
            }
            """);
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
        var sourceText = SourceText.From(source, "constant_narrowing_coverage.gs");
        var tree = SyntaxTree.Parse(sourceText);
        var compilation = new Compilation(ReferenceResolver.Default(), tree) { IsLibrary = true };

        using var peStream = new MemoryStream();
        return compilation.Emit(peStream, refStream: null);
    }
}

public class ConstantNarrowingMethodTarget
{
    public void Instance(byte value)
    {
    }
}

public interface IConstantNarrowingSink
{
    void Take(byte value);
}

public class ConstantNarrowingBase
{
    public ConstantNarrowingBase(byte value)
    {
    }
}

public readonly struct ConstantNarrowingOperatorTarget
{
    public static ConstantNarrowingOperatorTarget operator +(ConstantNarrowingOperatorTarget left, byte right) => left;
}
