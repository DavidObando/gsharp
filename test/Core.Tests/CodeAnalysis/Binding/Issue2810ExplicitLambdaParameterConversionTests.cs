// <copyright file="Issue2810ExplicitLambdaParameterConversionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

public sealed class Issue2810ExplicitLambdaParameterConversionTests
{
    private const string Declarations = """
        interface Value {
            func Get() int32;
        }

        class Int(val int32) : Value {
            func Get() int32 {
                return val
            }

            func operator implicit(value Int) int32 {
                return value.Get()
            }
        }

        class Wrapped(val int32) {
            func Get() int32 {
                return val
            }

            func operator implicit(value int32) Wrapped {
                return Wrapped(value)
            }
        }
        """;

    [Fact]
    public void TargetValue_ExplicitIntParameter_IsRejected()
    {
        var diagnostics = Bind($$"""
            import System.Collections.Generic
            import System.Linq

            {{Declarations}}

            func Test(nums List[Value]) {
                nums.Where((x int32) -> x % 2 == 0)
            }
            """);

        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0155");
    }

    [Fact]
    public void TargetIntClass_ExplicitIntParameter_UsesImplicitConversion()
    {
        var diagnostics = Bind($$"""
            import System.Collections.Generic
            import System.Linq

            {{Declarations}}

            func Test(nums List[Int]) {
                nums.Where((x int32) -> x % 2 == 0)
            }
            """);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void TargetInt_ExplicitClassParameter_UsesImplicitConversion()
    {
        var diagnostics = Bind($$"""
            import System.Collections.Generic
            import System.Linq

            {{Declarations}}

            func Test(nums List[int32]) {
                nums.ForEach((x Wrapped) -> x.Get())
            }
            """);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void TargetValue_UntypedParameter_RemainsTargetTyped()
    {
        var diagnostics = Bind($$"""
            import System.Collections.Generic
            import System.Linq

            {{Declarations}}

            func Test(nums List[Value]) {
                nums.Where(x -> x.Get() % 2 == 0)
            }
            """);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    [Fact]
    public void TargetObject_ExplicitUserParameter_RequiresCheckedCast()
    {
        var diagnostics = Bind($$"""
            import System.Collections.Generic

            {{Declarations}}

            func Test(values List[object]) {
                values.ForEach((x Wrapped) -> x.Get())
            }
            """);

        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0156");
    }

    [Fact]
    public void NullableTarget_ExplicitNonNullableParameter_RemainsRuntimeCompatible()
    {
        var diagnostics = Bind("""
            import System.Collections.Generic

            func Test(values List[string?]) {
                values.ForEach((x string) -> x.Length)
            }
            """);

        Assert.DoesNotContain(diagnostics, diagnostic => diagnostic.IsError);
    }

    private static System.Collections.Immutable.ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        using var references = ReferenceResolver.WithReferences(
            Directory.EnumerateFiles(
                RuntimeEnvironment.GetRuntimeDirectory(),
                "*.dll",
                SearchOption.TopDirectoryOnly));
        var compilation = new Compilation(
            references,
            SyntaxTree.Parse(SourceText.From(source)));
        return compilation.SyntaxTrees.SelectMany(tree => tree.Diagnostics)
            .Concat(compilation.GlobalScope.Diagnostics)
            .Concat(compilation.BoundProgram.Diagnostics)
            .ToImmutableArray();
    }
}
