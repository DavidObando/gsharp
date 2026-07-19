// <copyright file="Issue2502InheritedStaticMemberTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>Issue #2502 binding coverage for inherited source static members.</summary>
public class Issue2502InheritedStaticMemberTests
{
    [Fact]
    public void ClosedGenericMultiLevelBase_AllStaticMemberPathsBind()
    {
        const string Source = """
            open class Base2502[T] {
                class Nested2502 { shared { func Value() int32 -> 9 } }
                shared {
                    var Field T
                    prop Prop T { get -> Field; set { Field = value } }
                    event Changed () -> void
                    func Echo(value T) T -> value
                    func Pick(value T) string -> "generic"
                    func Pick(value int32) string -> "int"
                }
            }
            open class Mid2502[U] : Base2502[U] { }
            class Derived2502 : Mid2502[string] { }
            class Use2502 {
                func Run() {
                    Derived2502.Field = "a"
                    Derived2502.Field += "b"
                    Derived2502.Prop = Derived2502.Field
                    Derived2502.Prop += "c"
                    Derived2502.Changed += () -> { }
                    Derived2502.Changed -= () -> { }
                    let echo (string) -> string = Derived2502.Echo
                    let a string = Derived2502.Pick("x")
                    let b string = Derived2502.Pick(1)
                    let c int32 = Derived2502.Nested2502.Value()
                }
            }
            0
            """;

        Assert.Empty(Evaluate(Source).Diagnostics);
    }

    [Fact]
    public void SubstitutedSignature_DerivedMethodHidesBaseMethod()
    {
        const string Source = """
            open class Base2502Hide[T] {
                shared { func Pick(value T) string -> "base" }
            }
            class Derived2502Hide : Base2502Hide[string] {
                shared { func Pick(value string) string -> "derived" }
            }
            class Use2502Hide {
                func Run() {
                    let direct string = Derived2502Hide.Pick("x")
                    let group (string) -> string = Derived2502Hide.Pick
                    let indirect string = group("x")
                }
            }
            0
            """;

        Assert.Empty(Evaluate(Source).Diagnostics);
    }

    [Fact]
    public void ProtectedInheritedStatic_IsAccessibleOnlyFromDerivedContext()
    {
        const string Source = """
            open class Base2502Protected {
                shared { protected func Guarded() int32 -> 7 }
            }
            class Derived2502Protected : Base2502Protected {
                func Allowed() int32 -> Derived2502Protected.Guarded()
            }
            class Other2502Protected {
                func Rejected() int32 -> Derived2502Protected.Guarded()
            }
            0
            """;

        var diagnostics = Evaluate(Source).Diagnostics;
        Assert.Single(diagnostics, d => d.Id == "GS0379");
    }

    [Fact]
    public void PrivateAndInstanceMembers_AreNotInheritedStaticCandidates()
    {
        const string Source = """
            open class Base2502Negative {
                func InstanceOnly() int32 -> 1
                shared { private func Secret() int32 -> 2 }
            }
            class Derived2502Negative : Base2502Negative { }
            class Use2502Negative {
                func A() int32 -> Derived2502Negative.Secret()
                func B() int32 -> Derived2502Negative.InstanceOnly()
            }
            0
            """;

        var diagnostics = Evaluate(Source).Diagnostics;
        Assert.Contains(diagnostics, d => d.Id is "GS0158" or "GS0472");
        Assert.True(diagnostics.Length >= 2);
    }

    [Fact]
    public void ClosedGenericBase_RejectsWrongSubstitutedArgument()
    {
        const string Source = """
            open class Base2502Wrong[T] {
                shared { func Echo(value T) T -> value }
            }
            class Derived2502Wrong : Base2502Wrong[string] { }
            class Use2502Wrong {
                func Run() string -> Derived2502Wrong.Echo(1)
            }
            0
            """;

        Assert.NotEmpty(Evaluate(Source).Diagnostics);
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
