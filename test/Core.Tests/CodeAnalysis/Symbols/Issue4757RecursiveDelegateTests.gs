// <copyright file="Issue4757RecursiveDelegateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit
import Xunit.Abstractions

class Issue4757RecursiveDelegateTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Fact
    func DelegateArgumentSlots_ShareFormalAndFallbackVisits() -> this.AssertLinearDelegateArgumentWalks(4)

    @Theory
    @InlineData(int32(4))
    @InlineData(int32(8))
    @InlineData(int32(12))
    @InlineData(int32(18))
    func DelegateArgumentSlots_ScaleLinearly(depth int32) -> this.AssertLinearDelegateArgumentWalks(depth)

    @Fact
    func MutualRecursion_QueriesStillFindTheNonRecursiveOpenBranch() {
        let first = Shell("First")
        let second = Shell("Second")
        first.SetSignature(Parameters(second), first)
        second.SetSignature(Parameters(first), second)
        Assert.False(TypeSymbol.ContainsTypeParameter(first))
        Assert.False(TypeSymbol.AnyTypeParameter(first, (_ TypeParameterSymbol) -> true))
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(first, sink)
        Assert.Empty(sink)
        let outer = Tp("Outer")
        second.SetSignature(Parameters(first), PlatformTypeSymbol.Get(outer))
        Assert.True(TypeSymbol.ContainsTypeParameter(first))
        Assert.True(TypeSymbol.AnyTypeParameter(first, (parameter TypeParameterSymbol) -> parameter == outer))
        Assert.False(TypeSymbol.AnyTypeParameter(first, (parameter TypeParameterSymbol) -> parameter == Tp("Other")))
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(first, ImmutableArray.Create(outer)))
        TypeSymbol.CollectReferencedTypeParameters(first, sink)
        Assert.Equal([]TypeParameterSymbol{outer}, sink)
    }

    @Fact
    func ExpandingConstruction_IsNominalAndRefreshesEarlySignatureProjections() {
        let parameter = Tp("T")
        let definition = Shell("Growing")
        definition.SetTypeParameters(ImmutableArray.Create(parameter))
        let open_ = Construct(definition, parameter)
        Assert.Empty(open_.Parameters)
        Assert.Same(TypeSymbol.Void, open_.ReturnType)
        let earlyFunction = open_.EquivalentFunctionType
        definition.SetSignature(Parameters(open_), Construct(definition, open_))
        let closed = Construct(definition, TypeSymbol.Int32)
        Assert.Same(open_, Assert.Single(open_.Parameters).Type)
        Assert.NotSame(earlyFunction, open_.EquivalentFunctionType)
        Assert.Same(closed, Assert.Single(closed.Parameters).Type)
        Assert.Same(closed, Assert.Single(closed.EquivalentFunctionType.ParameterTypes))
        Assert.Same(parameter, Assert.Single(closed.TypeParameters))
        Assert.Same(definition, closed.Definition)
        Assert.Same(closed, Construct(definition, TypeSymbol.Int32))
        Assert.NotSame(closed, Construct(ShellWithParameter("Growing", parameter), TypeSymbol.Int32))
        var cursor = closed
        for var i = 0; i < 8; i++ {
            let next = Assert.IsType[DelegateTypeSymbol](cursor.ReturnType)
            Assert.Same(cursor, Assert.Single(next.TypeArguments))
            Assert.Same(next, Assert.Single(next.Parameters).Type)
            Assert.False(TypeSymbol.ContainsTypeParameter(next))
            let sink = List[TypeParameterSymbol]()
            TypeSymbol.CollectReferencedTypeParameters(next, sink)
            Assert.Empty(sink)
            cursor = next
        }
        let actual = Tp("Actual")
        let partiallyOpen = Construct(definition, NullableTypeSymbol.Get(actual))
        Assert.True(TypeSymbol.AnyTypeParameter(partiallyOpen, (candidate TypeParameterSymbol) -> candidate == actual))
        Assert.False(
            TypeSymbol.AnyTypeParameter(partiallyOpen, (candidate TypeParameterSymbol) -> candidate == parameter)
        )
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(partiallyOpen, ImmutableArray.Create(actual)))
        let referenced = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(partiallyOpen, referenced)
        Assert.Equal([]TypeParameterSymbol{actual}, referenced)
    }

    @Fact
    func RevisitedDefinition_StillInspectsUnusedActualArgumentsAndPreservesSignatureOrder() {
        let parameter = Tp("T")
        let definition = ShellWithParameter("Phantom", parameter)
        let outer = Tp("Outer")
        definition.SetSignature(Parameters(definition), PlatformTypeSymbol.Get(outer))
        let actual = Tp("Actual")
        let function = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](Construct(definition, TypeSymbol.Int32), Construct(definition, actual)),
            TypeSymbol.Void
        )
        Assert.True(TypeSymbol.AnyTypeParameter(function, (candidate TypeParameterSymbol) -> candidate == actual))
        Assert.True(TypeSymbol.AnyTypeParameter(function, (candidate TypeParameterSymbol) -> candidate == outer))
        Assert.False(TypeSymbol.AnyTypeParameter(function, (candidate TypeParameterSymbol) -> candidate == parameter))
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(function, sink)
        Assert.Equal([]TypeParameterSymbol{outer, actual}, sink)
        let recursive = ShellWithParameter("Revisited", parameter)
        recursive.SetSignature(Parameters(Construct(recursive, TypeSymbol.Int32)), Construct(recursive, actual))
        let closedArgument = Construct(recursive, TypeSymbol.Int32)
        Assert.True(TypeSymbol.AnyTypeParameter(closedArgument, (candidate TypeParameterSymbol) -> candidate == actual))
        Assert.False(
            TypeSymbol.AnyTypeParameter(closedArgument, (candidate TypeParameterSymbol) -> candidate == parameter)
        )
        sink.Clear()
        TypeSymbol.CollectReferencedTypeParameters(closedArgument, sink)
        Assert.Equal([]TypeParameterSymbol{actual}, sink)
    }

    @Fact
    func SiblingConstructions_PreserveEachSignaturesParameterOrder() {
        let t = Tp("T")
        let u = Tp("U")
        let definition = Shell("Swap")
        definition.SetTypeParameters(ImmutableArray.Create(t, u))
        definition.SetSignature(Parameters(u), t)
        let x = Tp("X")
        let y = Tp("Y")
        let z = Tp("Z")
        let w = Tp("W")
        let closed = DelegateTypeSymbol.Construct(
            definition,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, TypeSymbol.String)
        )
        let first = DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](x, y))
        let second = DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](z, w))
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(
            FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](closed, first), TypeSymbol.Void),
            sink
        )
        Assert.Equal([]TypeParameterSymbol{y, x}, sink)
        sink.Clear()
        TypeSymbol.CollectReferencedTypeParameters(
            FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](first, second), TypeSymbol.Void),
            sink
        )
        Assert.Equal([]TypeParameterSymbol{y, x, w, z}, sink)
        definition.SetSignature(
            Parameters(DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](u, t))),
            t
        )
        sink.Clear()
        TypeSymbol.CollectReferencedTypeParameters(
            FunctionTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](first, second), TypeSymbol.Void),
            sink
        )
        Assert.Equal([]TypeParameterSymbol{y, x, w, z}, sink)
    }

    @Fact
    func NestedActualArguments_PreserveSignatureOrderInTheirContainingContext() {
        let t = Tp("T")
        let u = Tp("U")
        let definition = Shell("SwapNested")
        definition.SetTypeParameters(ImmutableArray.Create(t, u))
        definition.SetSignature(Parameters(u), t)
        let x = Tp("X")
        let y = Tp("Y")
        let z = Tp("Z")
        let w = Tp("W")
        let first = DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](x, y))
        let second = DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](z, w))
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(
            DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](first, z)),
            sink
        )
        Assert.Equal([]TypeParameterSymbol{z, y, x}, sink)
        sink.Clear()
        TypeSymbol.CollectReferencedTypeParameters(
            DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](first, second)),
            sink
        )
        Assert.Equal([]TypeParameterSymbol{w, z, y, x}, sink)
        let list = ImportedTypeSymbol.GetConstructed(
            typeof(List[object]),
            typeof(List[_]),
            ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(first))
        )
        let tuple = TupleTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](PlatformTypeSymbol.Get(second), TypeSymbol.Int32)
        )
        let wrapped = DelegateTypeSymbol.Construct(definition, ImmutableArray.Create[TypeSymbol](list, tuple))
        sink.Clear()
        TypeSymbol.CollectReferencedTypeParameters(wrapped, sink)
        Assert.Equal([]TypeParameterSymbol{w, z, y, x}, sink)
        for parameter in sink {
            Assert.True(TypeSymbol.AnyTypeParameter(wrapped, (candidate TypeParameterSymbol) -> candidate == parameter))
        }
        Assert.False(
            TypeSymbol.AnyTypeParameter(wrapped, (candidate TypeParameterSymbol) -> candidate == t || candidate == u)
        )
    }

    @Fact
    func MutualGrowingWrapperSignatures_KeepClosedAndOpenArgumentsDistinct() {
        let t = Tp("T")
        let u = Tp("U")
        let first = ShellWithParameter("WrappedFirst", t)
        let second = ShellWithParameter("WrappedSecond", u)
        let openFirst = Construct(first, u)
        let list = ImportedTypeSymbol.GetConstructed(
            typeof(List[object]),
            typeof(List[_]),
            ImmutableArray.Create[TypeSymbol](openFirst)
        )
        first.SetSignature(Parameters(Construct(second, t)), Construct(second, Construct(first, t)))
        second.SetSignature(
            Parameters(PlatformTypeSymbol.Get(openFirst)),
            TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](list, TypeSymbol.Int32))
        )
        let closed = Construct(first, TypeSymbol.Int32)
        let closedSecond = Assert.IsType[DelegateTypeSymbol](Assert.Single(closed.Parameters).Type)
        Assert.Same(
            closed,
            Assert.IsType[PlatformTypeSymbol](Assert.Single(closedSecond.Parameters).Type).UnderlyingType
        )
        let projected = Assert.IsType[TupleTypeSymbol](closedSecond.ReturnType)
        Assert.Same(closed, Assert.Single(Assert.IsType[ImportedTypeSymbol](projected.ElementTypes[0]).TypeArguments))
        let growing = Assert.IsType[DelegateTypeSymbol](closed.ReturnType)
        Assert.Same(closed, Assert.Single(growing.TypeArguments))
        Assert.False(TypeSymbol.ContainsTypeParameter(closed))
        Assert.False(TypeSymbol.ContainsTypeParameter(growing))
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(growing, sink)
        Assert.Empty(sink)
        let actual = Tp("Actual")
        let open_ = Construct(first, actual)
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(open_, ImmutableArray.Create(actual)))
        Assert.False(
            TypeSymbol.AnyTypeParameter(open_, (candidate TypeParameterSymbol) -> candidate == t || candidate == u)
        )
        TypeSymbol.CollectReferencedTypeParameters(open_, sink)
        Assert.Equal([]TypeParameterSymbol{actual}, sink)
        let outer = Tp("Outer")
        second.SetSignature(
            second.Parameters,
            TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](list, PlatformTypeSymbol.Get(outer)))
        )
        sink.Clear()
        TypeSymbol.CollectReferencedTypeParameters(closed, sink)
        Assert.Equal([]TypeParameterSymbol{outer}, sink)
        Assert.True(TypeSymbol.AnyTypeParameter(closed, (candidate TypeParameterSymbol) -> candidate == outer))
    }

    @Fact
    func SignatureSubstitution_PreservesNullableAndPlatformWrappersAndParameterMetadata() {
        let parameter = Tp("T")
        let definition = ShellWithParameter("Wrapped", parameter)
        let sourceParameter = ParameterSymbol("value", PlatformTypeSymbol.Get(parameter), false)
        sourceParameter.SetExplicitDefaultValue(nil)
        definition.SetSignature(ImmutableArray.Create(sourceParameter), NullableTypeSymbol.Get(parameter))
        let constructed = Construct(definition, TypeSymbol.String)
        let projected = Assert.Single(constructed.Parameters)
        Assert.Same(TypeSymbol.String, Assert.IsType[PlatformTypeSymbol](projected.Type).UnderlyingType)
        Assert.Same(TypeSymbol.String, Assert.IsType[NullableTypeSymbol](constructed.ReturnType).UnderlyingType)
        Assert.Equal("value", projected.Name)
        Assert.True(projected.HasExplicitDefaultValue)
        Assert.Null(projected.ExplicitDefaultValue)
        Assert.Same(projected, Assert.Single(constructed.Parameters))
        Assert.False(TypeSymbol.ContainsTypeParameter(constructed))
    }

    @Fact
    func RecursiveActualArguments_KeepOpenAndClosedContainingContextsDistinct() {
        let tree = SyntaxTree.Parse(SourceText.From(`package P
class Outer[T] { class Inner { } }
delegate D[X](other D[X]) D[D[X]];
func Open[T](value D[Outer[T].Inner]) { }
func Closed(value D[Outer[int32].Inner]) { }`))
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where((diagnostic Diagnostic) -> diagnostic.IsError))
        let open_ = compilation.GlobalScope.Functions.Single((function FunctionSymbol) -> function.Name == "Open")
        let closed = compilation.GlobalScope.Functions.Single((function FunctionSymbol) -> function.Name == "Closed")
        let openType = Assert.Single(open_.Parameters).Type
        let closedType = Assert.Single(closed.Parameters).Type
        let parameter = Assert.Single(open_.TypeParameters)
        Assert.True(TypeSymbol.ContainsTypeParameter(openType))
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(openType, open_.TypeParameters))
        Assert.False(TypeSymbol.ContainsTypeParameter(closedType))
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(openType, sink)
        Assert.Equal([]TypeParameterSymbol{parameter}, sink)
        sink.Clear()
        TypeSymbol.CollectReferencedTypeParameters(closedType, sink)
        Assert.Empty(sink)
    }

    @Fact
    func TupleWrappedRecursion_QueriesDoNotForceConstructedSignatureProjection() {
        let parameter = Tp("T")
        let definition = ShellWithParameter("TupleRecursive", parameter)
        let open_ = Construct(definition, parameter)
        let list = ImportedTypeSymbol.GetConstructed(
            typeof(List[object]),
            typeof(List[_]),
            ImmutableArray.Create[TypeSymbol](open_)
        )
        definition.SetSignature(
            Parameters(open_),
            TupleTypeSymbol.Get(ImmutableArray.Create[TypeSymbol](list, TypeSymbol.Int32))
        )
        let closed = Construct(definition, TypeSymbol.Int32)
        Assert.False(TypeSymbol.ContainsTypeParameter(closed))
        let projected = Assert.IsType[TupleTypeSymbol](closed.ReturnType)
        let projectedList = Assert.IsType[ImportedTypeSymbol](projected.ElementTypes[0])
        Assert.Same(closed, Assert.Single(closed.Parameters).Type)
        Assert.Same(closed, Assert.Single(projectedList.TypeArguments))
        Assert.False(projectedList.HasTypeParameterArgument)
        Assert.True(TypeSymbol.RequiresSymbolicProjection(projectedList))
        Assert.Null(projected.ClrType)
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(closed, sink)
        Assert.Empty(sink)
        Assert.True(TypeSymbol.ContainsTypeParameter(open_))
        TypeSymbol.CollectReferencedTypeParameters(open_, sink)
        Assert.Equal([]TypeParameterSymbol{parameter}, sink)
    }

    @Fact
    func DefinitionSignatures_KeepFormalAndFreeParametersInTheirOwnScopes() {
        let parameter = Tp("T")
        let definition = ShellWithParameter("Definition", parameter)
        definition.SetSignature(Parameters(parameter), TypeSymbol.Void)
        let actual = Tp("Actual")
        let function = FunctionTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](Construct(definition, actual), definition),
            TypeSymbol.Void
        )
        Assert.True(TypeSymbol.AnyTypeParameter(function, (candidate TypeParameterSymbol) -> candidate == parameter))
        Assert.True(TypeSymbol.AnyTypeParameter(function, (candidate TypeParameterSymbol) -> candidate == actual))
        let sink = List[TypeParameterSymbol]()
        TypeSymbol.CollectReferencedTypeParameters(function, sink)
        Assert.Equal([]TypeParameterSymbol{actual, parameter}, sink)
        let unused = ShellWithParameter("Unused", parameter)
        Assert.False(TypeSymbol.ContainsTypeParameter(unused))
        sink.Clear()
        TypeSymbol.CollectReferencedTypeParameters(unused, sink)
        Assert.Empty(sink)
        let nestedParameter = Tp("U")
        let nested = ShellWithParameter("Nested", nestedParameter)
        nested.SetSignature(Parameters(nestedParameter), parameter)
        definition.SetSignature(Parameters(Construct(nested, parameter)), TypeSymbol.Void)
        let closed = Construct(definition, TypeSymbol.Int32)
        let projectedNested = Assert.IsType[DelegateTypeSymbol](Assert.Single(closed.Parameters).Type)
        Assert.Same(TypeSymbol.Int32, Assert.Single(projectedNested.Parameters).Type)
        Assert.Same(parameter, projectedNested.ReturnType)
        Assert.True(TypeSymbol.AnyTypeParameter(closed, (candidate TypeParameterSymbol) -> candidate == parameter))
        TypeSymbol.CollectReferencedTypeParameters(closed, sink)
        Assert.Equal([]TypeParameterSymbol{parameter}, sink)
    }

    private func AssertLinearDelegateArgumentWalks(depth int32) {
        let formal = Tp("T")
        let definition = ShellWithParameter("Finite", formal)
        definition.SetSignature(Parameters(formal), TypeSymbol.Void)
        let actual = Tp("Actual")
        var nested TypeSymbol = actual
        for var index = 0; index < depth; index++ {
            nested = Construct(definition, nested)
        }
        let sink = List[TypeParameterSymbol]()
        var visits = 0
        TypeSymbol.CollectReferencedTypeParameters(nested, sink, (_ DelegateTypeSymbol) -> visits++)
        this.output.WriteLine("single depth=$depth; delegate visits=$visits; expected=$depth")
        Assert.Equal(depth, visits)
        Assert.Equal([]TypeParameterSymbol{actual}, sink)
        Assert.True(TypeSymbol.ContainsOuterMethodTypeParameter(nested, ImmutableArray.Create(actual)))
        let unusedFormal = Tp("Unused")
        let repeated = Shell("Repeated")
        repeated.SetTypeParameters(ImmutableArray.Create(formal, unusedFormal))
        repeated.SetSignature(
            ImmutableArray.Create(ParameterSymbol("first", formal, false), ParameterSymbol("second", formal, false)),
            formal
        )
        let expected = List[TypeParameterSymbol]{actual}
        nested = actual
        for var index = 0; index < depth; index++ {
            let unusedActual = Tp("Unused" + index.ToString())
            expected.Add(unusedActual)
            nested = DelegateTypeSymbol.Construct(
                repeated,
                ImmutableArray.Create[TypeSymbol](nested, PlatformTypeSymbol.Get(unusedActual))
            )
        }
        sink.Clear()
        visits = 0
        TypeSymbol.CollectReferencedTypeParameters(nested, sink, (_ DelegateTypeSymbol) -> visits++)
        this.output.WriteLine("repeated/unused depth=$depth; delegate visits=$visits; expected=$depth")
        Assert.Equal(depth, visits)
        Assert.Equal(expected, sink)
        Assert.False(
            TypeSymbol.AnyTypeParameter(
                nested,
                (candidate TypeParameterSymbol) -> candidate == formal || candidate == unusedFormal
            )
        )
    }

    shared {
        private func Tp(name string) TypeParameterSymbol -> TypeParameterSymbol(
            name,
            0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )

        private func Shell(name string) DelegateTypeSymbol -> DelegateTypeSymbol(
            name,
            "P",
            Accessibility.Public,
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            nil
        )

        private func ShellWithParameter(name string, parameter TypeParameterSymbol) DelegateTypeSymbol {
            let definition = Shell(name)
            definition.SetTypeParameters(ImmutableArray.Create(parameter))
            return definition
        }

        private func Construct(
            definition DelegateTypeSymbol,
            argument TypeSymbol
        ) DelegateTypeSymbol -> DelegateTypeSymbol.Construct(definition, ImmutableArray.Create(argument))

        private func Parameters(type TypeSymbol) ImmutableArray[ParameterSymbol] -> ImmutableArray.Create(
            ParameterSymbol("other", type, false)
        )
    }
}
