// <copyright file="Issue3518EqualityLoweringEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3518: equality operands must match emitted operator stack types.
/// </summary>
public class Issue3518EqualityLoweringEmitTests
{
    [Fact]
    public void MixedInt32AndFloat64Equality_RunsAndVerifies()
    {
        const string source = """
            package FindingMixedNumericEquality

            class Holder {
                var Value float64
            }

            func Main() int32 {
                let integer int32 = 7
                let decimal float64 = 7.0
                let first = integer == decimal
                let holder = Holder{ Value: 7.0 }
                let second = holder.Value == 7
                let nullableInteger int32? = integer
                let nullableDecimal float64? = decimal
                let third = nullableInteger == nullableDecimal
                return first && second && third ? 0 : 1
            }
            """;

        Assert.Empty(Issue2866ImportedDataEqualityEmitTests.CompileAndRun(source));
    }

    [Fact]
    public void ImportedNullableDataStructEquality_RunsAndVerifies()
    {
        const string library = """
            package FindingNullableDataStructEquality

            public data struct Identifier(Value string) { }
            """;

        const string source = """
            package FindingNullableDataStructEqualityApp

            import FindingNullableDataStructEquality

            class Holder {
                private var current Identifier?

                public func Equal(next Identifier?) bool {
                    return this.current == next
                }

                public func Set(next Identifier?) {
                    this.current = next
                }
            }

            func Main() int32 {
                let holder = Holder()
                let bothNil = holder.Equal(nil)
                holder.Set(Identifier("same"))
                let bothEqual = holder.Equal(Identifier("same"))
                let different = holder.Equal(Identifier("different"))
                return bothNil && bothEqual && !different ? 0 : 1
            }
            """;

        Assert.Empty(Issue2866ImportedDataEqualityEmitTests.CompileAndRun(
            source,
            library,
            "FindingNullableDataStructEquality"));
    }

    [Fact]
    public void UnsignedHighBitMixedEquality_RunsAndVerifies()
    {
        const string source = """
            package FindingUnsignedMixedEquality

            func Main() int32 {
                let u32 = uint32(1) << 31
                let u64 = uint64(1) << 63
                let un = nuint(1) << 63
                let f32 = float32(2147483648.0)
                let f64 = 9223372036854775808.0

                let n32 uint32? = u32
                let n64 uint64? = u64
                let nn nuint? = un
                let nf32 float32? = f32
                let nf64 float64? = f64

                let direct = u32 == f32 && u64 == f64 && un == f64
                let lifted = n32 == nf32 && n64 == nf64 && nn == nf64
                return direct && lifted ? 0 : 1
            }
            """;

        Assert.Empty(Issue2866ImportedDataEqualityEmitTests.CompileAndRun(source));
    }

    [Fact]
    public void ImportedNullableImplicitConversionEquality_RunsAndVerifies()
    {
        const string library = """
            package FindingNullableConversionEquality

            public struct Source(Raw int32) { }
            public struct Target(Value int32) { }

            func operator implicit(value Source) Target -> Target(value.Raw)
            func (left Target) operator ==(right Target) bool -> left.Value == right.Value
            """;

        const string source = """
            package FindingNullableConversionEqualityApp

            import FindingNullableConversionEquality

            func Equal(left Source?, right Target?) bool -> left == right

            func Main() int32 {
                let source Source? = Source(7)
                let equal Target? = Target(7)
                let different Target? = Target(8)
                let missingSource Source? = nil
                let missingTarget Target? = nil

                let present = Equal(source, equal)
                let valueMismatch = !Equal(source, different)
                let presenceMismatch = !Equal(missingSource, equal)
                let absent = Equal(missingSource, missingTarget)
                return present && valueMismatch && presenceMismatch && absent ? 0 : 1
            }
            """;

        Assert.Empty(Issue2866ImportedDataEqualityEmitTests.CompileAndRun(
            source,
            library,
            "FindingNullableConversionEquality"));
    }

    [Fact]
    public void NullableBoxingOperator_UsesNonLiftedCallAndVerifies()
    {
        const string source = """
            package FindingNullableBoxingOperator

            struct Token(Value int32) { }

            func (left Token) operator ==(right object) bool {
                return left.Value == 7 && right != nil
            }

            func Main() int32 {
                let value int32? = 7
                return Token(7) == value ? 0 : 1
            }
            """;

        Assert.Empty(Issue2866ImportedDataEqualityEmitTests.CompileAndRun(source));
    }

    [Fact]
    public void NonLiftableOperatorSignatures_FailWithoutInternalCompilerError()
    {
        var sources = new[]
        {
            """
            package FindingNonLiftableReferenceParameter

            struct Value(N int32) { }
            func (left Value) operator +(right object) Value -> left

            func Bad(left Value?, right object) Value? -> left + right
            """,
            """
            package FindingNonLiftableReferenceResult

            struct Value(N int32) { }
            func (left Value) operator +(right Value) object -> left

            func Bad(left Value?, right Value?) object? -> left + right
            """,
        };

        foreach (var source in sources)
        {
            var (exitCode, stdout, stderr) =
                Issue2388NullableCustomEqualityEmitTests.TryCompile(source);
            var diagnostics = stdout + stderr;
            Assert.NotEqual(0, exitCode);
            Assert.Contains("GS0155", diagnostics);
            Assert.DoesNotContain("GS9998", diagnostics);
        }
    }

    [Fact]
    public void MethodGenericOperator_ReportsSourceDiagnostic()
    {
        const string source = """
            package FindingMethodGenericOperator

            struct Value(N int32) { }
            func (left Value) op_Addition[T struct](right Value) Value -> left

            func Bad(left Value?, right Value?) Value? -> left + right
            """;

        var (exitCode, stdout, stderr) =
            Issue2388NullableCustomEqualityEmitTests.TryCompile(source);
        var diagnostics = stdout + stderr;
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0537", diagnostics);
        Assert.DoesNotContain("GS9998", diagnostics);
    }

    [Fact]
    public void ByRefOperatorSignature_IsNotCallableThroughBinarySyntax()
    {
        const string source = """
            package FindingByRefOperator

            struct Value(N int32) { }
            func (left Value) op_Addition(ref right Value) Value -> left

            func Bad(left Value, right Value) Value -> left + right
            """;

        var (exitCode, stdout, stderr) =
            Issue2388NullableCustomEqualityEmitTests.TryCompile(source);
        var diagnostics = stdout + stderr;
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0129", diagnostics);
        Assert.DoesNotContain("GS9998", diagnostics);
    }

    [Fact]
    public void LiftedOperatorReturningRefStruct_FailsWithoutInvalidMetadata()
    {
        const string source = """
            package FindingRefStructLift

            ref struct StackResult {
                var Value int32
            }

            struct Number(Value int32) { }
            func (left Number) operator +(right Number) StackResult {
                return StackResult{Value: left.Value + right.Value}
            }

            func Bad(left Number?, right Number?) {
                let result = left + right
            }
            """;

        var (exitCode, stdout, stderr) =
            Issue2388NullableCustomEqualityEmitTests.TryCompile(source);
        var diagnostics = stdout + stderr;
        Assert.NotEqual(0, exitCode);
        Assert.Contains("GS0155", diagnostics);
        Assert.DoesNotContain("GS9998", diagnostics);
    }

    [Fact]
    public void SameCompilationNullableImplicitConversionEquality_RunsAndVerifies()
    {
        const string source = """
            package FindingSameCompilationNullableConversion

            struct Source(Raw int32) { }
            struct Target(Code string) { }

            func operator implicit(value Source) Target -> Target(value.Raw.ToString())
            func (left Target) operator ==(right Target) bool -> left.Code == right.Code

            func Equal(left Source?, right Target?) bool -> left == right

            func Main() int32 {
                let source Source? = Source(7)
                let equal Target? = Target("7")
                let different Target? = Target("8")
                let missingSource Source? = nil
                let missingTarget Target? = nil

                let present = Equal(source, equal)
                let valueMismatch = !Equal(source, different)
                let presenceMismatch = !Equal(missingSource, equal)
                let absent = Equal(missingSource, missingTarget)
                return present && valueMismatch && presenceMismatch && absent ? 0 : 1
            }
            """;

        Assert.Empty(Issue2866ImportedDataEqualityEmitTests.CompileAndRun(source));
    }
}
