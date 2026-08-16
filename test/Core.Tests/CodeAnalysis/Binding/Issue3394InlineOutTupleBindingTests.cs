// <copyright file="Issue3394InlineOutTupleBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Binding.OverloadResolution;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #3394: inline out-var inference from a constructed generic receiver
/// preserves tuple element nullability.
/// </summary>
public class Issue3394InlineOutTupleBindingTests
{
    [Fact]
    public void SymbolicMethodInference_MapsImportedEnumerableInterface()
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From("package P\nclass Item {}")));
        var item = compilation.GlobalScope.Structs.Single(type => type.Name == "Item");
        var receiver = ImportedTypeSymbol.GetConstructed(
            typeof(ImmutableArray<object>),
            typeof(ImmutableArray<>),
            ImmutableArray.Create<TypeSymbol>(item));
        var any = typeof(Enumerable).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(method => method.Name == nameof(Enumerable.Any)
                && method.IsGenericMethodDefinition
                && method.GetParameters().Length == 2
                && method.GetParameters()[1].ParameterType.IsGenericType);

        var closed = any.MakeGenericMethod(typeof(object));
        var inferred = MemberLookup.BuildSymbolicMethodTypeArgs(
            closed,
            default,
            ImmutableArray.Create<TypeSymbol>(receiver, TypeSymbol.Error));

        Assert.Same(item, Assert.Single(inferred));
        var parameterType = Assert.IsType<ImportedTypeSymbol>(
            ConversionClassifier.TrySubstituteParameterTypeFromMethodTypeArgs(closed, 1, inferred));
        Assert.Same(item, parameterType.TypeArguments[0]);
        Assert.True(MemberLookup.TryGetDelegateFunctionTypeFromSymbol(parameterType, out var functionType));
        Assert.Same(item, Assert.Single(functionType.ParameterTypes));
    }

    [Fact]
    public void PartialSymbolicMethodInference_UsesClosedTypeForUnresolvedSlot()
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From("package P\nclass Item {}")));
        var item = compilation.GlobalScope.Structs.Single(type => type.Name == "Item");
        var select = typeof(Enumerable).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(method => method.Name == nameof(Enumerable.Select)
                && method.IsGenericMethodDefinition
                && method.GetParameters().Length == 2
                && method.GetParameters()[1].ParameterType.GetGenericArguments().Length == 2)
            .MakeGenericMethod(typeof(object), typeof(System.Collections.Generic.Dictionary<string, string>));

        var parameterType = Assert.IsType<ImportedTypeSymbol>(
            ConversionClassifier.TrySubstituteParameterTypeFromMethodTypeArgs(
                select,
                1,
                ImmutableArray.Create<TypeSymbol>(item, TypeSymbol.Error)));

        Assert.True(MemberLookup.TryGetDelegateFunctionTypeFromSymbol(parameterType, out var functionType));
        Assert.Same(item, Assert.Single(functionType.ParameterTypes));
        Assert.Equal(
            typeof(System.Collections.Generic.Dictionary<string, string>),
            functionType.ReturnType.ClrType);
    }

    [Fact]
    public void SymbolicMethodInference_MapsDictionaryEntry()
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From("package P\nclass Item {}")));
        var item = compilation.GlobalScope.Structs.Single(type => type.Name == "Item");
        var receiver = ImportedTypeSymbol.GetConstructed(
            typeof(System.Collections.Generic.Dictionary<object, int>),
            typeof(System.Collections.Generic.Dictionary<,>),
            ImmutableArray.Create<TypeSymbol>(item, TypeSymbol.Int32));
        var entry = ImportedTypeSymbol.GetConstructed(
            typeof(System.Collections.Generic.KeyValuePair<object, int>),
            typeof(System.Collections.Generic.KeyValuePair<,>),
            ImmutableArray.Create<TypeSymbol>(item, TypeSymbol.Int32));
        var selector = FunctionTypeSymbol.Get(
            ImmutableArray.Create<TypeSymbol>(entry),
            TypeSymbol.Int32);
        var orderBy = typeof(Enumerable).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(method => method.Name == nameof(Enumerable.OrderBy)
                && method.IsGenericMethodDefinition
                && method.GetParameters().Length == 2
                && method.GetGenericArguments().Length == 2);

        var inferred = MemberLookup.BuildSymbolicMethodTypeArgs(
            orderBy.MakeGenericMethod(typeof(object), typeof(int)),
            default,
            ImmutableArray.Create<TypeSymbol>(receiver, selector));

        var inferredEntry = Assert.IsType<ImportedTypeSymbol>(inferred[0]);
        Assert.Same(item, inferredEntry.TypeArguments[0]);
        Assert.Same(TypeSymbol.Int32, inferred[1]);
    }

    [Fact]
    public void ClrOverloadResolution_SelectManyAcceptsStructEnumerableLambdaReturn()
    {
        Assert.NotEqual(
            ClrOverloadResolution.ImplicitConversionKind.None,
            ClrOverloadResolution.ClassifyImplicit(
                typeof(System.Collections.Generic.IEnumerable<object>),
                typeof(ImmutableArray<object>)));
        var candidate = typeof(Enumerable).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(method => method.Name == nameof(Enumerable.SelectMany)
                && method.IsGenericMethodDefinition
                && method.GetGenericArguments().Length == 2
                && method.GetParameters().Length == 2
                && method.GetParameters()[1].ParameterType.GetGenericArguments().Length == 2)
            .MakeGenericMethod(typeof(object), typeof(object));
        var result = ClrOverloadResolution.Resolve(
            new[] { candidate },
            new System.Type[]
            {
                typeof(ImmutableArray<object>),
                typeof(System.Func<object, ImmutableArray<object>>),
            },
            functionLiteralArgumentCheck: index => index == 1);

        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
    }

    [Fact]
    public void ConditionalExpression_UsesImportedImplicitConversion()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Reflection.Metadata

            let flag = true
            let handle = if flag {
                default(EntityHandle)
            } else {
                default(MethodDefinitionHandle)
            }
            handle.IsNil
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void InlineOutVarsInShortCircuitCondition_AreVisibleInThenBody()
    {
        var result = EmittedOracle.Evaluate("""
            func tryRead(out left int32, out right int32) bool {
                left = 20
                right = 22
                return true
            }

            func read() int32 {
                if false {
                    return -1
                } else if true && tryRead(out var left, out var right) {
                    return left + right
                }
                return 0
            }

            read()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void BodyLocal_CanShadowReadOnlyParameter()
    {
        var result = EmittedOracle.Evaluate("""
            func change(value int32) int32 {
                var value = value
                value = 42
                return value
            }

            change(1)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void UserOverloadRanking_PrefersIdentityOverImplicitOperator()
    {
        var result = EmittedOracle.Evaluate("""
            open class Base {}
            class Derived : Base {}
            class Path {
                func operator implicit(value Base) Path -> Path()
            }

            func pick(value Base) int32 -> 1
            func pick(value Path) int32 -> 2

            pick(Derived())
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void UserGenericInference_RecursesIntoImportedTupleArguments()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            enum Kind { None, Some }

            func inner[T](values List[(T, Kind)]) T -> values[0].Item1
            func outer[T](values List[(T, Kind)]) T -> inner(values)

            let values = List[(int32, Kind)]()
            values.Add((42, Kind.Some))
            outer(values)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void NullCoalescingAssignment_AllowsClrDefaultNullReferenceSlot()
    {
        var result = EmittedOracle.Evaluate("""
            var values = [1]string
            values[0] ??= "filled"
            values[0]
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal("filled", result.Value);
    }

    [Fact]
    public void LinqOrderBy_PreservesSymbolicDictionaryEntryType()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic
            import System.Linq

            class Item {}

            func count(values Dictionary[Item, int32]) int32 {
                return values.OrderBy((pair KeyValuePair[Item, int32]) -> pair.Value).Count()
            }

            0
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void QualifiedPrivateNestedTypeConstruction_BindsInsideContainingType()
    {
        var result = EmittedOracle.Evaluate("""
            class Rewriter {}

            class Outer {
                private open class Rewriter {}

                shared {
                    func make() object -> Outer.Rewriter()
                }
            }

            Outer.make()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.NotNull(result.Value);
    }

    [Fact]
    public void ImportedOverloadRanking_UsesBetterUserDefinedConversionTarget()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Reflection.Metadata
            import System.Reflection.Metadata.Ecma335

            let handle = default(MethodDefinitionHandle)
            MetadataTokens.GetToken(handle)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0x06000000, result.Value);
    }

    [Fact]
    public void NullAssertedImportedGenericReceivers_PreserveInstanceMethods()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic
            import System.Collections.Immutable

            class Item {}

            func check(name string) bool {
                let seen = HashSet[string]()
                seen!!.Add(name)

                let items = ImmutableArray.CreateBuilder[Item]()
                items!!.Add(Item())
                return seen.Count == 1 && items.Count == 1
            }

            check("x")
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NullAssertedListOfSourceType_PreservesAdd()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic

            class Item {}

            let items = List[Item]()
            items!!.Add(Item())
            items.Count
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(1, result.Value);
    }

    [Fact]
    public void LinqWhere_PreservesNestedSymbolicTupleReceiver()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Collections.Generic
            import System.Linq
            import System.Reflection

            class Resolver {
                enum Kind { None, Identity }

                shared {
                    func isGeneric(method MethodBase) bool -> false

                    func choose[T MethodBase](applicable List[(T, []Kind, []Type, []?int32, bool)]) int32 {
                        let nonDominated = List[(T, []Kind, []Type, []?int32, bool)]()
                        let direct = applicable.Where((w (T, []Kind, []Type, []?int32, bool)) -> w.Item1.GetParameters().Length > 0).ToList()
                        var pool = if nonDominated.Count > 0 { nonDominated } else { applicable }
                        let minParamCount = pool.Min((w (T, []Kind, []Type, []?int32, bool)) -> w.Item1.GetParameters().Length)
                        let fewestParams = pool.Where((w (T, []Kind, []Type, []?int32, bool)) -> w.Item1.GetParameters().Length == minParamCount).ToList()
                        let mostSpecific = pool.Where((w (T, []Kind, []Type, []?int32, bool)) -> pool.All((o (T, []Kind, []Type, []?int32, bool)) -> object.ReferenceEquals(w.Item1, o.Item1) || true)).ToList()
                        let nonGeneric = pool.Where((w (T, []Kind, []Type, []?int32, bool)) -> !Resolver.isGeneric(w.Item1)).ToList()
                        let mostConstrained = pool.Where((w (T, []Kind, []Type, []?int32, bool)) -> pool.All((o (T, []Kind, []Type, []?int32, bool)) -> object.ReferenceEquals(w.Item1, o.Item1) || true)).ToList()
                        let selected = pool.Select((c (T, []Kind, []Type, []?int32, bool)) -> c.Item1).ToList()
                        return direct.Count + fewestParams.Count + mostSpecific.Count + nonGeneric.Count + mostConstrained.Count + selected.Count
                    }
                }
            }

            0
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void OverloadedUserCall_PreservesOutRefKind()
    {
        var result = EmittedOracle.Evaluate("""
            import System
            import System.Collections.Immutable
            import GSharp.Core.CodeAnalysis.Binding
            import GSharp.Core.CodeAnalysis.Syntax

            class C {
                func fill(
                    sourceArguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
                    sourceBound ImmutableArray[BoundExpression],
                    parameterCount int32,
                    parameterNameAt (int32) -> string,
                    isOptionalAt ((int32) -> bool)?,
                    calleeName string,
                    out permutedSyntax []ExpressionSyntax?,
                    out permutedBound ImmutableArray[BoundExpression]) bool {
                    permutedSyntax = [parameterCount]ExpressionSyntax?
                    permutedBound = sourceBound
                    return true
                }

                func fill(
                    sourceArguments GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
                    sourceBound ImmutableArray[BoundExpression],
                    parameterCount int32,
                    parameterNameAt (int32) -> string,
                    calleeName string,
                    out permutedSyntax []ExpressionSyntax?,
                    out permutedBound ImmutableArray[BoundExpression]) bool ->
                    fill(sourceArguments, sourceBound, parameterCount, parameterNameAt, isOptionalAt: nil, calleeName, out permutedSyntax, out permutedBound)
            }

            42
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(42, result.Value);
    }

    [Fact]
    public void OverloadedUserCall_PreservesOutRefKindForUserGenericStruct()
    {
        var result = EmittedOracle.Evaluate("""
            struct Box[T] {}
            class Item {}

            class C {
                func fill(value int32, out result Box[Item]) {
                    result = default(Box[Item])
                }

                func fill(out result Box[Item]) {
                    fill(42, out result)
                }
            }

            0
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void UserCall_PreservesOutRefKindForImportedGenericOfSourceType()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Immutable

            enum Kind { A }

            class C {
                func inner(out value ImmutableArray[Kind]) bool {
                    value = default(ImmutableArray[Kind])
                    return true
                }
            }

            func run(c C, out value ImmutableArray[Kind]) bool -> c.inner(out value)

            var value ImmutableArray[Kind] = default
            run(C(), out value)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void ImmutableArrayCreate_PassesThroughSourceTypeSlice()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Immutable

            class Item {}

            func build(values []Item?) ImmutableArray[Item?] ->
                ImmutableArray.Create(values)

            0
            """);

        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void ClrOverloadResolution_PrefersNormalParamsArrayShape()
    {
        var candidates = typeof(ImmutableArray).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(method => method.Name == nameof(ImmutableArray.Create) && method.IsGenericMethodDefinition)
            .ToArray();
        var paramsCandidate = candidates.Single(method =>
            method.GetParameters() is [var parameter]
            && ClrOverloadResolution.IsParamsArrayParameter(parameter));

        var paramsOnly = ClrOverloadResolution.Resolve(new[] { paramsCandidate }, new[] { typeof(object[]) });
        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, paramsOnly.Outcome);

        var result = ClrOverloadResolution.Resolve(candidates, new[] { typeof(object[]) });

        Assert.Equal(ClrOverloadResolution.ResolutionOutcome.Resolved, result.Outcome);
        Assert.False(result.IsExpanded);
        Assert.True(
            ClrOverloadResolution.IsParamsArrayParameter(Assert.Single(result.Best!.GetParameters())),
            ClrOverloadResolution.FormatMethodSignature(result.Best));
    }

    [Fact]
    public void LinqMethodGroup_PreservesSameCompilationElementType()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Immutable
            import System.Linq

            class Item {
                shared {
                    func Keep(value Item) bool -> true
                }
            }

            let values ImmutableArray[Item] = ImmutableArray.Create(Item())
            values.Any(Item.Keep)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void LinqSelectMany_PreservesSameCompilationSourceAndResultTypes()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Immutable
            import System.Linq

            class Node {}
            class Root {
                prop Members ImmutableArray[Node] { get; init; }
            }
            class Tree {
                prop Root Root { get; init; }
            }

            func count(trees ImmutableArray[Tree]) int32 {
                return trees.SelectMany((tree Tree) -> tree.Root.Members).Count()
            }

            0
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(0, result.Value);
    }

    [Fact]
    public void DictionaryTryGetValue_PreservesNullableTupleElements()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic
            import System.Reflection.Metadata

            var direct (MethodDefinitionHandle?, MethodDefinitionHandle?) = default
            let directMissing = direct.Item1 == nil
            var values = Dictionary[string, (MethodDefinitionHandle?, MethodDefinitionHandle?)]()
            let found = values.TryGetValue("missing", out var handles)
            let missing = !found || handles.Item1 == nil
            directMissing && missing
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void DictionaryTryGetValue_PreservesSourceTupleKeyAndImportedValue()
    {
        var result = EmittedOracle.Evaluate("""
            import System.Collections.Generic
            import System.Reflection.Metadata

            class Item {}

            let values = Dictionary[(Item, EntityHandle), EntityHandle]()
            let found = values.TryGetValue((Item(), default(EntityHandle)), out var handle)
            !found && handle.IsNil
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(true, result.Value);
    }

    [Fact]
    public void NullableReferenceParameter_ImplementsSymbolicClrInterfaceSlot()
    {
        var result = EmittedOracle.Evaluate("""
            import System

            class Item : IEquatable[Item] {
                func Equals(other Item?) bool -> other != nil
            }

            0
            """);

        Assert.Empty(result.Diagnostics);
    }

}
