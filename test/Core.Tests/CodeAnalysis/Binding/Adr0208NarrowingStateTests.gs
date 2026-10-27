// <copyright file="Adr0208NarrowingStateTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Linq
import System.Text
import Xunit

/// ADR-0208 sections 6 and 7: the immutable narrowing state, its query, its
/// n-ary join and its kill rules. The state is a value, so every test builds
/// states and compares them without a binder.
open class Adr0208NarrowingStateTests {
    @Fact
    func Empty_AnswersNilAndKeepsTheOriginalWhenAFactIsAdded() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let empty = NarrowingState.Empty
        let withFact = empty.With(AccessPath.ForVariable(x), TypeSymbol.String)
        Assert.Null(empty.NarrowedType(AccessPath.ForVariable(x)))
        Assert.Equal(TypeSymbol.String, withFact.NarrowedType(AccessPath.ForVariable(x)))
        Assert.Equal(0, empty.Count)
        Assert.Equal(1, withFact.Count)
    }

    @Fact
    func With_ReplacesTheFactOfAnEqualPathInPlace() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let y = Local("y", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let state = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(x), TypeSymbol.Object)
            .With(AccessPath.ForVariable(y), TypeSymbol.String)
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
        Assert.Equal(2, state.Count)
        Assert.Equal(TypeSymbol.String, state.NarrowedType(AccessPath.ForVariable(x)))
        // The path keeps its insertion position, so enumeration is stable.
        Assert.Same(x, state.Paths[0].Root)
        Assert.Same(y, state.Paths[1].Root)
    }

    @Fact
    func Equality_IsStructuralAndIgnoresEntryOrder() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let y = Local("y", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let a = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
            .With(AccessPath.ForVariable(y), TypeSymbol.Object)
        let b = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(y), TypeSymbol.Object)
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
        let c = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(y), TypeSymbol.Object)
            .With(AccessPath.ForVariable(x), TypeSymbol.Object)
        Assert.Equal(a, b)
        Assert.Equal(a.GetHashCode(), b.GetHashCode())
        Assert.NotEqual(a, c)
        Assert.NotEqual(a, NarrowingState.Unreachable)
    }

    @Fact
    func Unreachable_IsTheIdentityOfJoinAndHoldsNoFacts() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let fact = NarrowingState.Empty.With(AccessPath.ForVariable(x), TypeSymbol.String)
        let unreachable = NarrowingState.Unreachable
        Assert.True(unreachable.IsUnreachable)
        Assert.Equal(fact, NarrowingState.Join(List[NarrowingState]{unreachable, fact}))
        Assert.Equal(fact, NarrowingState.Join(List[NarrowingState]{fact, unreachable}))
        Assert.True(NarrowingState.Join(List[NarrowingState]{unreachable, unreachable}).IsUnreachable)
        Assert.True(NarrowingState.Join(List[NarrowingState]()).IsUnreachable)
        // An unreachable point learns nothing.
        Assert.True(unreachable.With(AccessPath.ForVariable(x), TypeSymbol.String).IsUnreachable)
        Assert.Null(unreachable.NarrowedType(AccessPath.ForVariable(x)))
    }

    @Fact
    func Join_KeepsOnlyThePathsThatEveryPredecessorHas() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let y = Local("y", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let left = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
            .With(AccessPath.ForVariable(y), TypeSymbol.String)
        let right = NarrowingState.Empty.With(AccessPath.ForVariable(x), TypeSymbol.String)
        let joined = left.Join(right)
        Assert.Equal(TypeSymbol.String, joined.NarrowedType(AccessPath.ForVariable(x)))
        Assert.Null(joined.NarrowedType(AccessPath.ForVariable(y)))
    }

    @Fact
    func Join_KeepsTheTypeThatEveryOtherTypeConvertsTo() {
        // `string` converts to `object` by a reference conversion, so the
        // strengthened fact on one side does not erase the outer proof.
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let narrow = NarrowingState.Empty.With(AccessPath.ForVariable(x), TypeSymbol.String)
        let wide = NarrowingState.Empty.With(AccessPath.ForVariable(x), TypeSymbol.Object)
        Assert.Equal(TypeSymbol.Object, narrow.Join(wide).NarrowedType(AccessPath.ForVariable(x)))
        Assert.Equal(TypeSymbol.Object, wide.Join(narrow).NarrowedType(AccessPath.ForVariable(x)))
    }

    /// The gain comparison (ADR-0208 A1, Copilot review of #5247): a joined type that adds
    /// nothing to a held value-type fact must not replace it, and a stronger one must.
    @Fact
    func IsNoStrongerThan_FollowsTheGainTable() {
        let int32 = TypeSymbol.Int32
        let nullableInt32 = NullableTypeSymbol.Get(TypeSymbol.Int32)
        // Equal and reference upcast: adds nothing.
        Assert.True(NarrowingState.IsNoStrongerThan(TypeSymbol.String, TypeSymbol.String))
        Assert.True(NarrowingState.IsNoStrongerThan(TypeSymbol.Object, TypeSymbol.String))
        Assert.False(NarrowingState.IsNoStrongerThan(TypeSymbol.String, TypeSymbol.Object))
        // A boxed value type and its nullable wrapper say less than the value type.
        Assert.True(NarrowingState.IsNoStrongerThan(TypeSymbol.Object, int32))
        Assert.True(NarrowingState.IsNoStrongerThan(nullableInt32, int32))
        // The value type is stronger than what it boxes to or wraps into.
        Assert.False(NarrowingState.IsNoStrongerThan(int32, TypeSymbol.Object))
        Assert.False(NarrowingState.IsNoStrongerThan(int32, nullableInt32))
        // A numeric widening is a different fact, not a weaker one.
        Assert.False(NarrowingState.IsNoStrongerThan(TypeSymbol.Int64, int32))
    }

    @Fact
    func Join_IsOneNaryOperation_NotAPairwiseFold() {
        // ADR-0208 section 6, probe g1: Dog, Cat and Animal on `x Animal?`.
        // `ArgumentException` and `InvalidOperationException` stand for Dog
        // and Cat; `SystemException` is Animal; `Exception` is the declared
        // type. A pairwise fold joins the first two to the declared
        // `Exception`, and then keeps `Exception`. The n-ary join keeps
        // `SystemException`, which every incoming type converts to.
        let dog = TypeSymbol.FromClrType(typeof(ArgumentException))
        let cat = TypeSymbol.FromClrType(typeof(InvalidOperationException))
        let animal = TypeSymbol.FromClrType(typeof(SystemException))
        let declared = NullableTypeSymbol.Get(TypeSymbol.FromClrType(typeof(Exception)))
        let x = Local("x", false, declared)
        let path = AccessPath.ForVariable(x)
        let sDog = NarrowingState.Empty.With(path, dog)
        let sCat = NarrowingState.Empty.With(path, cat)
        let sAnimal = NarrowingState.Empty.With(path, animal)
        let nary = NarrowingState.Join(List[NarrowingState]{sDog, sCat, sAnimal})
        Assert.Equal(animal, nary.NarrowedType(path))
        let folded = sDog.Join(sCat).Join(sAnimal)
        Assert.Equal(TypeSymbol.FromClrType(typeof(Exception)), folded.NarrowedType(path))
        Assert.NotEqual(nary, folded)
    }

    @Fact
    func Join_FallsBackToTheDeclaredNonNullTypeOfAPlainRoot() {
        // `ArgumentException` and `InvalidOperationException` do not convert
        // to each other. Both convert to the declared `Exception` of the root.
        let dog = TypeSymbol.FromClrType(typeof(ArgumentException))
        let cat = TypeSymbol.FromClrType(typeof(InvalidOperationException))
        let exception = TypeSymbol.FromClrType(typeof(Exception))
        let x = Local("x", false, NullableTypeSymbol.Get(exception))
        let path = AccessPath.ForVariable(x)
        let joined = NarrowingState.Empty.With(path, dog).Join(NarrowingState.Empty.With(path, cat))
        Assert.Equal(exception, joined.NarrowedType(path))
    }

    @Fact
    func Join_KeepsTheDeclaredNonNullTypeWhenNoIncomingTypeConverts() {
        // Amendment A1 (#5206): `int32` boxes to `object`, which is not a
        // representation-preserving conversion, and `string` does not convert to
        // `int32`. Both are facts, so the path keeps its declared type `object`.
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let path = AccessPath.ForVariable(x)
        let joined = NarrowingState
            .Empty
            .With(path, TypeSymbol.Int32)
            .Join(NarrowingState.Empty.With(path, TypeSymbol.String))
        Assert.Equal(TypeSymbol.Object, joined.NarrowedType(path))
    }

    @Fact
    func Join_KeepsTheDeclaredTypeOfAnUnrelatedInterfaceRefinement() {
        // Probe i1 (#5206): `settings T?` holds `IDisposable` on one path and `T`
        // on the other. `IDisposable` does not convert to `T`.
        let t = TypeSymbol.FromClrType(typeof(StringBuilder))
        let x = Local("settings", false, NullableTypeSymbol.Get(t))
        let path = AccessPath.ForVariable(x)
        let joined = NarrowingState
            .Empty
            .With(path, TypeSymbol.FromClrType(typeof(IDisposable)))
            .Join(NarrowingState.Empty.With(path, t))
        Assert.Equal(t, joined.NarrowedType(path))
    }

    @Fact
    func Join_KeepsTheDeclaredTypeOfAStableMemberPath() {
        // Amendment A1 extends the fallback to a member path: the last link gives
        // the declared type, with one nullable layer removed.
        // `Exception.InnerException` is declared `Exception?`.
        let owner = Local("owner", true, TypeSymbol.FromClrType(typeof(Exception)))
        let member = typeof(Exception).GetProperty("InnerException")!!
        let path = AccessPath.ForVariable(owner).Append(member)
        let dog = TypeSymbol.FromClrType(typeof(ArgumentException))
        let cat = TypeSymbol.FromClrType(typeof(InvalidOperationException))
        let joined = NarrowingState.Empty.With(path, dog).Join(NarrowingState.Empty.With(path, cat))
        Assert.Equal(TypeSymbol.FromClrType(typeof(Exception)), joined.NarrowedType(path))
        Assert.Equal(TypeSymbol.FromClrType(typeof(Exception)), NarrowingState.DeclaredNonNullType(path))
    }

    @Fact
    func Join_DropsAMemberPathWhoseDeclaredTypeIsNotKnown() {
        // A member of a generic CLR type does not record the receiver's type
        // arguments, so the fallback cannot name the declared type.
        let owner = Local("owner", true, TypeSymbol.FromClrType(typeof(List[string])))
        let member = typeof(List[string]).GetProperty("Capacity")!!
        let path = AccessPath.ForVariable(owner).Append(member)
        let joined = NarrowingState
            .Empty
            .With(path, TypeSymbol.Int32)
            .Join(NarrowingState.Empty.With(path, TypeSymbol.String))
        Assert.Null(joined.NarrowedType(path))
        Assert.Null(NarrowingState.DeclaredNonNullType(path))
    }

    @Fact
    func Join_DropsAPathThatSomePredecessorLacks() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let path = AccessPath.ForVariable(x)
        let joined = NarrowingState.Empty.With(path, TypeSymbol.String).Join(NarrowingState.Empty)
        Assert.Null(joined.NarrowedType(path))
    }

    @Fact
    func Join_IntersectsTheExternalCallableFacts() {
        let f = Local("f", false, TypeSymbol.Object)
        let g = Local("g", false, TypeSymbol.Object)
        let left = NarrowingState.Empty.WithExternalCallable(f).WithExternalCallable(g)
        let right = NarrowingState.Empty.WithExternalCallable(g)
        let joined = left.Join(right)
        Assert.False(joined.IsExternalCallable(f))
        Assert.True(joined.IsExternalCallable(g))
    }

    @Fact
    func Join_ListsPathsInTheOrderOfTheFirstPredecessor() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let y = Local("y", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let z = Local("z", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let first = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(z), TypeSymbol.String)
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
            .With(AccessPath.ForVariable(y), TypeSymbol.String)
        let second = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(y), TypeSymbol.String)
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
            .With(AccessPath.ForVariable(z), TypeSymbol.String)
        let joined = NarrowingState.Join(List[NarrowingState]{first, second})
        Assert.Equal([]string{"z", "x", "y"}, joined.Paths.Select((path AccessPath) -> path.Root.Name).ToArray())
    }

    @Fact
    func Kill_RemovesTheRootsTheNodeAssignsAndTheirCallableFact() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let y = Local("y", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let state = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
            .With(AccessPath.ForVariable(y), TypeSymbol.String)
            .WithExternalCallable(x)
        let killed = state.Kill(Effects(assigned: []VariableSymbol{x}))
        Assert.Null(killed.NarrowedType(AccessPath.ForVariable(x)))
        Assert.False(killed.IsExternalCallable(x))
        Assert.Equal(TypeSymbol.String, killed.NarrowedType(AccessPath.ForVariable(y)))
    }

    @Fact
    func Kill_RemovesMemberPathsOnlyWhenTheNodeMayMutateMembers() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let field = FieldSymbol("F", TypeSymbol.String, Accessibility.Public, isReadOnly: true)
        let plain = AccessPath.ForVariable(x)
        let member = plain.Append(field)
        let state = NarrowingState.Empty.With(plain, TypeSymbol.String).With(member, TypeSymbol.String)
        let untouched = state.Kill(StatementEffects.Empty)
        Assert.Equal(state, untouched)
        let killed = state.Kill(Effects(member: true))
        Assert.Equal(TypeSymbol.String, killed.NarrowedType(plain))
        Assert.Null(killed.NarrowedType(member))
    }

    @Fact
    func Kill_RemovesFactsOnGlobalsWhenACallMayWriteThem() {
        let g = GlobalVariableSymbol("g", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let state = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(g), TypeSymbol.String)
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
        let killed = state.Kill(Effects(global: true))
        Assert.Null(killed.NarrowedType(AccessPath.ForVariable(g)))
        Assert.Equal(TypeSymbol.String, killed.NarrowedType(AccessPath.ForVariable(x)))
    }

    @Fact
    func Kill_OfACallbackThatMayWriteReferenceStorage_RemovesFactsOnRefAndOutParameters() {
        // The callback may overwrite the caller-owned storage behind a `ref` or
        // `out` parameter, with no flag for an unknown write at all.
        let refParameter = ParameterSymbol("p", NullableTypeSymbol.Get(TypeSymbol.Object), refKind: RefKind.Ref)
        let valueParameter = ParameterSymbol("v", NullableTypeSymbol.Get(TypeSymbol.Object))
        let state = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(refParameter), TypeSymbol.String)
            .With(AccessPath.ForVariable(valueParameter), TypeSymbol.String)
        let killed = state.Kill(Effects(writableReference: true))
        Assert.Null(killed.NarrowedType(AccessPath.ForVariable(refParameter)))
        Assert.Equal(TypeSymbol.String, killed.NarrowedType(AccessPath.ForVariable(valueParameter)))
    }

    @Fact
    func Kill_OfACallThatMayWriteGlobals_AlsoRemovesTheExternalCallableFact() {
        let g = GlobalVariableSymbol("g", false, TypeSymbol.Object)
        let state = NarrowingState.Empty.WithExternalCallable(g)
        Assert.False(state.Kill(Effects(global: true)).IsExternalCallable(g))
        Assert.True(state.Kill(StatementEffects.Empty).IsExternalCallable(g))
    }

    @Fact
    func Kill_RemovesIndirectlyWrittenRootsOnlyThroughTheCallersPredicate() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let y = Local("y", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let state = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
            .With(AccessPath.ForVariable(y), TypeSymbol.String)
        let effects = Effects(any: true)
        Assert.Equal(state, state.Kill(effects))
        let killed = state.Kill(effects, (root VariableSymbol) -> object.ReferenceEquals(root, x))
        Assert.Null(killed.NarrowedType(AccessPath.ForVariable(x)))
        Assert.Equal(TypeSymbol.String, killed.NarrowedType(AccessPath.ForVariable(y)))
    }

    @Fact
    func Kill_OfAWriteThroughAPointerRemovesEveryMutableRootButNotReadOnlyPlainOnes() {
        let mutableRoot = Local("m", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let readOnlyRoot = Local("r", true, NullableTypeSymbol.Get(TypeSymbol.Object))
        let state = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(mutableRoot), TypeSymbol.String)
            .With(AccessPath.ForVariable(readOnlyRoot), TypeSymbol.String)
        let killed = state.Kill(Effects(pointer: true))
        Assert.Null(killed.NarrowedType(AccessPath.ForVariable(mutableRoot)))
        Assert.Equal(TypeSymbol.String, killed.NarrowedType(AccessPath.ForVariable(readOnlyRoot)))
    }

    @Fact
    func ForClosureBody_KeepsOnlyPlainFactsOnReadOnlyRoots() {
        let mutableRoot = Local("m", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let readOnlyRoot = Local("r", true, NullableTypeSymbol.Get(TypeSymbol.Object))
        let field = FieldSymbol("F", TypeSymbol.String, Accessibility.Public, isReadOnly: true)
        let state = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(mutableRoot), TypeSymbol.String)
            .With(AccessPath.ForVariable(readOnlyRoot), TypeSymbol.String)
            .With(AccessPath.ForVariable(readOnlyRoot).Append(field), TypeSymbol.String)
            .WithExternalCallable(readOnlyRoot)
        let inside = state.ForClosureBody()
        Assert.Null(inside.NarrowedType(AccessPath.ForVariable(mutableRoot)))
        Assert.Null(inside.NarrowedType(AccessPath.ForVariable(readOnlyRoot).Append(field)))
        Assert.Equal(TypeSymbol.String, inside.NarrowedType(AccessPath.ForVariable(readOnlyRoot)))
        Assert.False(inside.IsExternalCallable(readOnlyRoot))
    }

    @Fact
    func KillRoots_RemovesEveryPathOnTheGivenRoots() {
        let x = Local("x", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let y = Local("y", false, NullableTypeSymbol.Get(TypeSymbol.Object))
        let state = NarrowingState
            .Empty
            .With(AccessPath.ForVariable(x), TypeSymbol.String)
            .With(AccessPath.ForVariable(y), TypeSymbol.String)
        let killed = state.KillRoots(List[VariableSymbol]{y})
        Assert.Equal(TypeSymbol.String, killed.NarrowedType(AccessPath.ForVariable(x)))
        Assert.Null(killed.NarrowedType(AccessPath.ForVariable(y)))
    }

    @Fact
    func StatementEffects_ComposeIsTheUnionOfTheChildren_InOrder() {
        let x = Local("x", false, TypeSymbol.Object)
        let y = Local("y", false, TypeSymbol.Object)
        let first = Effects(assigned: []VariableSymbol{x})
        let second = Effects(assigned: []VariableSymbol{y, x}, member: true)
        let composed = StatementEffects.Compose(List[StatementEffects]{first, second})
        Assert.Equal([]VariableSymbol{x, y}, composed.AssignedRoots.ToArray())
        Assert.True(composed.MayMutateMemberPaths)
        Assert.False(composed.MayMutateAnyRoot)
        Assert.True(composed.AssignsRoot(y))
        Assert.True(StatementEffects.Compose(List[StatementEffects]()).IsEmpty)
        Assert.True(composed.SameEffects(first.Union(second)))
        Assert.False(composed.SameEffects(first))
    }

    shared {
        private func Local(name string, isReadOnly bool, type TypeSymbol) LocalVariableSymbol -> LocalVariableSymbol(
            name,
            isReadOnly,
            type
        )

        private func Effects(
            assigned[]VariableSymbol = nil,
            member bool = false,
            any bool = false,
            pointer bool = false,
            global bool = false,
            writableReference bool = false
        ) StatementEffects {
            let roots = assigned ?? Array.Empty[VariableSymbol]()
            return StatementEffects.Create(
                roots,
                Array.Empty[VariableSymbol](),
                member,
                any,
                pointer,
                global,
                writableReference
            )
        }
    }
}
