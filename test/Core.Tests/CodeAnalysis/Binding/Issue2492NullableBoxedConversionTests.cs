// <copyright file="Issue2492NullableBoxedConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2492: explicit object/interface unboxing remains available when the
/// source and target carry nullable annotations. The conversion is explicit
/// only and is restricted to interface/value-type pairs that can actually box
/// and unbox through that interface.
/// </summary>
public sealed class Issue2492NullableBoxedConversionTests
{
    [Fact]
    public void ExplicitNullableBoxedSources_ToNullableValueTypes_Compile()
    {
        const string source = """
            package issue2492bindingpositive
            import System

            interface IBox2492 {}
            struct Local2492(Value int32) : IBox2492 {}
            enum Color2492 { Red, Green }

            func Primitive(value object?) uint32? -> uint32?(value)
            func Imported(value object?) Guid? -> Guid?(value)
            func ValueTypeSource(value ValueType?) Guid? -> Guid?(value)
            func EnumBaseSource(value Enum?) DayOfWeek? -> DayOfWeek?(value)
            func Local(value object?) Local2492? -> Local2492?(value)
            func EnumValue(value object?) Color2492? -> Color2492?(value)
            func Generic[T struct](value object?) T? -> T?(value)
            func ImportedInterface(value IComparable?) int32? -> int32?(value)
            func UserInterface(value IBox2492?) Local2492? -> Local2492?(value)
            func NonNullableImportedInterface(value IComparable) int32? -> int32?(value)
            func NonNullableUserInterface(value IBox2492) Local2492? -> Local2492?(value)
            func NonNullableObjectControl(value object) uint32? -> uint32?(value)
            func NonNullableTargetControl(value object?) uint32 -> uint32(value)
            func AsControl(value object?) uint32? -> value as uint32?
            """;

        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ExplicitCast_AfterInterfacePatternNarrowing_Compiles()
    {
        const string source = """
            package issue2492bindingpattern
            import System

            func Convert(value object?) int32? {
                if value is IComparable {
                    return int32?(value)
                }

                return nil
            }
            """;

        Assert.Empty(Evaluate(source).Diagnostics);
    }

    [Fact]
    public void ImplicitNullableObjectToNullableValue_RemainsRejectedAsExplicitOnly()
    {
        const string source = """
            package issue2492bindingimplicit

            func Sink(value int32?) void {}
            func Return(value object?) int32? -> value
            func Assign(value object?) void {
                let converted int32? = value
                Sink(value)
            }
            """;

        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Equal(2, diagnostics.Count(d => d.Id == "GS0156"));
        Assert.Single(diagnostics, d => d.Id == "GS0154");
    }

    [Fact]
    public void InvalidReferenceAndInterfaceSources_ReportNoConversion()
    {
        const string source = """
            package issue2492bindinginvalid
            import System

            func FromString(value string?) int32? -> int32?(value)
            func FromUnrelatedInterface(value IDisposable?) int32? -> int32?(value)
            func FromEnumBase(value Enum?) int32? -> int32?(value)
            """;

        var diagnostics = Evaluate(source).Diagnostics;
        Assert.Equal(3, diagnostics.Count(d => d.Id == "GS0155"));
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree) { IsLibrary = true };
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
