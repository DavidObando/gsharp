// <copyright file="InterfaceAdaptationReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

class InterfaceAdaptationReviewTests {
    @Fact
    func RichBaseArgumentHeapRetentionRejectsRefAndRefLikeShapes() {
        let refConstructor ConstructorInfo? = typeof(RefConstructorBase).GetConstructor(
            []Type{typeof(int32).MakeByRefType()}
        )
        Assert.NotNull(refConstructor)
        let refInitializer = BaseConstructorInitializer(
            ImmutableArray[BoundExpression].Empty,
            refConstructor!!,
            ImmutableArray.Create(RefKind.Ref)
        )
        Assert.True(
            GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .IsUnsupportedRichBaseArgument(refInitializer, argumentIndex: 0, TypeSymbol.Int32)
        )
        let valueConstructor ConstructorInfo? = typeof(ValueConstructorBase).GetConstructor([]Type{typeof(int32)})
        Assert.NotNull(valueConstructor)
        let valueInitializer = BaseConstructorInitializer(ImmutableArray[BoundExpression].Empty, valueConstructor!!)
        Assert.False(
            GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .IsUnsupportedRichBaseArgument(valueInitializer, argumentIndex: 0, TypeSymbol.Int32)
        )
        Assert.True(
            GSharp
                .Core
                .CodeAnalysis
                .Binding
                .Binder
                .IsUnsupportedRichBaseArgument(
                valueInitializer,
                argumentIndex: 0,
                TypeSymbol.FromClrType(typeof(ReadOnlySpan[int32]))
            )
        )
    }

    @Fact
    func BodiesWithRichOrAdapterSynthesisBypassIncrementalBodyReuse() {
        let tree = SyntaxTree.Parse(`package AdapterCache
interface Reader { func Read() int32; }
class Source(Value int32) { func Read() int32 -> Value }
func Build(value int32) Reader {
    let rich = object : Reader {
        func Read() int32 -> value
    }
    return adapt[Reader](Source(rich.Read()))
}`)
        let global = GSharp.Core.CodeAnalysis.Binding.Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        let cache = BoundBodyCache()
        let first = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(global, references: nil, cache)
        let second = GSharp.Core.CodeAnalysis.Binding.Binder.BindProgram(global, references: nil, cache)
        let build = global.Functions.Single((function FunctionSymbol) -> function.Name == "Build")
        Assert.NotSame(first.Functions[build], second.Functions[build])
        Assert.True(cache.Hits > int64(0))
        AssertSyntheticBodiesRegistered(first)
        AssertSyntheticBodiesRegistered(second)
    }

    @Fact
    func SourceInitOnlyMismatchIsPartOfTheStructuralPropertyContract() {
        let tree = SyntaxTree.Parse(`package InitContract
interface Target { prop Value int32 { get; set; } }
class Source { prop Value int32 { get; init; } }
func Bad() { let value = adapt[Target](Source()) }`)
        let compilation = Compilation(tree){IsLibrary = true}
        using let pe = MemoryStream()
        let result = compilation.Emit(pe)
        let target = Assert.Single(
            compilation.GlobalScope.Interfaces,
            (symbol InterfaceSymbol) -> symbol.Name == "Target"
        )
        let source = Assert.Single(compilation.GlobalScope.Structs, (symbol StructSymbol) -> symbol.Name == "Source")
        Assert.False(Assert.Single(target.Properties).IsInitOnly)
        Assert.True(Assert.Single(source.Properties).IsInitOnly)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0606")
    }

    @Fact
    func UserPropertyContractRequiresMatchingUnscopedRefMetadata() {
        let target = CreateRefProperty(unscoped: true)
        let source = CreateRefProperty(unscoped: false)
        Assert.False(GSharp.Core.CodeAnalysis.Binding.Binder.PropertyContractsMatch(target, source))
        source.GetterSymbol?.MarkUnscopedRef()
        Assert.True(GSharp.Core.CodeAnalysis.Binding.Binder.PropertyContractsMatch(target, source))
    }

    @Fact
    func AdapterNamesRemainUniqueAcrossBindingPhasesFilesPackagesAndRepeatedEmit() {
        let trees = []SyntaxTree{SyntaxTree.Parse(SourceText.From(`package AdapterNames
public interface Reader { func Read() int32; }
public class Source(Value int32) { public func Read() int32 -> Value }
let top = adapt[Reader](Source(1))`, "top.gs")), SyntaxTree
                .Parse(
                SourceText.From(
                    "package AdapterNames\npublic func Build() Reader { return adapt[Reader](Source(2)) }",
                    "body.gs"
                )
            ), SyntaxTree.Parse(SourceText.From(`package AdapterNames.Consumer
import AdapterNames
public func BuildOther() Reader { return adapt[Reader](Source(3)) }`, "other.gs"))}
        let compilation = Compilation(trees)
        using let first = MemoryStream()
        using let second = MemoryStream()
        let firstResult = compilation.Emit(first)
        let secondResult = compilation.Emit(second)
        Assert.True(
            firstResult.Success,
            string.Join("; ", firstResult.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Message))
        )
        Assert.True(
            secondResult.Success,
            string.Join("; ", secondResult.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Message))
        )
        Assert.Equal(first.ToArray(), second.ToArray())
        first.Position = 0
        let context = AssemblyLoadContext(
            "AdapterNamesRemainUniqueAcrossBindingPhasesFilesPackagesAndRepeatedEmit",
            isCollectible: true
        )
        try {
            let assembly = context.LoadFromStream(first)
            let adapters = assembly
                .GetTypes()
                .Where((type Type) -> type.Name.StartsWith("<>Adapter", StringComparison.Ordinal))
                .ToArray()
            Assert.Equal(3, adapters.Length)
            Assert.Equal(
                adapters.Length,
                adapters.Select((type Type) -> type.FullName!!).Distinct(StringComparer.Ordinal).Count()
            )
            Assert.Equal(
                []string{"<>Adapter0", "<>Adapter1", "<>Adapter2"},
                adapters
                    .Select((type Type) -> type.Name)
                    .OrderBy((name string) -> name, StringComparer.Ordinal)
                    .ToArray()
            )
        } finally {
            context.Unload()
        }
    }

    private class RefConstructorBase {
        init(ref value int32) { }
    }

    private class ValueConstructorBase {
        init(value int32) { }
    }

    shared {
        private func AssertSyntheticBodiesRegistered(program BoundProgram) {
            let syntheticTypes = program
                .Structs
                .Where(
                (type StructSymbol) -> type.Name.StartsWith("<>AnonClass", StringComparison.Ordinal) ||
                    type
                    .Name
                    .StartsWith("<>Adapter", StringComparison.Ordinal)
            )
                .ToArray()
            Assert.Equal(2, syntheticTypes.Length)
            for method in syntheticTypes.SelectMany(
                func (type StructSymbol) IEnumerable[FunctionSymbol] {
                    return type.Methods
                }
            ) {
                Assert.True(program.Functions.ContainsKey(method), method.Name)
            }
        }

        private func CreateRefProperty(unscoped bool) PropertySymbol {
            let property = PropertySymbol(
                "Value",
                TypeSymbol.Int32,
                Accessibility.Public,
                hasGetter: true,
                hasSetter: false,
                isAutoProperty: false,
                isVirtual: false,
                isOverride: false
            ){ReturnRefKind = RefKind.Ref}
            let getter = FunctionSymbol(
                "get_Value",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Int32,
                declaration: nil,
                $package: nil,
                Accessibility.Public
            ){IsSpecialName = true, ReturnRefKind = RefKind.Ref}
            if unscoped {
                getter.MarkUnscopedRef()
            }
            property.GetterSymbol = getter
            return property
        }
    }
}
