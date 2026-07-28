// <copyright file="Issue2818StructTemporaryFieldAssignmentTests.cs" company="GSharp">
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

/// <summary>
/// Issue #2818: field writes through non-addressable struct values must fail
/// in binding instead of mutating a discarded emitter spill temporary.
/// </summary>
public class Issue2818StructTemporaryFieldAssignmentTests
{
    [Fact]
    public void FunctionResultFieldAssignment_ReportsGS0499()
    {
        var result = Evaluate("""
            package P

            struct Item {
                var Id int32
            }

            func MakeItem() Item {
                return Item{Id: 1}
            }

            MakeItem().Id = 7
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void NarrowedOptionalStructFieldAssignment_ReportsGS0499()
    {
        var result = Evaluate("""
            package P

            struct Item {
                var Id int32
            }

            var item Item? = Item{Id: 1}
            if item != nil {
                item.Id = 7
            }
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Theory]
    [InlineData("=")]
    [InlineData("+=")]
    public void LetStructLocal_NestedFieldAssignment_ReportsGS0499(string assignmentOperator)
    {
        var result = Evaluate($$$"""
            package P2818ReadonlyLocal

            struct Item {
                var Id int32
            }

            struct Outer {
                var Inner Item
            }

            let outer = Outer{Inner: Item{Id: 1}}
            outer.Inner.Id {{{assignmentOperator}}} 5
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Theory]
    [InlineData("=")]
    [InlineData("+=")]
    public void ClassHeldReadonlyStructFieldAssignment_ReportsGS0499(string assignmentOperator)
    {
        var result = Evaluate($$"""
            package P2818ReadonlyInstance

            struct Item {
                var Id int32
            }

            class Holder {
                let Value Item = Item{Id: 1}
            }

            var holder = Holder()
            holder.Value.Id {{assignmentOperator}} 5
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void InstanceReadonlyStructFieldAssignments_InDeclaringConstructor_DoNotReportGS0499()
    {
        var result = Evaluate("""
            package P2818ReadonlyInstanceConstructor

            struct Item {
                var Id int32
            }

            class Holder {
                let Value Item = Item{Id: 1}

                init() {
                    Value.Id = 5
                    Value.Id += 2
                }
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void StaticReadonlyStructFieldAssignment_ReportsGS0499()
    {
        var result = Evaluate("""
            package P2818StaticSimple

            struct Item {
                var Id int32
            }

            class Holder {
                shared {
                    let Origin Item = Item{Id: 1}
                }
            }

            Holder.Origin.Id = 5
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void StaticReadonlyStructFieldCompoundAssignment_ReportsGS0499()
    {
        var result = Evaluate("""
            package P2818StaticCompound

            struct Item {
                var Id int32
            }

            class Holder {
                shared {
                    let Origin Item = Item{Id: 1}
                }
            }

            Holder.Origin.Id += 5
            """);

        Assert.Contains(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void MutableStaticStructFieldAssignments_DoNotReportGS0499()
    {
        var result = Evaluate("""
            package P2818StaticMutable

            struct Item {
                var Id int32
            }

            class Holder {
                shared {
                    var Origin Item = Item{Id: 1}
                }
            }

            Holder.Origin.Id = 5
            Holder.Origin.Id += 2
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0499");
    }

    [Fact]
    public void StaticReadonlyStructFieldAssignments_InDeclaringCctor_DoNotReportGS0499()
    {
        var result = Evaluate("""
            package P2818StaticCctor

            struct Item {
                var Id int32
            }

            class Holder {
                shared {
                    let Origin Item = Item{Id: 1}
                    let InitializerResult int32 = (Holder.Origin.Id = 3)
                    init {
                        Holder.Origin.Id = 5
                        Holder.Origin.Id += 2
                    }
                }
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0499");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
