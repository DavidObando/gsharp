// <copyright file="Issue3093SequenceInterfaceBindingTests.cs" company="GSharp">
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

public sealed class Issue3093SequenceInterfaceBindingTests
{
    [Fact]
    public void GenericIteratorAndExplicitSequence_SatisfyIEnumerableContracts()
    {
        const string Source = """
            import System.Collections.Generic

            func One[T](value T) sequence[T] {
                yield value
            }

            interface IDetector {
                func Iterate[T](value T) IEnumerable[T];
                func Explicit[T](value T) IEnumerable[T];
            }

            class Detector : IDetector {
                func Iterate[T](value T) sequence[T] {
                    yield value
                }

                func Explicit[T](value T) sequence[T] {
                    return One(value)
                }
            }
            """;

        Assert.Empty(Evaluate(Source).Diagnostics);
    }

    [Fact]
    public void GenericTypeSequence_SatisfiesConstructedInterfaceContract()
    {
        const string Source = """
            import System.Collections.Generic

            interface IDetector[T] {
                func Detect(value T) IEnumerable[T];
            }

            class Detector[T] : IDetector[T] {
                func Detect(value T) sequence[T] {
                    yield value
                }
            }
            """;

        Assert.Empty(Evaluate(Source).Diagnostics);
    }

    [Fact]
    public void SequenceAndIEnumerable_AreIdentityCompatibleForOpenTypeParameter()
    {
        const string Source = """
            import System.Collections.Generic

            func Adapt[T](values sequence[T]) IEnumerable[T] {
                return values
            }
            """;

        Assert.Empty(Evaluate(Source).Diagnostics);
    }

    [Fact]
    public void AsyncSequence_SatisfiesIAsyncEnumerableContract()
    {
        const string Source = """
            import System.Collections.Generic
            import System.Threading.Tasks

            interface IDetector {
                func Detect[T](value T) IAsyncEnumerable[T];
            }

            class Detector : IDetector {
                async func Detect[T](value T) sequence[T] {
                    await Task.Yield()
                    yield value
                }
            }
            """;

        Assert.Empty(Evaluate(Source).Diagnostics);
    }

    [Theory]
    [InlineData("IEnumerable[T]", "async func")]
    [InlineData("IAsyncEnumerable[T]", "func")]
    public void SyncAndAsyncSequenceContracts_RemainDistinct(string contractType, string implementationModifier)
    {
        var source = $$"""
            import System.Collections.Generic

            interface IDetector {
                func Detect[T](value T) {{contractType}};
            }

            class Detector : IDetector {
                {{implementationModifier}} Detect[T](value T) sequence[T] {
                    yield value
                }
            }
            """;

        Assert.Contains(Evaluate(source).Diagnostics, diagnostic => diagnostic.Id == "GS0187");
    }

    [Fact]
    public void CovariantElementConversion_DoesNotChangeInterfaceSignatureIdentity()
    {
        const string Source = """
            import System.Collections.Generic

            interface IStrings {
                func Values() IEnumerable[object];
            }

            class Strings : IStrings {
                func Values() sequence[string] {
                    yield "value"
                }
            }
            """;

        Assert.Contains(Evaluate(Source).Diagnostics, diagnostic => diagnostic.Id == "GS0187");
    }

    private static EvaluationResult Evaluate(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Evaluate(new Dictionary<VariableSymbol, object>());
    }
}
