// <copyright file="Issue4396And4397And4423QualifiedNameBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issues #4396, #4397, and #4423: an explicit package qualification must
/// select that package's type even when imports make the terminal simple name
/// ambiguous. A genuinely unqualified name remains ambiguous.
/// </summary>
public class Issue4396And4397And4423QualifiedNameBindingTests
{
    [Fact]
    public void QualifiedParameterAttribute_BindsAcrossPackage()
    {
        var result = Evaluate(
            """
            package N1
            import System

            @Attribute
            class Tag {
            }
            """,
            """
            package N2

            class Tag {
            }
            """,
            """
            package App
            import N2

            class C {
                func M(@N1.Tag x int32) int32 { return x }
            }

            C().M(42)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
        AssertParameterAttribute(result, "N1.Tag");
    }

    [Fact]
    public void NestedQualifiedParameterAttribute_BindsAcrossPackage()
    {
        var result = Evaluate(
            """
            package Lib.N1
            import System

            @Attribute
            class Tag {
            }
            """,
            """
            package N2

            class Tag {
            }
            """,
            """
            package App
            import N2

            class C {
                func M(@Lib.N1.Tag x int32) int32 { return x }
            }

            C().M(42)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
        AssertParameterAttribute(result, "Lib.N1.Tag");
    }

    [Fact]
    public void QualifiedEnumTypeAndDefault_SelectQualifiedPackage()
    {
        var result = Evaluate(
            """
            package E1

            enum Mode {
                A,
                B
            }
            """,
            """
            package E2

            enum Mode {
                A,
                B
            }
            """,
            """
            package App
            import E1
            import E2

            func Pick(m E1.Mode = E1.Mode.B) string { return m.ToString() }
            Pick()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("B", result.Value);
    }

    [Fact]
    public void FullyQualifiedStaticAccess_SelectsQualifiedPackage()
    {
        var result = Evaluate(
            """
            package A.X

            class Thing {
                shared {
                    func Name() string { return "x" }
                }
            }
            """,
            """
            package A.Y

            class Thing {
                shared {
                    func Name() string { return "y" }
                }
            }
            """,
            """
            package App
            import A.X
            import A.Y

            A.Y.Thing.Name()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("y", result.Value);
    }

    [Fact]
    public void UnqualifiedCollidingType_RemainsAmbiguous()
    {
        var result = Evaluate(
            """
            package A.X

            class Thing {
            }
            """,
            """
            package A.Y

            class Thing {
            }
            """,
            """
            package App
            import A.X
            import A.Y

            let value Thing = Thing()
            """);

        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0496");
    }

    private static EmittedOracleResult Evaluate(params string[] sources)
        => EmittedOracle.Evaluate(sources);

    private static void AssertParameterAttribute(EmittedOracleResult result, string expectedTypeName)
    {
        var type = Assert.Single(result.Assembly.GetTypes(), candidate => candidate.Name == "C");
        var method = Assert.Single(type.GetMethods(), candidate => candidate.Name == "M");
        var parameter = Assert.Single(method.GetParameters());
        var attribute = Assert.Single(parameter.GetCustomAttributesData());
        Assert.Equal(expectedTypeName, attribute.AttributeType.FullName);
    }
}
