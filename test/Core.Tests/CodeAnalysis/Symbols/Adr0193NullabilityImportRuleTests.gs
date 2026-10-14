// <copyright file="Adr0193NullabilityImportRuleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import Xunit
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System.Collections.Generic
import Xunit.Sdk

/// ADR-0193 Phase 1: (cref:NullabilityImportRule)'s decision tables,
/// its gsc appliers, the walkers routed through it, the
/// (cref:PlatformTypeSymbol.Get) smart-constructor invariant, and the
/// two query members (cref:TypeSymbol.ReferenceNullability) and
/// (cref:TypeSymbol.GetElementPositions).
class Adr0193NullabilityImportRuleTests {
    /// ADR-0193 §1's `DecideOpenSlot` table, every cell. Only an explicit
    /// `[Nullable(2)]` over a known reference argument widens; the
    /// `Annotated` × `Unknown` cell is `Unchanged` by the
    /// owner's ruling on Open question 1 (revisit: #4385).
    /// @param state The declared state at the slot.
    /// @param kind The argument's kind.
    /// @param expected The decision.
    @Theory
    @InlineData("Annotated", "Reference", "Nullable")
    @InlineData("Annotated", "Value", "Unchanged")
    @InlineData("Annotated", "Unknown", "Unchanged")
    @InlineData("NotAnnotated", "Reference", "Unchanged")
    @InlineData("NotAnnotated", "Value", "Unchanged")
    @InlineData("NotAnnotated", "Unknown", "Unchanged")
    @InlineData("Oblivious", "Reference", "Unchanged")
    @InlineData("Oblivious", "Value", "Unchanged")
    @InlineData("Oblivious", "Unknown", "Unchanged")
    func DecideOpenSlot_Is_The_Adr_Table(state string, kind string, expected string) -> Assert.Equal(
        Enum.Parse[ImportedReferenceNullability](expected),
        NullabilityImportRule.DecideOpenSlot(Enum.Parse[ClrNullabilityState](state), Enum.Parse[TypeArgumentKind](kind))
    )

    /// ADR-0186 §2's concrete table: a value position is never wrapped.
    /// @param state The declared state.
    /// @param kind The position's kind.
    /// @param expected The decision.
    @Theory
    @InlineData("NotAnnotated", "Reference", "NotNull")
    @InlineData("Annotated", "Reference", "Nullable")
    @InlineData("Oblivious", "Reference", "Platform")
    @InlineData("NotAnnotated", "Value", "Unchanged")
    @InlineData("Annotated", "Value", "Unchanged")
    @InlineData("Oblivious", "Value", "Unchanged")
    @InlineData("Annotated", "Unknown", "Nullable")
    func DecideConcrete_Is_The_Adr_Table(state string, kind string, expected string) -> Assert.Equal(
        Enum.Parse[ImportedReferenceNullability](expected),
        NullabilityImportRule.DecideConcrete(Enum.Parse[ClrNullabilityState](state), Enum.Parse[TypeArgumentKind](kind))
    )

    /// ADR-0193 §1: `Unchanged` preserves the input exactly. A
    /// `string?` argument substituted into an `Annotated`,
    /// `NotAnnotated` or `Oblivious` open slot is `string?` in
    /// all three.
    /// @param state The declared state at the slot.
    @Theory
    @InlineData("Annotated")
    @InlineData("NotAnnotated")
    @InlineData("Oblivious")
    func ApplyOpenSlot_Keeps_A_Nullable_Argument_Nullable(state string) {
        let argument = NullableTypeSymbol.Get(TypeSymbol.String)
        Assert.Same(argument, NullabilityImportRule.ApplyOpenSlot(argument, Enum.Parse[ClrNullabilityState](state)))
    }

    /// ADR-0193 owner decision 1, at the gsc applier: an annotated open slot
    /// widens a reference argument only. `Min<int>()` returns
    /// `int`; an unconstrained `T` stays `T`; a
    /// reference-constrained `T` becomes `T?`; a platform argument's
    /// unstated nullability yields to the declarer's explicit `?`.
    @Fact
    func ApplyOpenSlot_Annotated_Widens_Only_A_Reference_Argument() {
        const Annotated = ClrNullabilityState.Annotated
        Assert.Same(
            NullableTypeSymbol.Get(TypeSymbol.String),
            NullabilityImportRule.ApplyOpenSlot(TypeSymbol.String, Annotated)
        )
        Assert.Same(TypeSymbol.Int32, NullabilityImportRule.ApplyOpenSlot(TypeSymbol.Int32, Annotated))
        let tuple = TupleTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.String, TypeSymbol.Int32))
        Assert.Same(tuple, NullabilityImportRule.ApplyOpenSlot(tuple, Annotated))
        let unconstrained = TypeParameter()
        Assert.Same(unconstrained, NullabilityImportRule.ApplyOpenSlot(unconstrained, Annotated))
        let classConstrained = TypeParameter()
        classConstrained.HasReferenceTypeConstraint = true
        Assert.Same(
            NullableTypeSymbol.Get(classConstrained),
            NullabilityImportRule.ApplyOpenSlot(classConstrained, Annotated)
        )
        let structConstrained = TypeParameter()
        structConstrained.HasValueTypeConstraint = true
        Assert.Same(structConstrained, NullabilityImportRule.ApplyOpenSlot(structConstrained, Annotated))
        Assert.Same(
            NullableTypeSymbol.Get(TypeSymbol.String),
            NullabilityImportRule.ApplyOpenSlot(PlatformTypeSymbol.Get(TypeSymbol.String), Annotated)
        )
    }

    /// ADR-0193 §2: (cref:PlatformTypeSymbol.Get) normalises in the
    /// mirror direction of (cref:NullableTypeSymbol.Get), so neither
    /// `T?!` nor `T!?` is constructible, and a value type has no
    /// platform reading.
    @Fact
    func PlatformTypeSymbol_Get_Is_A_Normalising_Smart_Constructor() {
        let nullable = NullableTypeSymbol.Get(TypeSymbol.String)
        Assert.Same(nullable, PlatformTypeSymbol.Get(nullable))
        let platform = Assert.IsType[PlatformTypeSymbol](PlatformTypeSymbol.Get(TypeSymbol.String))
        Assert.Same(platform, PlatformTypeSymbol.Get(platform))
        Assert.Same(nullable, NullableTypeSymbol.Get(platform))
        Assert.Same(TypeSymbol.Int32, PlatformTypeSymbol.Get(TypeSymbol.Int32))
        let valueNullable = NullableTypeSymbol.Get(TypeSymbol.Int32)
        Assert.Same(valueNullable, PlatformTypeSymbol.Get(valueNullable))
        let tuple = TupleTypeSymbol.Get(ImmutableArray.Create(TypeSymbol.String, TypeSymbol.String))
        Assert.Same(tuple, PlatformTypeSymbol.Get(tuple))
        let structConstrained = TypeParameter()
        structConstrained.HasValueTypeConstraint = true
        Assert.Same(structConstrained, PlatformTypeSymbol.Get(structConstrained))
        // An unconstrained type parameter is not known to be a value type, so
        // ADR-0186 §9's oblivious wrapping of one is still expressible.
        let unconstrained = TypeParameter()
        Assert.IsType[PlatformTypeSymbol](PlatformTypeSymbol.Get(unconstrained))
        // The invariant, stated over every shape above: a PlatformTypeSymbol
        // never wraps a NullableTypeSymbol, another PlatformTypeSymbol, or a
        // value type.
        for underlying in[]TypeSymbol{
            TypeSymbol.String,
            nullable,
            platform,
            TypeSymbol.Int32,
            valueNullable,
            tuple,
            structConstrained,
            unconstrained
        } {
            if PlatformTypeSymbol.Get(underlying) is PlatformTypeSymbol wrapped {
                Assert.IsNotType[NullableTypeSymbol](wrapped.UnderlyingType)
                Assert.IsNotType[PlatformTypeSymbol](wrapped.UnderlyingType)
                Assert.NotEqual(TypeArgumentKind.Value, NullabilityImportRule.ClassifyArgument(wrapped.UnderlyingType))
            }
        }
    }

    /// ADR-0193 §2: (cref:TypeSymbol.ReferenceNullability)'s four answers.
    @Fact
    func ReferenceNullability_Reads_Through_The_Wrappers() {
        Assert.Equal(ReferenceNullabilityKind.NotNull, TypeSymbol.String.ReferenceNullability)
        Assert.Equal(ReferenceNullabilityKind.Nullable, NullableTypeSymbol.Get(TypeSymbol.String).ReferenceNullability)
        Assert.Equal(ReferenceNullabilityKind.Platform, PlatformTypeSymbol.Get(TypeSymbol.String).ReferenceNullability)
        Assert.Equal(ReferenceNullabilityKind.NotApplicable, TypeSymbol.Int32.ReferenceNullability)
        Assert.Equal(
            ReferenceNullabilityKind.NotApplicable,
            NullableTypeSymbol.Get(TypeSymbol.Int32).ReferenceNullability
        )
        Assert.Equal(ReferenceNullabilityKind.Nullable, TypeSymbol.Null.ReferenceNullability)
        Assert.Equal(ReferenceNullabilityKind.NotNull, TypeParameter().ReferenceNullability)
        let annotated = NullabilityAnnotatedTypeSymbol(
            SliceTypeSymbol.Get(TypeSymbol.String),
            ImmutableArray.Create(uint8(1), uint8(2))
        )
        Assert.Equal(ReferenceNullabilityKind.NotNull, annotated.ReferenceNullability)
        Assert.Equal(ReferenceNullabilityKind.Nullable, NullableTypeSymbol.Get(annotated).ReferenceNullability)
    }

    /// ADR-0193 §2: (cref:TypeSymbol.GetElementPositions) reads both
    /// Layer 3 representations the same way — nested wrappers, and a lazily
    /// decoded (cref:NullabilityAnnotatedTypeSymbol).
    @Fact
    func GetElementPositions_Agrees_Across_Both_Layer3_Representations() {
        using let resolver = ReferenceResolver.Default()
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var listDefinition))
        let listOfString = listDefinition.MakeGenericType(typeof(string))
        // Nested wrapper: `List[string?]` as the symbolic model builds it.
        let nested = ImportedTypeSymbol.GetConstructed(
            listOfString,
            listDefinition,
            ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.String))
        )
        // Lazy flags: the same type as `ClrNullability` decodes `[Nullable({1, 2})]`.
        let lazy = ClrNullability.SymbolFromFlagsOffset(listOfString, ImmutableArray.Create(uint8(1), uint8(2)), 0)
        Assert.Equal(
            ReferenceNullabilityKind.Nullable,
            Assert.Single(nested.GetElementPositions()).ReferenceNullability
        )
        Assert.Equal(ReferenceNullabilityKind.Nullable, Assert.Single(lazy.GetElementPositions()).ReferenceNullability)
        Assert.Equal(
            []ReferenceNullabilityKind{ReferenceNullabilityKind.NotNull, ReferenceNullabilityKind.Platform},
            MapTypeSymbol
                .Get(TypeSymbol.String, PlatformTypeSymbol.Get(TypeSymbol.Object))
                .GetElementPositions()
                .Select((p TypeSymbol) -> p.ReferenceNullability)
        )
    }

    /// A lazily-annotated SYMBOLIC base (no CLR shape to decode against, as
    /// substitution and adapter remapping produce) still reads its flags: a
    /// slice of a reference-constrained `T` carrying `[1, 2]` has a
    /// `T?` element, not a bare `T`.
    @Fact
    func GetElementPositions_Decodes_Flags_Over_A_Symbolic_Base() {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        let parameter = TypeParameter()
        parameter.HasReferenceTypeConstraint = true
        let annotated = NullabilityAnnotatedTypeSymbol(
            SliceTypeSymbol.Get(parameter),
            ImmutableArray.Create(uint8(1), uint8(2))
        )
        Assert.Equal(ReferenceNullabilityKind.NotNull, annotated.ReferenceNullability)
        let element = Assert.Single(annotated.GetElementPositions())
        Assert.Same(NullableTypeSymbol.Get(parameter), element)
        let nonNull = NullabilityAnnotatedTypeSymbol(
            SliceTypeSymbol.Get(parameter),
            ImmutableArray.Create(uint8(1), uint8(1))
        )
        Assert.Same(parameter, Assert.Single(nonNull.GetElementPositions()))
    }

    /// A constructed same-compilation type carries its arguments symbolically,
    /// with no CLR type before emit; its positions are those arguments.
    @Fact
    func GetElementPositions_Reads_A_Constructed_Source_Types_Arguments() {
        const source = `package adr0193positions

class Box[T] {
    var Value T
}

func Take(b Box[string?]) {
}`
        let compilation = GSharp
            .Core
            .CodeAnalysis
            .Compilation
            .Compilation(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))){
            IsLibrary = true,
            Nullability = NullabilityMode.PlatformTypes
        }
        Assert.DoesNotContain(
            compilation.BoundProgram.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError
        )
        let take = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Take")
        let box = Assert.Single(take.Parameters).Type
        Assert.Equal(ReferenceNullabilityKind.NotNull, box.ReferenceNullability)
        Assert.Equal(ReferenceNullabilityKind.Nullable, Assert.Single(box.GetElementPositions()).ReferenceNullability)
    }

    /// ADR-0193 §1, the projection reader's open-slot arm: an explicit
    /// `[Nullable(2)]` annotates the substituted argument's ROOT only.
    /// It used to expand `2` over every position of the argument, so
    /// `[Nullable(2)] TSource` at `TSource := List<string>`
    /// read `List<string?>?` through the projection and
    /// `List<string>?` through the merge.
    @Fact
    func ApplyOpenSlotToFlags_Annotates_Only_The_Arguments_Root() {
        using let resolver = ReferenceResolver.Default()
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var listDefinition))
        Assert.True(resolver.TryResolveType("System.Collections.Generic.KeyValuePair`2", out var pairDefinition))
        let listOfString = listDefinition.MakeGenericType(typeof(string))
        let pair = pairDefinition.MakeGenericType(typeof(string), typeof(string))
        Assert.Equal(
            []uint8{2, 1},
            NullabilityImportRule.ApplyOpenSlotToFlags(listOfString, ClrNullabilityState.Annotated)
        )
        Assert.Equal(
            []uint8{1, 1},
            NullabilityImportRule.ApplyOpenSlotToFlags(listOfString, ClrNullabilityState.Oblivious)
        )
        // A value-type argument takes no `?`, and neither do its inner positions.
        Assert.Equal([]uint8{0, 1, 1}, NullabilityImportRule.ApplyOpenSlotToFlags(pair, ClrNullabilityState.Annotated))
        Assert.Empty(NullabilityImportRule.ApplyOpenSlotToFlags(typeof(int32), ClrNullabilityState.Annotated))
    }

    /// The projection regression end to end, through the real reader and the
    /// real `Enumerable.FirstOrDefault<TSource>` declaration.
    @Fact
    func FirstOrDefault_Over_A_List_Reads_The_Same_Through_Projection_And_Merge() {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        using let resolver = ReferenceResolver.Default()
        Assert.True(resolver.TryResolveType("System.Linq.Enumerable", out var enumerable))
        Assert.True(resolver.TryResolveType("System.Collections.Generic.List`1", out var listDefinition))
        let listOfString = listDefinition.MakeGenericType(typeof(string))
        let open_ = enumerable.GetMethods().Single(
            (m MethodInfo) -> m.Name == "FirstOrDefault" && m.GetParameters().Length == 1
        )
        let closed = open_.MakeGenericMethod(listOfString)
        let projected = ClrNullability.GetReturnTypeSymbol(closed)
        let merged = NullableFlagsBuilder.MergeDeclarationNullability(
            TypeSymbol.FromClrType(listOfString),
            open_.ReturnType,
            ClrNullability.ReadNullableFlags(open_.ReturnParameter, open_)
        )
        for read in[]TypeSymbol{projected, merged} {
            Assert.Equal(ReferenceNullabilityKind.Nullable, read.ReferenceNullability)
            Assert.Equal(
                ReferenceNullabilityKind.NotNull,
                Assert.Single(read.GetElementPositions()).ReferenceNullability
            )
        }
    }

    /// ADR-0193 Open question 1, at the merge reader: an explicit
    /// `[Nullable(2)]` open slot over an unconstrained G# type parameter
    /// leaves it alone. On `main` before Phase 1 the merge widened it to
    /// `T?` (the round-2 guard from PR #4362 was reverted with round 3);
    /// the owner's ruling is `Unchanged`. A reference-constrained
    /// parameter still widens.
    @Fact
    func Merge_Leaves_An_Unconstrained_Type_Parameter_Alone_At_An_Annotated_Slot() {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        using let resolver = ReferenceResolver.Default()
        Assert.True(resolver.TryResolveType("System.Linq.Enumerable", out var enumerable))
        let open_ = enumerable.GetMethods().Single(
            (m MethodInfo) -> m.Name == "FirstOrDefault" && m.GetParameters().Length == 1
        )
        let flags = ClrNullability.ReadNullableFlags(open_.ReturnParameter, open_)
        Assert.Equal(ClrNullabilityState.Annotated, ClrNullability.ClassifyPosition(flags, 0))
        let unconstrained = TypeParameter()
        Assert.Same(
            unconstrained,
            NullableFlagsBuilder.MergeDeclarationNullability(unconstrained, open_.ReturnType, flags)
        )
        let classConstrained = TypeParameter()
        classConstrained.HasReferenceTypeConstraint = true
        Assert.Same(
            NullableTypeSymbol.Get(classConstrained),
            NullableFlagsBuilder.MergeDeclarationNullability(classConstrained, open_.ReturnType, flags)
        )
        // `--nullability=enabled` (retired by #4372) keeps its own arm.
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.Enabled)
            Assert.Same(
                NullableTypeSymbol.Get(unconstrained),
                NullableFlagsBuilder.MergeDeclarationNullability(unconstrained, open_.ReturnType, flags)
            )
        }
    }

    /// ADR-0193 §4 found the field and property readers reading an open
    /// declaration's bytes against the CLOSED type, so an oblivious open slot
    /// stamped `T!` onto the argument — issue #4361's defect, on the one
    /// path its fix did not reach. `Tuple<T1>.Item1` in
    /// netstandard2.0 carries no nullable metadata at all; closed over
    /// `string` it reads `string`, like every sibling reader.
    @Fact
    func An_Oblivious_Open_Slot_Property_Reads_Its_Argument() {
        using let scope_ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        let refDirectory = typeof(Adr0193NullabilityImportRuleTests)
            .Assembly
            .GetCustomAttributes[AssemblyMetadataAttribute]()
            .Single((attribute AssemblyMetadataAttribute) -> attribute.Key == "NetStandard20ReferenceDirectory")
            .Value ??
            throw XunitException("prerequisite missing: NetStandard20ReferenceDirectory")
        Assert.True(Directory.Exists(refDirectory), "prerequisite missing: '$refDirectory'")
        using let resolver = ReferenceResolver.WithReferences(Directory.EnumerateFiles(refDirectory, "*.dll"))
        Assert.True(resolver.TryResolveType("System.Tuple`1", out var tupleDefinition))
        Assert.True(resolver.TryResolveType("System.String", out var stringType))
        let item1 = tupleDefinition.MakeGenericType(stringType).GetProperty("Item1") ??
            throw XunitException("Tuple<T1>.Item1 not found")
        Assert.Same(TypeSymbol.String, ClrNullability.GetPropertyTypeSymbol(item1))
        // …while a concrete oblivious position is still `T!`.
        let toString = tupleDefinition.MakeGenericType(stringType).GetMethod("ToString", Type.EmptyTypes) ??
            throw XunitException("Tuple<T1>.ToString not found")
        Assert.Equal(
            ReferenceNullabilityKind.Platform,
            ClrNullability.GetReturnTypeSymbol(toString).ReferenceNullability
        )
    }

    /// The Open question 1 cell at the program level, where users see it:
    /// `List<T>.Find` returns `[Nullable(2)] T`, and inside a
    /// generic G# function over an unconstrained `T` the call binds as
    /// `T` — the same answer `values.Min()` gives
    /// (`Issue2494EnumLinqExtremaTests`). Before ADR-0193 Phase 1 the
    /// receiver merge widened it to `T?`, and this function reported a
    /// `T?`-to-`T` conversion error.
    @Fact
    func Find_On_A_List_Of_An_Unconstrained_Type_Parameter_Binds_As_T() {
        const source = `package adr0193find
import System
import System.Collections.Generic

func FindIn[T](xs List[T], match Predicate[T]) T -> xs.Find(match)`
        let compilation = GSharp
            .Core
            .CodeAnalysis
            .Compilation
            .Compilation(GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(source))){
            IsLibrary = true,
            Nullability = NullabilityMode.PlatformTypes
        }
        Assert.DoesNotContain(compilation.GlobalScope.Diagnostics, (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError)
        Assert.DoesNotContain(
            compilation.BoundProgram.Diagnostics,
            (d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError
        )
        let function = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "FindIn")
        let finder = FindCallFinder()
        finder.Visit(compilation.BoundProgram.Functions[function])
        Assert.IsType[TypeParameterSymbol](Assert.Single(finder.Types))
    }

    /// A slot is "unsubstituted" only when the argument is the slot's OWN
    /// generic parameter. For a type-level parameter that means the same owner,
    /// not merely the same name and ordinal: `Collection<T>`'s
    /// `T` seen through `ObservableCollection<T>` is a
    /// substitution by a different parameter. A method's parameter is the same
    /// slot whether it is reached through the open or a closed declaring type.
    @Fact
    func IsUnsubstitutedSlot_Compares_The_Owner_Not_The_Name() {
        let baseT = typeof(System.Collections.ObjectModel.Collection[_]).GetGenericArguments()[0]
        let derivedT = typeof(System.Collections.ObjectModel.ObservableCollection[_]).GetGenericArguments()[0]
        Assert.Equal(baseT.Name, derivedT.Name)
        Assert.True(NullabilityImportRule.IsUnsubstitutedSlot(baseT, baseT))
        Assert.False(NullabilityImportRule.IsUnsubstitutedSlot(derivedT, baseT))
        let openConvertAll = typeof(System.Collections.Generic.List[_]).GetMethod("ConvertAll") ??
            throw XunitException("List<T>.ConvertAll not found")
        let closedConvertAll = typeof(List[string]).GetMethod("ConvertAll") ??
            throw XunitException("List<string>.ConvertAll not found")
        Assert.True(
            NullabilityImportRule.IsUnsubstitutedSlot(
                closedConvertAll.GetGenericArguments()[0],
                openConvertAll.GetGenericArguments()[0]
            )
        )
        let select_ = typeof(Enumerable).GetMethods().First((m MethodInfo) -> m.Name == "Select")
        Assert.False(
            NullabilityImportRule.IsUnsubstitutedSlot(
                select_.GetGenericArguments()[0],
                openConvertAll.GetGenericArguments()[0]
            )
        )
    }

    /// The CLR classifier follows a dependent bound transitively, as the
    /// (cref:TypeSymbol) classifier does through
    /// (cref:TypeParameterSymbol.DependentBoundProvesReferenceType):
    /// in `where U : class where T : U`, `T` is a reference, and a
    /// cyclic or interface-only chain is `Unknown`.
    @Fact
    func ClassifyArgument_Follows_A_Clr_Dependent_Bound() {
        let compilation = CSharpCompilation.Create(
            "Adr0193DependentBounds",
            []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(`public class Chain<U, T> where U : class where T : U { }
public class Longer<A, B, C> where A : class where B : A where C : B { }
public class Open<U, T> where T : U { }`)},
            []PortableExecutableReference{MetadataReference.CreateFromFile(typeof(object).Assembly.Location)},
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        using let stream = MemoryStream()
        let emit = compilation.Emit(stream)
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
        let assembly = Assembly.Load(stream.ToArray())
        let Parameter = func (type string, index int32) Type {
            return (assembly.GetType(type) ?? throw XunitException(type + " not emitted")).GetGenericArguments()[index]
        }
        Assert.Equal(TypeArgumentKind.Reference, NullabilityImportRule.ClassifyArgument(Parameter("Chain`2", 1)))
        Assert.Equal(TypeArgumentKind.Reference, NullabilityImportRule.ClassifyArgument(Parameter("Longer`3", 2)))
        Assert.Equal(TypeArgumentKind.Unknown, NullabilityImportRule.ClassifyArgument(Parameter("Open`2", 1)))
        // The symbol overload answers the same chain the same way.
        let bound = TypeParameter()
        bound.HasReferenceTypeConstraint = true
        let dependent = TypeParameterSymbol("T", ordinal: 1, TypeParameterConstraint.Any, TypeParameterVariance.None){
            TypeParameterBound = bound
        }
        Assert.Equal(TypeArgumentKind.Reference, NullabilityImportRule.ClassifyArgument(dependent))
        let unboundedDependent = TypeParameterSymbol(
            "T",
            ordinal: 1,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        ){TypeParameterBound = TypeParameter()}
        Assert.Equal(TypeArgumentKind.Unknown, NullabilityImportRule.ClassifyArgument(unboundedDependent))
    }

    /// Collects the type of every `Find` call in a bound body.
    private class FindCallFinder : GSharp.Core.CodeAnalysis.Binding.BoundTreeWalker {
        init() {
            Types = List[TypeSymbol]()
        }

        internal prop Types List[TypeSymbol] {
            get;
        }

        override func VisitExpression(node GSharp.Core.CodeAnalysis.Binding.BoundExpression?) {
            switch node {
                case call is BoundImportedInstanceCallExpression when call.Method.Name == "Find" {
                    this.Types.Add(call.Type)
                }
                case call is BoundImportedCallExpression when call.Function.Name == "Find" {
                    this.Types.Add(call.Type)
                }
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func TypeParameter() TypeParameterSymbol -> TypeParameterSymbol(
            "T",
            ordinal: 0,
            TypeParameterConstraint.Any,
            TypeParameterVariance.None
        )
    }
}
