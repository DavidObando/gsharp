// <copyright file="Issue4289NullableVariantMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis;

/// <summary>
/// Issue #4289: a user method group whose nullable reference parameter is
/// broader than the target delegate parameter remains contravariant.
/// </summary>
public class Issue4289NullableVariantMethodGroupTests
{
    [Fact]
    public void NullableBaseParameter_IntoDerivedPredicate_BindsAndRuns()
    {
        const string source = """
            import System.Collections.Immutable
            import System.Linq

            open class Animal { }
            class Dog : Animal { }

            class Checker {
                shared {
                    func Check(a Animal?) bool -> a is Dog
                }
            }

            let values ImmutableArray[Dog] = ImmutableArray.Create(Dog())
            values.Any(Checker.Check)
            """;

        var result = EmittedOracle.Evaluate(source);

        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NullableDerivedTarget_DoesNotAcceptNonNullableBaseParameter()
    {
        const string source = """
            open class Animal { }
            class Dog : Animal { }

            class Checker {
                shared {
                    func Check(a Animal) bool -> true
                }
            }

            func Use(check (Dog?) -> bool) bool -> check(nil)

            Use(Checker.Check)
            """;

        var result = EmittedOracle.Evaluate(source);

        var diagnostic = Assert.Single(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal("GS0218", diagnostic.Id);
        Assert.Equal("Checker.Check", diagnostic.Location.Text.ToString(diagnostic.Location.Span));
    }
}
