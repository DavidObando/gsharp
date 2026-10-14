// <copyright file="ClrNullabilityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Symbols

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import Xunit

/// Phase 3.C.5 / ADR-0001 / issue #209: BCL nullable interop.
///
/// Covers value-type lift (`Nullable<T>` on the CLR side becomes
/// (cref:NullableTypeSymbol) on the GSharp side) and reference-type
/// surfacing via `[NullableContext]` / `[Nullable]` attributes,
/// including inner-position generic-type-argument nullability.
open class ClrNullabilityTests {
    @Fact
    func NullableValueType_LiftsToNullableTypeSymbol() {
        let sym = TypeSymbol.FromClrType(typeof(int32?))
        let nullable = Assert.IsType[NullableTypeSymbol](sym)
        Assert.Same(TypeSymbol.Int32, nullable.UnderlyingType)
    }

    @Fact
    func NonNullableValueType_StaysFlat() {
        let sym = TypeSymbol.FromClrType(typeof(int32))
        Assert.Same(TypeSymbol.Int32, sym)
        Assert.IsNotType[NullableTypeSymbol](sym)
    }

    @Fact
    func ReferenceTypeAnnotation_SurfacesAsNullable() {
        // Sample.AnnotatedReturn is annotated `string?` so the binder should
        // see NullableTypeSymbol(String).
        let method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetMethod("AnnotatedReturn")
        let sym = ClrNullability.GetReturnTypeSymbol(method!!)
        let nullable = Assert.IsType[NullableTypeSymbol](sym)
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType)
    }

    @Fact
    func ReferenceTypeNonNullAnnotation_StaysFlat() {
        let method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetMethod("NonNullReturn")
        let sym = ClrNullability.GetReturnTypeSymbol(method!!)
        Assert.Same(TypeSymbol.String, sym)
    }

    // -----------------------------------------------------------------------
    // Issue #209: inner-position (generic type argument) nullability
    // -----------------------------------------------------------------------
    @Fact
    func Dictionary_ValueAnnotatedNullable_SurfacesInnerNullability() {
        // Sample.GetDictionary returns Dictionary<string, string?>.
        // The NullableAttribute byte array is {1, 1, 2}:
        //   [0] = 1 → Dictionary itself is non-null
        //   [1] = 1 → string key is non-null
        //   [2] = 2 → string? value is nullable
        let method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetMethod("GetDictionary")
        let sym = ClrNullability.GetReturnTypeSymbol(method!!)
        // Top level: Dictionary is non-nullable → NullabilityAnnotatedTypeSymbol (not NullableTypeSymbol)
        let annotated = Assert.IsType[NullabilityAnnotatedTypeSymbol](sym)
        Assert.Equal(typeof(Dictionary[string, string]), annotated.ClrType)
        // Key type (arg 0): string — non-nullable
        let keyType = annotated.GetTypeArgumentSymbol(0)
        Assert.Same(TypeSymbol.String, keyType)
        Assert.IsNotType[NullableTypeSymbol](keyType)
        // Value type (arg 1): string? — nullable
        let valueType = annotated.GetTypeArgumentSymbol(1)
        let nullableValue = Assert.IsType[NullableTypeSymbol](valueType)
        Assert.Same(TypeSymbol.String, nullableValue.UnderlyingType)
    }

    @Fact
    func Dictionary_ValueAnnotatedNullable_GetTypeArgumentSymbolForClrType_Works() {
        let method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetMethod("GetDictionary")
        let sym = ClrNullability.GetReturnTypeSymbol(method!!)
        let annotated = Assert.IsType[NullabilityAnnotatedTypeSymbol](sym)
        // Lookup by CLR type: string key
        let keyType = annotated.GetTypeArgumentSymbolForClrType(typeof(string))
        // The first string arg (key) is non-nullable.
        Assert.Same(TypeSymbol.String, keyType)
        Assert.IsNotType[NullableTypeSymbol](keyType)
    }

    @Fact
    func List_ElementAnnotatedNullable_SurfacesInnerNullability() {
        // Sample.GetList returns List<string?>.
        // NullableAttribute byte array: {1, 2}
        //   [0] = 1 → List is non-null
        //   [1] = 2 → string? element is nullable
        let method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetMethod("GetList")
        let sym = ClrNullability.GetReturnTypeSymbol(method!!)
        let annotated = Assert.IsType[NullabilityAnnotatedTypeSymbol](sym)
        Assert.Equal(typeof(List[string]), annotated.ClrType)
        // Element type (arg 0): string? — nullable
        let elemType = annotated.GetTypeArgumentSymbol(0)
        let nullableElem = Assert.IsType[NullableTypeSymbol](elemType)
        Assert.Same(TypeSymbol.String, nullableElem.UnderlyingType)
    }

    @Fact
    func List_ElementAnnotatedNullable_GetTypeArgumentSymbolForClrType_Works() {
        let method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetMethod("GetList")
        let sym = ClrNullability.GetReturnTypeSymbol(method!!)
        let annotated = Assert.IsType[NullabilityAnnotatedTypeSymbol](sym)
        let elemType = annotated.GetTypeArgumentSymbolForClrType(typeof(string))
        let nullableElem = Assert.IsType[NullableTypeSymbol](elemType)
        Assert.Same(TypeSymbol.String, nullableElem.UnderlyingType)
    }

    @Fact
    func List_ElementAnnotatedNullable_OpenIndexerParameterMapsByPosition() {
        let method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetMethod("GetList")
        let sym = ClrNullability.GetReturnTypeSymbol(method!!)
        let annotated = Assert.IsType[NullabilityAnnotatedTypeSymbol](sym)
        let openElement = typeof(List[_]).GetGenericArguments()[0]
        let elemType = annotated.GetTypeArgumentSymbolForClrType(openElement)
        let nullableElem = Assert.IsType[NullableTypeSymbol](elemType)
        Assert.Same(TypeSymbol.String, nullableElem.UnderlyingType)
    }

    @Theory
    @InlineData("GetNullableSurface", true)
    @InlineData("GetNonNullSurface", false)
    func ImportedGenericReceiver_ProjectsArgumentNullabilityAcrossMembers(factoryName string, expectedNullable bool) {
        let factory = Assert.IsAssignableFrom[MethodInfo](
            NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
                .GetMethod(factoryName)
        )
        let receiver = ClrNullability.GetReturnTypeSymbol(factory)
        let receiverClr = Assert.IsAssignableFrom[Type](receiver.ClrType)
        let property = Assert.IsAssignableFrom[PropertyInfo](receiverClr.GetProperty("Property"))
        let field = Assert.IsAssignableFrom[FieldInfo](receiverClr.GetField("Field"))
        let get = Assert.IsAssignableFrom[MethodInfo](receiverClr.GetMethod("Get"))
        let set = Assert.IsAssignableFrom[MethodInfo](receiverClr.GetMethod("Set"))
        let tryGet = Assert.IsAssignableFrom[MethodInfo](receiverClr.GetMethod("TryGet"))
        let indexer = Assert.IsAssignableFrom[PropertyInfo](receiverClr.GetProperty("Item"))
        AssertStringNullability(MemberLookup.GetClrPropertyTypeSymbol(receiver, property), expectedNullable)
        AssertStringNullability(MemberLookup.GetClrFieldTypeSymbol(receiver, field), expectedNullable)
        AssertStringNullability(MemberLookup.GetClrMethodReturnTypeSymbol(receiver, get), expectedNullable)
        AssertStringNullability(MemberLookup.GetClrMethodParameterTypeSymbol(receiver, set, 0), expectedNullable)
        AssertStringNullability(
            Assert.IsType[ByRefTypeSymbol](MemberLookup.GetClrMethodParameterTypeSymbol(receiver, tryGet, 0))
                .PointeeType,
            expectedNullable
        )
        AssertStringNullability(MemberLookup.GetClrPropertyTypeSymbol(receiver, indexer), expectedNullable)
        Assert.Same(TypeSymbol.Int32, MemberLookup.GetIndexerParameterTypeSymbol(receiver, indexer, 0))
    }

    @Theory
    @InlineData("GetNullableSurface", true)
    @InlineData("GetNonNullSurface", false)
    func ImportedGenericReceiver_ProjectsNestedMemberArgumentNullability(factoryName string, expectedNullable bool) {
        let factory = Assert.IsAssignableFrom[MethodInfo](
            NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
                .GetMethod(factoryName)
        )
        let receiver = ClrNullability.GetReturnTypeSymbol(factory)
        let receiverClr = Assert.IsAssignableFrom[Type](receiver.ClrType)
        let nested = Assert.IsAssignableFrom[PropertyInfo](receiverClr.GetProperty("Nested"))
        let projected = MemberLookup.GetClrPropertyTypeSymbol(receiver, nested)
        let imported = Assert.IsType[ImportedTypeSymbol](
            if projected is NullabilityAnnotatedTypeSymbol annotated {
                annotated.BaseType
            } else {
                projected
            }
        )
        let importedClr = Assert.IsAssignableFrom[Type](imported.ClrType)
        let element = if imported.TypeArguments.IsDefaultOrEmpty {
            TypeSymbol.FromClrType(importedClr.GetGenericArguments()[0])
        } else {
            imported.TypeArguments[0]
        }
        AssertStringNullability(element, expectedNullable)
    }

    @Fact
    func FuncParameter_WithNullableFirstArg_SurfacesInnerNullability() {
        // Sample.AcceptFunc takes a Func<string?, int> parameter.
        // NullableAttribute byte array on that parameter: {1, 2}
        //   [0] = 1 → Func is non-null
        //   [1] = 2 → string? first arg is nullable
        // (int is a value type — contributes no byte)
        let method = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetMethod("AcceptFunc")
        let parameter = method!!.GetParameters()[0]
        let sym = ClrNullability.GetParameterTypeSymbol(parameter)
        let annotated = Assert.IsType[NullabilityAnnotatedTypeSymbol](sym)
        Assert.Equal(typeof((string) -> int32), annotated.ClrType)
        // First type argument (string?): nullable
        let arg0 = annotated.GetTypeArgumentSymbol(0)
        let nullableArg = Assert.IsType[NullableTypeSymbol](arg0)
        Assert.Same(TypeSymbol.String, nullableArg.UnderlyingType)
    }

    @Fact
    func CountNullabilityBytes_SimpleRefType_Returns1() {
        Assert.Equal(1, ClrNullability.CountNullabilityBytes(typeof(string)))
    }

    @Fact
    func CountNullabilityBytes_ValueType_Returns0() {
        Assert.Equal(0, ClrNullability.CountNullabilityBytes(typeof(int32)))
    }

    @Fact
    func CountNullabilityBytes_GenericRefType_IncludesArgs() {
        // Dictionary<string, string>: 1 (Dict) + 1 (string key) + 1 (string value) = 3
        Assert.Equal(3, ClrNullability.CountNullabilityBytes(typeof(Dictionary[string, string])))
    }

    @Fact
    func CountNullabilityBytes_GenericMixedArgs_SkipsValueType() {
        // Dictionary<int, string>: 1 (Dict) + 0 (int key) + 1 (string value) = 2
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(typeof(Dictionary[int32, string])))
    }

    @Fact
    func CountNullabilityBytes_GenericValueType_IncludesLeadingPlaceholder() {
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(typeof(ValueTuple[string])))
        Assert.Equal(4, ClrNullability.CountNullabilityBytes(typeof(Dictionary[ValueTuple[string], object])))
    }

    @Fact
    func NullableValueTuple_IsMetadataTransparentAndKeepsInnerAnnotations() {
        let clrType = typeof((object, string)?)
        let flags = ImmutableArray.Create[uint8](uint8(0), uint8(1), uint8(2))
        Assert.Equal(3, ClrNullability.CountNullabilityBytes(clrType))
        let nullable = Assert.IsType[NullableTypeSymbol](ClrNullability.SymbolFromFlagsOffset(clrType, flags, 0))
        let tuple = Assert.IsType[TupleTypeSymbol](nullable.UnderlyingType)
        Assert.Same(TypeSymbol.Object, tuple.ElementTypes[0])
        let nullableText = Assert.IsType[NullableTypeSymbol](tuple.ElementTypes[1])
        Assert.Same(TypeSymbol.String, nullableText.UnderlyingType)
        Assert.Equal(flags.ToArray(), NullableFlagsBuilder.Build(nullable).ToArray())
    }

    @Fact
    func NullableGenericValueArgument_DoesNotShiftFollowingSibling() {
        let clrType = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+PairContainer`2"
        )
            .MakeGenericType(typeof(KeyValuePair[string, object]?), typeof(string))
        let flags = ImmutableArray.Create[uint8](uint8(1), uint8(0), uint8(2), uint8(1), uint8(1))
        Assert.Equal(5, ClrNullability.CountNullabilityBytes(clrType))
        let container = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            ClrNullability.SymbolFromFlagsOffset(clrType, flags, 0)
        )
        let nullablePair = Assert.IsType[NullableTypeSymbol](container.GetTypeArgumentSymbol(0))
        let pair = Assert.IsType[NullabilityAnnotatedTypeSymbol](nullablePair.UnderlyingType)
        let nullableKey = Assert.IsType[NullableTypeSymbol](pair.GetTypeArgumentSymbol(0))
        Assert.Same(TypeSymbol.String, nullableKey.UnderlyingType)
        Assert.Same(TypeSymbol.Object, pair.GetTypeArgumentSymbol(1))
        Assert.Same(TypeSymbol.String, container.GetTypeArgumentSymbol(1))
        Assert.Equal(flags.ToArray(), NullableFlagsBuilder.Build(container).ToArray())
    }

    @Fact
    func StructConstrainedGenericParameter_ConsumesObliviousSlot() {
        // Pin Roslyn's scalar compression as an imported metadata contract.
        using let fixture = CSharpFixture(`#nullable enable
public class PairContainer<T, U> {}
public struct ValueContainer<T> {}
public static class Sample
{
    public static string First => "";
    public static string Second => "";
    public static string Third => "";
    public static PairContainer<T, string?> MakeStructPair<T>() where T : struct => new();
    public static ValueContainer<T> MakeStructValue<T>() where T : struct => default;
}`)
        // throwOnError guarantees the fixture type is returned or the lookup throws.
        let sample = fixture.Load().GetType("Sample", throwOnError: true)!!
        let pairMethod = sample.GetMethod("MakeStructPair")
        Assert.NotNull(pairMethod)
        let pairFlags = ClrNullability.ReadNullableFlags(pairMethod!!.ReturnParameter, pairMethod)
        Assert.Equal([]uint8{1, 0, 2}, pairFlags.ToArray())
        Assert.Equal(3, ClrNullability.CountNullabilityBytes(pairMethod!!.ReturnType))
        let pair = Assert.IsType[NullabilityAnnotatedTypeSymbol](ClrNullability.GetReturnTypeSymbol(pairMethod!!))
        Assert.IsNotType[NullableTypeSymbol](pair.GetTypeArgumentSymbol(0))
        Assert.IsType[NullableTypeSymbol](pair.GetTypeArgumentSymbol(1))
        Assert.Equal(pairFlags.ToArray(), NullableFlagsBuilder.Build(pair).ToArray())
        let valueMethod = sample.GetMethod("MakeStructValue")
        Assert.NotNull(valueMethod)
        let valueFlags = ClrNullability.ReadNullableFlags(valueMethod!!.ReturnParameter, valueMethod)
        Assert.Equal([]uint8{0}, valueFlags.ToArray())
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(valueMethod!!.ReturnType))
        Assert.Equal([]uint8{0, 0}, ClrNullability.ExpandNullableFlags(valueMethod!!.ReturnType, valueFlags).ToArray())
        let value = Assert.IsType[NullabilityAnnotatedTypeSymbol](ClrNullability.GetReturnTypeSymbol(valueMethod!!))
        Assert.IsNotType[NullableTypeSymbol](value.GetTypeArgumentSymbol(0))
        Assert.Equal(valueFlags.ToArray(), NullableFlagsBuilder.Build(value).ToArray())
    }

    @Fact
    func SymbolicStructConstraint_EmitsPairAndValueOuterSlots() {
        let parameter = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None){
            HasValueTypeConstraint = true
        }
        let pair = ImportedTypeSymbol.GetConstructed(
            NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+PairContainer`2")
                .MakeGenericType(typeof(int32), typeof(string)),
            NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+PairContainer`2"
            ),
            ImmutableArray.Create[TypeSymbol](parameter, NullableTypeSymbol.Get(TypeSymbol.String))
        )
        let value = ImportedTypeSymbol.GetConstructed(
            NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+ValueContainer`1"
            )
                .MakeGenericType(typeof(int32)),
            NativeMetadataFixtures.GetType(
                "GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+ValueContainer`1"
            ),
            ImmutableArray.Create[TypeSymbol](parameter)
        )
        Assert.Equal([]uint8{1, 0, 2}, NullableFlagsBuilder.Build(pair).ToArray())
        Assert.Equal([]uint8{0, 0}, NullableFlagsBuilder.Build(value).ToArray())
    }

    @Fact
    func RectangularArray_NullableElementAndOuterAnnotations_RoundTrip() {
        let nonNullMethod = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample"
        )
            .GetMethod("GetNullableElementGrid")
        // The embedded native Sample contract declares this method.
        let nonNullSymbol = Assert.IsType[RectangularArrayTypeSymbol](
            ClrNullability.GetReturnTypeSymbol(nonNullMethod!!)
        )
        Assert.Equal(2, nonNullSymbol.Rank)
        var nullableElement = Assert.IsType[NullableTypeSymbol](nonNullSymbol.ElementType)
        Assert.Same(TypeSymbol.String, nullableElement.UnderlyingType)
        let nullableMethod = NativeMetadataFixtures.GetType(
            "GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample"
        )
            .GetMethod("GetNullableGrid")
        // The embedded native Sample contract declares this method.
        let nullableOuter = Assert.IsType[NullableTypeSymbol](ClrNullability.GetReturnTypeSymbol(nullableMethod!!))
        let nullableGrid = Assert.IsType[RectangularArrayTypeSymbol](nullableOuter.UnderlyingType)
        Assert.Equal(2, nullableGrid.Rank)
        nullableElement = Assert.IsType[NullableTypeSymbol](nullableGrid.ElementType)
        Assert.Same(TypeSymbol.String, nullableElement.UnderlyingType)
    }

    @Fact
    func CountNullabilityBytes_RectangularArray_IncludesElement() {
        Assert.Equal(2, ClrNullability.CountNullabilityBytes(typeof([,]string)))
        Assert.Equal(1, ClrNullability.CountNullabilityBytes(typeof([, ,]int32)))
    }

    /// ADR-0186 §2's open-type-parameter carve-out, and the distinction the
    /// projection path has to make to honour it: <b>an explicit byte at an
    /// open slot is not obliviousness.</b>
    ///
    /// Two declarations reach `ProjectNullableFlags` with byte `0`
    /// at an open type-parameter slot and they mean opposite things.
    /// `Enumerable.Cast<TResult>`, in the fully ANNOTATED BCL,
    /// carries an <em>explicit</em> `0` there — csc's encoding for an
    /// unconstrained parameter that may be a value type. §2 says the
    /// argument wins, so `Cast[MethodBase]()` must be
    /// `IEnumerable[MethodBase]` and not
    /// `IEnumerable[MethodBase!]`.
    ///
    /// Reading it as the latter is what made an ordinary two-armed
    /// conditional stop compiling under the flip, with a diagnostic that
    /// named one type twice because a nested argument's `!` does not
    /// reach the display — and it is what took the self-migration guard from
    /// 8/8 to 2/8. The absent case (a declaration with no nullable metadata
    /// at all) gets the same answer — issue #4361 — and is pinned against
    /// csc-emitted oblivious metadata by
    /// `Adr0186PlatformTypeBindingTests.Section2_AnOpenSlot_OfAnUnannotatedGeneric_Reads_ItsArgument`.
    @Fact
    func Adr0186_AnOpenSlot_TakesItsNullabilityFromTheArgument() {
        using let nullabilityScope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        let cast = typeof(Enumerable)
            .GetMethods()
            .Single((m MethodInfo) -> m.Name == "Cast" && m.IsGenericMethodDefinition)
            .MakeGenericMethod(typeof(MethodBase))
        let returned = ClrNullability.GetReturnTypeSymbol(cast)
        // Neither the container nor its element is platform-typed: the
        // container is an annotated non-null `IEnumerable`, and the element
        // is whatever the caller supplied — here G#'s non-null `MethodBase`.
        Assert.IsNotType[PlatformTypeSymbol](returned)
        Assert.IsNotType[NullableTypeSymbol](returned)
        Assert.DoesNotContain("!", returned.Name, StringComparison.Ordinal)
        if returned is NullabilityAnnotatedTypeSymbol annotated {
            Assert.IsNotType[PlatformTypeSymbol](annotated.GetTypeArgumentSymbol(0))
        }
    }

    /// Issue #4361 (review): an imported array's own nullability is displayed
    /// in ADR-0132's positional spelling, whichever wrapper carries it. A
    /// nullable array of platform elements — flags `[2, 0]`, which the
    /// reader produces — printed as `[]string!?`, ADR-0132's spelling of
    /// a slice of nullable elements; it is `[]?string!`.
    @Fact
    func Adr0186_AnImportedArray_Displays_ItsOwnNullability_Positionally() {
        using let nullabilityScope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        let annotated = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.FromClrType(typeof([]string)),
            ImmutableArray.Create(uint8(2), uint8(0))
        )
        Assert.Equal("[]?string!", SymbolDisplay.ToTypeDisplayString(NullableTypeSymbol.Get(annotated)))
        Assert.Equal("[]!string!", SymbolDisplay.ToTypeDisplayString(PlatformTypeSymbol.Get(annotated)))
        // Review round 3: rendering a platform argument must not start
        // rendering a NULLABLE sibling. `Dictionary<string, string?>` with an
        // oblivious key shows the key's `!` and keeps the value's `?` unshown,
        // exactly as before the display change.
        let dictionary = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.FromClrType(typeof(Dictionary[string, string])),
            ImmutableArray.Create(uint8(1), uint8(0), uint8(2))
        )
        Assert.Equal(
            "System.Collections.Generic.Dictionary[string!, string]",
            SymbolDisplay.ToTypeDisplayString(dictionary)
        )
    }

    /// ADR-0186 step 3: the same five readers, under the new default.
    ///
    /// The five ADR-0136 tests around this one are scoped to
    /// `enabled` and keep asserting `T?` for an oblivious position,
    /// which is what that mode means. This is their companion under
    /// `platform-types`, gathered into one place so the change is
    /// visible as a set rather than scattered as five renamed expectations:
    /// every oblivious reading becomes `T!`, and nothing else moves.
    ///
    /// The last row is the one worth reading twice. Re-emitting a
    /// <em>nullable</em> wrapper over an annotated `List<string>`
    /// whose inner metadata is EMPTY produces `[2, 0]` rather than
    /// `[2]`: the scalar form would say the element is nullable, and
    /// under ADR-0186 an absent inner byte says the element is oblivious.
    /// The longer array is the more honest encoding, and it round-trips to
    /// "nullable container of platform elements" rather than to "nullable
    /// container of nullable elements".
    @Fact
    func Adr0186_TheSameReaders_Under_ThePlatformTypesDefault() {
        using let nullabilityScope = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
        using let fixture = ObliviousFixture()
        let obliviousReturn = ClrNullability.GetReturnTypeSymbol(ObliviousMethod(fixture, "GetString"))
        Assert.Same(TypeSymbol.String, Assert.IsType[PlatformTypeSymbol](obliviousReturn).UnderlyingType)
        let obliviousList = ClrNullability.GetReturnTypeSymbol(ObliviousMethod(fixture, "GetList"))
        Assert.IsType[PlatformTypeSymbol](obliviousList)
        Assert.Same(
            TypeSymbol.String,
            Assert.IsType[PlatformTypeSymbol](
                ClrNullability.SymbolFromFlagsOffset(typeof(string), ImmutableArray[uint8].Empty, 0)
            )
                .UnderlyingType
        )
        let platformArray = Assert.IsType[PlatformTypeSymbol](
            ClrNullability.SymbolFromFlagsOffset(typeof([]string), ImmutableArray[uint8].Empty, 0)
        )
        let annotatedArray = Assert.IsType[NullabilityAnnotatedTypeSymbol](platformArray.UnderlyingType)
        Assert.Same(
            TypeSymbol.String,
            Assert.IsType[PlatformTypeSymbol](annotatedArray.GetTypeArgumentSymbolForClrType(typeof(string)))
                .UnderlyingType
        )
        // An EXPLICIT scalar `2` still means nullable in either mode — the
        // negative control that keeps this a change to the absent reading
        // only.
        Assert.IsType[NullableTypeSymbol](
            ClrNullability.SymbolFromFlagsOffset(typeof(string), ImmutableArray.Create[uint8](uint8(2)), 0)
        )
        let reemitted = NullableFlagsBuilder.Build(
            NullableTypeSymbol.Get(
                NullabilityAnnotatedTypeSymbol(
                    TypeSymbol.FromClrType(typeof(List[string])),
                    ImmutableArray[uint8].Empty
                )
            )
        )
        Assert.Equal([]uint8{2, 0}, reemitted.ToArray())
    }

    @Fact
    func Oblivious_Reference_NoAnnotation_SurfacesAsNullable() {
        // ADR-0186 step 3 scoped this to `enabled` explicitly. It asserts
        // ADR-0136's reading of an OBLIVIOUS position, and that is no longer
        // the default — relying on an ambient default to assert what a
        // non-default mode does was the weaker form of the test anyway. The
        // platform-types answer for these same five readers is asserted
        // together in `Adr0186_TheSameReaders_Under_ThePlatformTypesDefault`.
        using let nullabilityScope = NullabilityOptions.Enter(NullabilityMode.Enabled)
        // Issue #1354: a genuinely oblivious (pre-nullable, `#nullable disable`)
        // imported reference type carries no [Nullable]/[NullableContext] anywhere.
        // Post-#1354 the Kotlin "unannotated/platform type is nullable" rule makes
        // the binder surface it as NullableTypeSymbol (was: flat non-null pre-#1354).
        using let fixture = ObliviousFixture()
        let sym = ClrNullability.GetReturnTypeSymbol(ObliviousMethod(fixture, "GetString"))
        let nullable = Assert.IsType[NullableTypeSymbol](sym)
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType)
    }

    @Fact
    func Oblivious_List_NoInnerFlags_SurfacesAsNullable() {
        // ADR-0186 step 3 scoped this to `enabled` explicitly. It asserts
        // ADR-0136's reading of an OBLIVIOUS position, and that is no longer
        // the default — relying on an ambient default to assert what a
        // non-default mode does was the weaker form of the test anyway. The
        // platform-types answer for these same five readers is asserted
        // together in `Adr0186_TheSameReaders_Under_ThePlatformTypesDefault`.
        using let nullabilityScope = NullabilityOptions.Enter(NullabilityMode.Enabled)
        // A method with no nullable annotation and no NullableContext at all.
        // Post-#1354 the outer List<string> reference position is nullable.
        // There are no inner per-position bytes, so the symbol is a plain
        // NullableTypeSymbol (not a NullabilityAnnotatedTypeSymbol).
        using let fixture = ObliviousFixture()
        let sym = ClrNullability.GetReturnTypeSymbol(ObliviousMethod(fixture, "GetList"))
        Assert.IsNotType[NullabilityAnnotatedTypeSymbol](sym)
        Assert.IsType[NullableTypeSymbol](sym)
    }

    // -----------------------------------------------------------------------
    // Issue #1354: direct exercise of the import reading rule + scalar/context
    // expansion via SymbolFromFlagsOffset / IsPositionNonNull.
    // -----------------------------------------------------------------------
    @Fact
    func IsPositionNonNull_EmptyFlags_IsNullable() {
        // No annotation and no context anywhere → nullable by default.
        Assert.False(ClrNullability.IsPositionNonNull(ImmutableArray[uint8].Empty, 0))
        Assert.False(ClrNullability.IsPositionNonNull(ImmutableArray[uint8].Empty, 3))
    }

    @Fact
    func IsPositionNonNull_Scalar1_AppliesNonNullToEveryPosition() {
        // A single context/scalar byte of 1 (NotAnnotated) makes ALL positions non-null.
        let flags = ImmutableArray.Create[uint8](uint8(1))
        Assert.True(ClrNullability.IsPositionNonNull(flags, 0))
        Assert.True(ClrNullability.IsPositionNonNull(flags, 1))
        Assert.True(ClrNullability.IsPositionNonNull(flags, 5))
    }

    @Fact
    func IsPositionNonNull_Scalar2_AppliesNullableToEveryPosition() {
        // A single scalar byte of 2 (Annotated) makes ALL positions nullable.
        let flags = ImmutableArray.Create[uint8](uint8(2))
        Assert.False(ClrNullability.IsPositionNonNull(flags, 0))
        Assert.False(ClrNullability.IsPositionNonNull(flags, 2))
    }

    @Fact
    func IsPositionNonNull_PerPosition_OnlyExplicitOneIsNonNull() {
        // Per-position array: non-null iff that exact byte is 1.
        let flags = ImmutableArray.Create[uint8](uint8(1), uint8(2), uint8(0))
        Assert.True(ClrNullability.IsPositionNonNull(flags, 0)) // 1 → non-null
        Assert.False(ClrNullability.IsPositionNonNull(flags, 1)) // 2 → nullable
        Assert.False(ClrNullability.IsPositionNonNull(flags, 2)) // 0 oblivious → nullable
        Assert.False(ClrNullability.IsPositionNonNull(flags, 9)) // beyond length → nullable

    }

    @Fact
    func SymbolFromFlagsOffset_Scalar1_NonNullAtEveryOffset() {
        // A 1-element [Nullable(1)] / [NullableContext(1)] applies to every
        // position: a reference type at ANY offset reads as non-null.
        let flags = ImmutableArray.Create[uint8](uint8(1))
        let sym0 = ClrNullability.SymbolFromFlagsOffset(typeof(string), flags, 0)
        let sym3 = ClrNullability.SymbolFromFlagsOffset(typeof(string), flags, 3)
        Assert.Same(TypeSymbol.String, sym0)
        Assert.IsNotType[NullableTypeSymbol](sym0)
        Assert.Same(TypeSymbol.String, sym3)
        Assert.IsNotType[NullableTypeSymbol](sym3)
    }

    @Fact
    func SymbolFromFlagsOffset_Scalar2_NullableAtEveryOffset() {
        // A 1-element [Nullable(2)] applies to every position: a reference type
        // at ANY offset reads as nullable.
        let flags = ImmutableArray.Create[uint8](uint8(2))
        let sym0 = ClrNullability.SymbolFromFlagsOffset(typeof(string), flags, 0)
        let sym5 = ClrNullability.SymbolFromFlagsOffset(typeof(string), flags, 5)
        Assert.IsType[NullableTypeSymbol](sym0)
        Assert.IsType[NullableTypeSymbol](sym5)
    }

    @Fact
    func SymbolFromFlagsOffset_Scalar1_OverGeneric_OuterNonNull() {
        // [Nullable(1)] over List<string>: the outer List is non-null (and inner
        // positions default to non-null via the per-offset scalar rule).
        let flags = ImmutableArray.Create[uint8](uint8(1))
        let sym = ClrNullability.SymbolFromFlagsOffset(typeof(List[string]), flags, 0)
        Assert.IsNotType[NullableTypeSymbol](sym)
        Assert.Equal(typeof(List[string]), sym.ClrType)
    }

    @Fact
    func SymbolFromFlagsOffset_Scalar2_OverGeneric_OuterNullable() {
        // [Nullable(2)] over List<string>: the outer List is nullable.
        let flags = ImmutableArray.Create[uint8](uint8(2))
        let sym = ClrNullability.SymbolFromFlagsOffset(typeof(List[string]), flags, 0)
        let nullable = Assert.IsType[NullableTypeSymbol](sym)
        Assert.Equal(typeof(List[string]), nullable.UnderlyingType.ClrType)
    }

    @Fact
    func SymbolFromFlagsOffset_EmptyFlags_RefType_IsNullable() {
        // ADR-0186 step 3 scoped this to `enabled` explicitly. It asserts
        // ADR-0136's reading of an OBLIVIOUS position, and that is no longer
        // the default — relying on an ambient default to assert what a
        // non-default mode does was the weaker form of the test anyway. The
        // platform-types answer for these same five readers is asserted
        // together in `Adr0186_TheSameReaders_Under_ThePlatformTypesDefault`.
        using let nullabilityScope = NullabilityOptions.Enter(NullabilityMode.Enabled)
        let sym = ClrNullability.SymbolFromFlagsOffset(typeof(string), ImmutableArray[uint8].Empty, 0)
        let nullable = Assert.IsType[NullableTypeSymbol](sym)
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType)
    }

    @Theory
    @InlineData(nil)
    @InlineData(uint8(2))
    func SzArray_NullableScalarOrAbsentFlags_PropagateToElement(scalar uint8?) {
        // ADR-0186 step 3 scoped this to `enabled` explicitly. It asserts
        // ADR-0136's reading of an OBLIVIOUS position, and that is no longer
        // the default — relying on an ambient default to assert what a
        // non-default mode does was the weaker form of the test anyway. The
        // platform-types answer for these same five readers is asserted
        // together in `Adr0186_TheSameReaders_Under_ThePlatformTypesDefault`.
        using let nullabilityScope = NullabilityOptions.Enter(NullabilityMode.Enabled)
        let flags = if (scalar != nil) {
            ImmutableArray.Create(scalar)
        } else {
            ImmutableArray[uint8].Empty
        }
        let symbol = Assert.IsType[NullableTypeSymbol](ClrNullability.SymbolFromFlagsOffset(typeof([]string), flags, 0))
        let array = Assert.IsType[NullabilityAnnotatedTypeSymbol](symbol.UnderlyingType)
        let element = Assert.IsType[NullableTypeSymbol](array.GetTypeArgumentSymbolForClrType(typeof(string)))
        Assert.Same(TypeSymbol.String, element.UnderlyingType)
    }

    @Fact
    func GenericValueTypePlaceholder_KeepsFollowingSiblingNonNull() {
        let flags = ImmutableArray.Create[uint8](uint8(1), uint8(0), uint8(2), uint8(1))
        let dictionary = Assert.IsType[NullabilityAnnotatedTypeSymbol](
            ClrNullability.SymbolFromFlagsOffset(typeof(Dictionary[ValueTuple[string], object]), flags, 0)
        )
        let tuple = Assert.IsType[NullabilityAnnotatedTypeSymbol](dictionary.GetTypeArgumentSymbol(0))
        let nullableItem = Assert.IsType[NullableTypeSymbol](tuple.GetTypeArgumentSymbol(0))
        Assert.Same(TypeSymbol.String, nullableItem.UnderlyingType)
        Assert.Same(TypeSymbol.Object, dictionary.GetTypeArgumentSymbol(1))
        Assert.Equal(flags.ToArray(), NullableFlagsBuilder.Build(dictionary).ToArray())
    }

    @Fact
    func NullableOuterAnnotatedArrayAndGeneric_ReemitInnerFlags() {
        let ReemitNullableOuter = func (clrType Type, flags ImmutableArray[uint8]) ImmutableArray[uint8] {
            let annotated = NullabilityAnnotatedTypeSymbol(TypeSymbol.FromClrType(clrType), flags)
            return NullableFlagsBuilder.Build(NullableTypeSymbol.Get(annotated))
        }
        // ADR-0186 step 3 scoped this to `enabled` explicitly. It asserts
        // ADR-0136's reading of an OBLIVIOUS position, and that is no longer
        // the default — relying on an ambient default to assert what a
        // non-default mode does was the weaker form of the test anyway. The
        // platform-types answer for these same five readers is asserted
        // together in `Adr0186_TheSameReaders_Under_ThePlatformTypesDefault`.
        using let nullabilityScope = NullabilityOptions.Enter(NullabilityMode.Enabled)
        Assert.Equal(
            []uint8{2, 1},
            ReemitNullableOuter(typeof([]string), ImmutableArray.Create[uint8](uint8(1), uint8(1))).ToArray()
        )
        Assert.Equal(
            []uint8{2, 1},
            ReemitNullableOuter(typeof(List[string]), ImmutableArray.Create[uint8](uint8(1), uint8(1))).ToArray()
        )
        Assert.Equal(
            []uint8{2},
            ReemitNullableOuter(typeof([]string), ImmutableArray.Create[uint8](uint8(2))).ToArray()
        )
        Assert.Equal([]uint8{2}, ReemitNullableOuter(typeof(List[string]), ImmutableArray[uint8].Empty).ToArray())
        Assert.Equal(
            []uint8{2, 0, 2, 2},
            ReemitNullableOuter(
                typeof(Dictionary[ValueTuple[string], object]),
                ImmutableArray.Create[uint8](uint8(2))
            ).ToArray()
        )
    }

    @Fact
    func NestedScalarAnnotatedGeneric_ExpandsBeforeFollowingTupleElement() {
        let annotatedList = NullabilityAnnotatedTypeSymbol(
            TypeSymbol.FromClrType(typeof(List[string])),
            ImmutableArray.Create[uint8](uint8(2))
        )
        let tuple = TupleTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](NullableTypeSymbol.Get(annotatedList), TypeSymbol.String)
        )
        let expected = []uint8{0, 2, 2, 1}
        Assert.Equal(expected, NullableFlagsBuilder.Build(tuple).ToArray())
        let decoded = Assert.IsType[TupleTypeSymbol](
            ClrNullability.SymbolFromFlagsOffset(typeof((List[string], string)), expected.ToImmutableArray(), 0)
        )
        let nullableList = Assert.IsType[NullableTypeSymbol](decoded.ElementTypes[0])
        let decodedList = Assert.IsType[NullabilityAnnotatedTypeSymbol](nullableList.UnderlyingType)
        let nullableItem = Assert.IsType[NullableTypeSymbol](decodedList.GetTypeArgumentSymbol(0))
        Assert.Same(TypeSymbol.String, nullableItem.UnderlyingType)
        Assert.Same(TypeSymbol.String, decoded.ElementTypes[1])
    }

    @Fact
    func FlattenedLongTuples_EmitEveryPhysicalRestPlaceholder() {
        let AssertTuple = func (arity int32, expected[]uint8) {
            let elements = Enumerable
                .Range(0, arity)
                .Select(
                (index int32) -> if index == 0 || index == 7 || index == arity - 1 {
                    cast[TypeSymbol](NullableTypeSymbol.Get(TypeSymbol.String))
                } else {
                    TypeSymbol.String
                }
            )
                .ToImmutableArray()
            let tuple = TupleTypeSymbol.Get(elements)
            let clrType = Assert.IsAssignableFrom[Type](
                TupleTypeSymbol.BuildClrType(Enumerable.Repeat(typeof(string), arity).ToArray())
            )
            Assert.Equal(expected.Length, ClrNullability.CountNullabilityBytes(clrType))
            Assert.Equal(expected, NullableFlagsBuilder.Build(tuple).ToArray())
            let decoded = Assert.IsType[TupleTypeSymbol](
                ClrNullability.SymbolFromFlagsOffset(clrType, expected.ToImmutableArray(), 0)
            )
            Assert.IsType[NullableTypeSymbol](decoded.ElementTypes[0])
            Assert.IsType[NullableTypeSymbol](decoded.ElementTypes[7])
            Assert.IsType[NullableTypeSymbol](decoded.ElementTypes[^1])
            Assert.Same(TypeSymbol.String, decoded.ElementTypes[1])
            Assert.Same(TypeSymbol.String, decoded.ElementTypes[^2])
            Assert.False(Conversion.Classify(TypeSymbol.Null, decoded.ElementTypes[1]).Exists)
            Assert.False(Conversion.Classify(TypeSymbol.Null, decoded.ElementTypes[^2]).Exists)
        }
        AssertTuple(8, []uint8{0, 2, 1, 1, 1, 1, 1, 1, 0, 2})
        AssertTuple(15, []uint8{0, 2, 1, 1, 1, 1, 1, 1, 0, 2, 1, 1, 1, 1, 1, 1, 0, 2})
    }

    @Fact
    func GetPropertyElementTypeSymbol_AnnotatedNullableProperty_IsNullable() {
        // Issue #1701 crack 1: a ref-returning indexer element must keep the
        // declaring property's `[NullableAttribute]` metadata instead of
        // erasing via a raw `TypeSymbol.FromClrType`.
        let prop = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetProperty("AnnotatedProperty")
        let sym = ClrNullability.GetPropertyElementTypeSymbol(prop!!, typeof(string))
        let nullable = Assert.IsType[NullableTypeSymbol](sym)
        Assert.Same(TypeSymbol.String, nullable.UnderlyingType)
    }

    @Fact
    func GetPropertyElementTypeSymbol_NonNullProperty_StaysFlat() {
        let prop = NativeMetadataFixtures.GetType("GSharp.Core.Tests.CodeAnalysis.Symbols.ClrNullabilityTests+Sample")
            .GetProperty("NonNullProperty")
        let sym = ClrNullability.GetPropertyElementTypeSymbol(prop!!, typeof(string))
        Assert.Same(TypeSymbol.String, sym)
    }

    shared {
        private func AssertStringNullability(type TypeSymbol, expectedNullable bool) {
            if expectedNullable {
                Assert.Same(TypeSymbol.String, Assert.IsType[NullableTypeSymbol](type).UnderlyingType)
            } else {
                Assert.Same(TypeSymbol.String, type)
            }
        }

        /// Compiles a pre-nullable-annotation (oblivious) type,
        /// `ObliviousContainer`, with csc.
        ///
        /// Genuinely oblivious: the `#nullable disable` source makes the C#
        /// compiler emit NO `NullableContextAttribute` /
        /// `NullableAttribute` on these members or their type, so the
        /// metadata importer finds no nullability information at all (issue
        /// #1354). The fixture is compiled at test time on purpose rather than
        /// declared in this file: an in-assembly `#nullable disable` class
        /// stops being oblivious when `test/Core.Tests` is itself
        /// self-migrated to G# — cs2gs spells its members `T?`, and even an
        /// `@Oblivious` G# declaration is emitted with explicit `0`
        /// bytes, not with no metadata (ADR-0186 §8) — so the absent-metadata
        /// reader these tests pin would silently stop being exercised, and the
        /// platform-types assertions would fail the migrated suite's test parity.
        /// @returns The compiled fixture; the caller disposes it.
        private func ObliviousFixture() CSharpFixture -> CSharpFixture(`#nullable disable
using System.Collections.Generic;

public class ObliviousContainer
{
    public List<string> GetList() => null;

    public string GetString() => null;
}`)

        /// Loads [`fixture`](paramref) and returns one of `ObliviousContainer`'s methods.
        /// @param fixture A fixture made by (cref:ObliviousFixture).
        /// @param methodName The method to return: `GetList` or `GetString`.
        /// @returns The oblivious method.
        private func ObliviousMethod(fixture CSharpFixture, methodName string) MethodInfo {
            // throwOnError guarantees the fixture type is returned or the lookup
            // throws, and the fixture source declares both methods.
            let method = fixture.Load().GetType("ObliviousContainer", throwOnError: true)!!.GetMethod(methodName)
            Assert.NotNull(method)
            return method!!
        }
    }
}
