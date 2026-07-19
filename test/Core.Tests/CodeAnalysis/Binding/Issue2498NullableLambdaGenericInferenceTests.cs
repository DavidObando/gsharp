// <copyright file="Issue2498NullableLambdaGenericInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2498: nullable-reference lambda results must survive generic method
/// inference and every symbolic projection built from the inferred argument.
/// </summary>
public sealed class Issue2498NullableLambdaGenericInferenceTests
{
    [Fact]
    public void Select_ToArrayAndToList_PreserveNullableElements()
    {
        AssertBinds("""
            import System.Collections.Generic
            import System.Linq

            func Build[T](source []IEnumerator[T]) {
                let array = source.Select((item IEnumerator[T]) ->
                    if item.MoveNext() { item } else { default(IEnumerator[T]?) }).ToArray()
                array[0] = nil

                let list = source.Select((item IEnumerator[T]) ->
                    if item.MoveNext() { item } else { default(IEnumerator[T]?) }).ToList()
                list[0] = nil
            }
            """);
    }

    [Fact]
    public void LambdaResultForms_MethodGroupsAndExplicitArguments_PreserveNullability()
    {
        AssertBinds("""
            import System.Collections.Generic
            import System.Linq

            class Holder2498Forms {
                prop Value string? { get; init; }
            }

            func Maybe2498(value string) string? ->
                if value.Length > 0 { value } else { nil }

            func Run2498Forms(source []string, holders []Holder2498Forms) {
                let conditional = source.Select((value string) ->
                    if value.Length > 0 { value } else { default(string?) }).ToArray()
                conditional[0] = nil

                let switched = source.Select((value string) ->
                    switch value { case "": default(string?) default: value }).ToArray()
                switched[0] = nil

                let directNil = source.Select((value string) -> {
                    if value.Length > 0 {
                        return value
                    }
                    return nil
                }).ToArray()
                directNil[0] = nil

                let coalesced = holders.Select((holder Holder2498Forms) ->
                    holder.Value ?? default(string?)).ToArray()
                coalesced[0] = nil

                let called = source.Select((value string) -> Maybe2498(value)).ToArray()
                called[0] = nil

                let member = holders.Select((holder Holder2498Forms) -> holder.Value).ToArray()
                member[0] = nil

                let methodGroup = source.Select(Maybe2498).ToArray()
                methodGroup[0] = nil

                let explicit = source.Select[string, string?](
                    (value string) -> Maybe2498(value)).ToArray()
                explicit[0] = nil
            }
            """);
    }

    [Fact]
    public void NestedGenericsArraysAndNullableReferenceKinds_PreserveAnnotations()
    {
        AssertBinds("""
            import System
            import System.Collections.Generic
            import System.Linq

            class Holder2498Shapes {
                prop Value string? { get; init; }
                prop Callback Func[int32]? { get; init; }
            }

            func MaybeText2498(value string) string? ->
                if value.Length > 0 { value } else { nil }

            func MaybeList2498(value string) List[string?] {
                let result = List[string?]()
                result.Add(MaybeText2498(value))
                return result
            }

            func MaybeArray2498(value string) []string? ->
                []string?{MaybeText2498(value)}

            func MaybeHolder2498(value Holder2498Shapes) Holder2498Shapes? ->
                if value.Value != nil { value } else { nil }

            func MaybeComparable2498(value string) IComparable? -> value

            func Run2498Shapes(source []string, holders []Holder2498Shapes) {
                let nested = source.Select((value string) -> MaybeList2498(value)).ToArray()
                nested[0][0] = nil

                let arrays = source.Select((value string) -> MaybeArray2498(value)).ToArray()
                arrays[0][0] = nil

                let tuples = source.Select(
                    (value string) -> (MaybeText2498(value), 1)).ToArray()
                var tupleValue = tuples[0].Item1
                tupleValue = nil

                let classes = holders.Select(
                    (holder Holder2498Shapes) -> MaybeHolder2498(holder)).ToArray()
                classes[0] = nil

                let interfaces = source.Select(
                    (value string) -> MaybeComparable2498(value)).ToArray()
                interfaces[0] = nil

                let delegates = holders.Select(
                    (holder Holder2498Shapes) -> holder.Callback).ToArray()
                delegates[0] = nil
            }
            """);
    }

    [Fact]
    public void MultipleLambdasImportedContinuationsAndSourceGenerics_PreserveNullability()
    {
        AssertBinds("""
            import System.Collections.Generic
            import System.Linq
            import System.Threading.Tasks

            class Holder2498Apis {
                prop Value string? { get; init; }
            }

            func Maybe2498Apis(value string) string? ->
                if value.Length > 0 { value } else { nil }

            func SourceProject2498[A, B](source []A, selector (A) -> B) []B ->
                source.Select(selector).ToArray()

            func SourceChoose2498[B](first () -> B, second () -> B) B -> second()

            func Run2498Apis(source []string, holders []Holder2498Apis) {
                let sourceGeneric = SourceProject2498(
                    source, (value string) -> Maybe2498Apis(value))
                sourceGeneric[0] = nil

                var sourceJoined = SourceChoose2498(
                    () -> "value",
                    () -> default(string?))
                sourceJoined = nil

                let flattened = holders.SelectMany(
                    (holder Holder2498Apis) -> []string?{holder.Value},
                    (holder Holder2498Apis, value string?) -> value).ToArray()
                flattened[0] = nil

                let groups = holders.GroupBy(
                    (holder Holder2498Apis) -> holder.Value).ToArray()
                let groupKey string? = groups[0].Key

                let joined = source.Join(
                    source,
                    (outer string) -> Maybe2498Apis(outer),
                    (inner string) -> inner,
                    (outer string, inner string) -> outer).ToArray()

                let continued = Task.FromResult("x").ContinueWith(
                    (task Task[string]) -> Maybe2498Apis(task.Result))
                var continuationResult = continued.Result
                continuationResult = nil
            }
            """);
    }

    [Fact]
    public void NullableReceiverAndNonNullableAndValueNullableControlsRemainStable()
    {
        AssertBinds("""
            import System.Collections.Generic
            import System.Linq

            func Count2498(values IEnumerable[string]?) int32 -> values!!.Count()

            func Controls2498(source []string) {
                let nullableValues = source.Select((value string) -> default(int32?)).ToArray()
                nullableValues[0] = nil

                let plain = source.Select((value string) -> value).ToArray()
                let text string = plain[0]
            }
            """);

        var diagnostics = Bind("""
            import System.Linq

            let plain = []string{"x"}.Select((value string) -> value).ToArray()
            plain[0] = nil
            """);

        Assert.Contains(diagnostics, d => d.Id == "GS0155");
    }

    private static void AssertBinds(string source)
    {
        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.IsError);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var paths = new List<string>();
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (!string.IsNullOrEmpty(tpa))
        {
            paths.AddRange(tpa.Split(Path.PathSeparator).Where(File.Exists));
        }

        using var resolver = ReferenceResolver.WithReferences(paths);
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree), resolver);
        var program = Binder.BindProgram(globalScope, resolver);
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }
}
