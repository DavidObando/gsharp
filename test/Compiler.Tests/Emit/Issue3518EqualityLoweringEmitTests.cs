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
}
