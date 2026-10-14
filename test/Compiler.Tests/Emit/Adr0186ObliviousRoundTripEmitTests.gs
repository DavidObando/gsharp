// <copyright file="Adr0186ObliviousRoundTripEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler.Tests
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GscProgram = GSharp.Compiler.Program
import Gsharp.Concurrency
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// ADR-0186 §8, step 5: the metadata round-trip becomes three-valued and
/// total — <b>non-null stays non-null, nullable stays nullable, oblivious
/// stays oblivious</b>. Under ADR-0136 the third case was not expressible:
/// there was no way to declare a G# position oblivious, so nothing could be
/// emitted as one.
///
/// Each case compiles G# through the real command line, re-reads the emitted
/// assembly through the same (cref:MetadataLoadContext) path
/// (cref:ClrNullability) uses at bind time, and asserts the type each
/// position re-imports as. (cref:Issue1354NullabilityRoundTripEmitTests)
/// keeps pinning the two values ADR-0136 already guaranteed; the cases here
/// put all three side by side in one type, so a regression that moved an
/// oblivious position onto either neighbour — or either neighbour onto it —
/// is caught in the same assertion.
///
/// <b>Emit shape.</b> §8 allows two: emit nothing (csc's shape for a wholly
/// `#nullable disable` type), or explicit byte `0`. gsc emits the
/// explicit byte, and must: it stamps `[NullableContext(1)]` on every type
/// it emits, so "nothing" on a member inside such a type would read back
/// through the context walk as <em>non-null</em> — the laundering ADR-0186
/// exists to end. Explicit `0` inside a `[NullableContext(1)]` type is
/// also how csc writes a `#nullable disable` member of a type whose other
/// members are enabled (csc picks each type's context byte by majority, so its
/// exact rows vary with the member mix); what both compilers' metadata
/// <em>says</em> is compared against Roslyn's actual output by
/// (cref:Csc_And_Gsc_Agree_On_Every_Top_Level_Oblivious_Position).
open class Adr0186ObliviousRoundTripEmitTests {
    /// The three values, side by side in one enabled type, on fields and
    /// properties.
    @Fact
    func Fields_And_Properties_Round_Trip_All_Three_Values() {
        WithCompiledType(
            MixedSource,
            "Probe.Holder",
            Array.Empty[string](),
            (holder Type) -> {
                Assert.Same(TypeSymbol.String, ClrNullability.GetFieldTypeSymbol(holder.GetField("NonNullField")!!))
                AssertNullableString(ClrNullability.GetFieldTypeSymbol(holder.GetField("MaybeField")!!))
                AssertPlatformString(ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousField")!!))
                Assert.Same(
                    TypeSymbol.String,
                    ClrNullability.GetPropertyTypeSymbol(holder.GetProperty("NonNullProp")!!)
                )
                AssertNullableString(ClrNullability.GetPropertyTypeSymbol(holder.GetProperty("MaybeProp")!!))
                AssertPlatformString(ClrNullability.GetPropertyTypeSymbol(holder.GetProperty("ObliviousProp")!!))
            }
        )
    }

    /// Nested positions round-trip as written. An oblivious scope makes only
    /// the top level of a slot's type platform (the owner's 2026-09-25
    /// amendment to open question 12), so an oblivious `List[string]` is
    /// `List[string]!` on the way out and on the way back, and a stated
    /// `?` inside it survives as `T?`.
    @Fact
    func Nested_Positions_Round_Trip() {
        WithCompiledType(
            MixedSource,
            "Probe.Holder",
            Array.Empty[string](),
            (holder Type) -> {
                let list = Assert.IsType[PlatformTypeSymbol](
                    ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousList")!!)
                )
                Assert.Same(TypeSymbol.String, TypeArgumentAt(list.UnderlyingType, 0))
                let stated = Assert.IsType[PlatformTypeSymbol](
                    ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousStatedElements")!!)
                )
                AssertNullableString(TypeArgumentAt(stated.UnderlyingType, 0))
            }
        )
    }

    /// G#'s own structural types round-trip their nested positions too
    /// (found in review, PR #4357): a `map[string?, string]` used to be
    /// written from its erased CLR shape, so its flags said `1,1,1` —
    /// losing the stated `?` even in an enabled declaration, and unable
    /// to say `0` for an oblivious one's top level. The value is nested,
    /// so in an oblivious declaration it is what it spells.
    @Fact
    func Map_Positions_Round_Trip() {
        WithCompiledType(
            MixedSource,
            "Probe.Holder",
            Array.Empty[string](),
            (holder Type) -> {
                let oblivious = Assert.IsType[PlatformTypeSymbol](
                    ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousMap")!!)
                )
                AssertNullableString(TypeArgumentAt(oblivious.UnderlyingType, 0))
                Assert.Same(TypeSymbol.String, TypeArgumentAt(oblivious.UnderlyingType, 1))
                let enabled = ClrNullability.GetFieldTypeSymbol(holder.GetField("EnabledMap")!!)
                Assert.IsNotType[PlatformTypeSymbol](enabled)
                AssertNullableString(TypeArgumentAt(enabled, 0))
                Assert.Same(TypeSymbol.String, TypeArgumentAt(enabled, 1))
            }
        )
    }

    /// The other G# structural shapes an oblivious scope now reaches, each
    /// mixing a stated `?` with a platform top level: a
    /// `sequence[List[string]?]` (element stated nullable, its own
    /// argument as written) and a constructed source delegate
    /// `Mapper[string?]`. Before the flags builder walked their symbolic
    /// arguments, both were written from the erased CLR shape.
    @Fact
    func Sequence_And_Source_Delegate_Positions_Round_Trip() {
        WithCompiledType(
            MixedSource,
            "Probe.Holder",
            Array.Empty[string](),
            (holder Type) -> {
                let sequence_ = Assert.IsType[PlatformTypeSymbol](
                    ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousSequence")!!)
                )
                let element = Assert.IsType[NullableTypeSymbol](TypeArgumentAt(sequence_.UnderlyingType, 0))
                Assert.Same(TypeSymbol.String, TypeArgumentAt(element.UnderlyingType, 0))
                let mapper = Assert.IsType[PlatformTypeSymbol](
                    ClrNullability.GetFieldTypeSymbol(holder.GetField("ObliviousMapper")!!)
                )
                AssertNullableString(TypeArgumentAt(mapper.UnderlyingType, 0))
            }
        )
    }

    /// Issue #4287: an async function's emitted return is `Task<T>`,
    /// not its declared `T`, and it must re-import as a non-null task even
    /// when its METHOD context byte is 2.
    ///
    /// gsc used to write no `[Nullable]` for an async return at all, on
    /// the reasoning that a non-null task matches the assembly default. The
    /// method-level `[NullableContext]` is chosen by majority across the
    /// return and parameters, though, so nilable parameters in the majority made it 2, and
    /// the task then read back as `Task[T]?`. That was invisible until gsc
    /// started rejecting calls on a stated `T?` receiver: Oahu's
    /// `await service.RunAsync(opts, ct).ConfigureAwait(false)` across a
    /// G# assembly boundary reported GS0159.
    ///
    /// The `Maybe` row pins the awaited result's own position too: a
    /// `Rep?` result stays nullable INSIDE a non-null task.
    @Fact
    func Async_Returns_Round_Trip_As_NonNull_Tasks_Under_A_Nilable_Method_Context() {
        const source = `package Probe
import System.Collections.Generic
import System.Threading.Tasks

class Rep {
    var N int32
}

class Opts {
    var Skip bool
}

class Service {
    async func RunAsync(options Opts? = nil, name string? = nil, tag string? = nil) Rep {
        await Task.Yield()
        return Rep()
    }

    async func Maybe(options Opts?, name string?, tag string?) Rep? {
        await Task.Yield()
        return nil
    }

    async func Values(options Opts?, name string?, tag string?) ValueTask[Rep] {
        await Task.Yield()
        return Rep()
    }

    async func NestedValues(options Opts?, name string?, tag string?) ValueTask[List[string?]] {
        await Task.Yield()
        return List[string?]()
    }

    async func NestedTask(options Opts?, name string?, tag string?) Task[Task[string?]] {
        await Task.Yield()
        return Task.FromResult[string?](nil)
    }
}`
        WithCompiledType(
            source,
            "Probe.Service",
            Array.Empty[string](),
            (service Type) -> {
                for name in[]string{"RunAsync", "Values"} {
                    let method = service.GetMethod(name)!!
                    // The discriminating precondition: the parameters really do
                    // force a nilable method context, or this pins nothing.
                    Assert.Equal(uint8(2), ContextByte(method.GetCustomAttributesData()))
                    let task = ClrNullability.GetReturnTypeSymbol(method)
                    Assert.IsNotType[NullableTypeSymbol](task)
                    Assert.IsNotType[NullableTypeSymbol](FirstTypeArgument(task))
                }
                let maybe = ClrNullability.GetReturnTypeSymbol(service.GetMethod("Maybe")!!)
                Assert.IsNotType[NullableTypeSymbol](maybe)
                Assert.IsType[NullableTypeSymbol](FirstTypeArgument(maybe))
                // A generic VALUE task keeps its leading placeholder slot, so the
                // nested positions line up: without it the `?` lands on the list
                // (`ValueTask[List[string]?]`) instead of its element.
                let nested = ClrNullability.GetReturnTypeSymbol(service.GetMethod("NestedValues")!!)
                let list = FirstTypeArgument(nested)
                Assert.IsNotType[NullableTypeSymbol](list)
                AssertNullableString(FirstTypeArgument(list))
                // A declared `Task[Task[string?]]` awaits a real `Task[string?]`:
                // `function.Type` is already that awaited result, so it must not be
                // unwrapped a second time, or the inner task reads back nilable and
                // its `string?` flag shifts off the end.
                let nestedTask = ClrNullability.GetReturnTypeSymbol(service.GetMethod("NestedTask")!!)
                Assert.IsNotType[NullableTypeSymbol](nestedTask)
                let innerTask = FirstTypeArgument(nestedTask)
                Assert.IsNotType[NullableTypeSymbol](innerTask)
                AssertNullableString(FirstTypeArgument(innerTask))
            }
        )
    }

    /// Issue #4465: nullable metadata describes the physical async envelope,
    /// with the logical result nested beneath it. An oblivious declaration
    /// makes a reference-type `Task` envelope platform without erasing a
    /// stated nullable result; suspending functions use the corresponding
    /// `ValueTask` layout.
    @Fact
    func Async_And_Suspending_Returns_Round_Trip_Their_Physical_Envelope() {
        const source = `package Probe
import System.ComponentModel
import System.Threading.Tasks

class Service {
    async func Maybe() string? {
        await Task.Yield()
        return nil
    }

    @Oblivious async func ObliviousMaybe() string? {
        await Task.Yield()
        return nil
    }

    async func Text() string {
        await Task.Yield()
        return ""
    }

    async func Number() int32 {
        await Task.Yield()
        return 1
    }

    async func Done() {
        await Task.Yield()
    }

    @return:Description("async return")
    async func Named() (Label string?, Count int32) {
        await Task.Yield()
        return (nil, 1)
    }

    suspend func SuspendedMaybe() string? {
        await Task.Yield()
        return nil
    }

    @Oblivious suspend func ObliviousSuspendedMaybe() string? {
        await Task.Yield()
        return nil
    }
}`
        WithCompiledType(
            source,
            "Probe.Service",
            Array.Empty[string](),
            (service Type) -> {
                let maybeMethod = service.GetMethod("Maybe")!!
                let maybe = ClrNullability.GetReturnTypeSymbol(maybeMethod)
                Assert.IsNotType[PlatformTypeSymbol](maybe)
                AssertNullableString(FirstTypeArgument(maybe))
                Assert.Equal([]uint8{1, 2}, NullableBytes(maybeMethod.ReturnParameter.GetCustomAttributesData()))
                let obliviousMaybeMethod = service.GetMethod("ObliviousMaybe")!!
                let obliviousMaybe = Assert.IsType[PlatformTypeSymbol](
                    ClrNullability.GetReturnTypeSymbol(obliviousMaybeMethod)
                )
                AssertNullableString(FirstTypeArgument(obliviousMaybe.UnderlyingType))
                Assert.Equal(
                    []uint8{0, 2},
                    NullableBytes(obliviousMaybeMethod.ReturnParameter.GetCustomAttributesData())
                )
                let textMethod = service.GetMethod("Text")!!
                let text = ClrNullability.GetReturnTypeSymbol(textMethod)
                Assert.IsNotType[PlatformTypeSymbol](text)
                Assert.Same(TypeSymbol.String, FirstTypeArgument(text))
                Assert.Equal([]uint8{1, 1}, NullableBytes(textMethod.ReturnParameter.GetCustomAttributesData()))
                let numberMethod = service.GetMethod("Number")!!
                let number = ClrNullability.GetReturnTypeSymbol(numberMethod)
                Assert.Same(TypeSymbol.Int32, FirstTypeArgument(number))
                Assert.Null(NullableBytes(numberMethod.ReturnParameter.GetCustomAttributesData()))
                let doneMethod = service.GetMethod("Done")!!
                let done = ClrNullability.GetReturnTypeSymbol(doneMethod)
                Assert.Equal("System.Threading.Tasks.Task", done.ClrType?.FullName)
                Assert.Null(NullableBytes(doneMethod.ReturnParameter.GetCustomAttributesData()))
                let namedMethod = service.GetMethod("Named")!!
                let returnAttributes = namedMethod.ReturnParameter.GetCustomAttributesData()
                Assert.Contains(
                    returnAttributes,
                    (a CustomAttributeData) -> a.AttributeType.FullName == "System.ComponentModel.DescriptionAttribute"
                )
                Assert.Contains(
                    returnAttributes,
                    (a CustomAttributeData) -> a
                        .AttributeType
                        .FullName == "System.Runtime.CompilerServices.TupleElementNamesAttribute"
                )
                Assert.Equal([]uint8{1, 0, 2}, NullableBytes(returnAttributes))
                for name in[]string{"SuspendedMaybe", "ObliviousSuspendedMaybe"} {
                    let method = service.GetMethod(name)!!
                    let suspended = ClrNullability.GetReturnTypeSymbol(method)
                    Assert.Equal(
                        "System.Threading.Tasks.ValueTask`1",
                        suspended.ClrType?.GetGenericTypeDefinition().FullName
                    )
                    AssertNullableString(FirstTypeArgument(suspended))
                    Assert.Equal([]uint8{0, 2}, NullableBytes(method.ReturnParameter.GetCustomAttributesData()))
                }
            }
        )
    }

    /// Parameters and returns: a wholly oblivious method, and a method mixing
    /// all three values across its parameters (a parameter-level
    /// `@Oblivious`).
    @Fact
    func Parameters_And_Returns_Round_Trip_All_Three_Values() {
        WithCompiledType(
            MixedSource,
            "Probe.Holder",
            Array.Empty[string](),
            (holder Type) -> {
                let oblivious = holder.GetMethod("ObliviousMethod")!!
                AssertPlatformString(ClrNullability.GetParameterTypeSymbol(oblivious.GetParameters()[0]))
                AssertPlatformString(ClrNullability.GetReturnTypeSymbol(oblivious))
                let mixed = holder.GetMethod("MixedMethod")!!
                let parameters = mixed.GetParameters()
                AssertPlatformString(ClrNullability.GetParameterTypeSymbol(parameters[0]))
                AssertNullableString(ClrNullability.GetParameterTypeSymbol(parameters[1]))
                Assert.Same(TypeSymbol.String, ClrNullability.GetParameterTypeSymbol(parameters[2]))
                Assert.Same(TypeSymbol.String, ClrNullability.GetReturnTypeSymbol(mixed))
            }
        )
    }

    /// Events. The import side reads an event's handler nullability off the
    /// Event row (`MemberLookup.GetClrEventHandlerTypeSymbol`), which is
    /// where csc writes it; step 5 made gsc write it there too. Before that,
    /// every gsc event re-imported through the type-level
    /// `[NullableContext(1)]` as wholly non-null — so this pins both an
    /// oblivious handler and the enabled `Action[string?]` case the same
    /// gap had been flattening since ADR-0136.
    @Fact
    func Events_Round_Trip_Their_Handler_Nullability() {
        WithCompiledType(
            MixedSource,
            "Probe.Holder",
            Array.Empty[string](),
            (holder Type) -> {
                // The handler is the slot's top level, so it is platform; its type
                // argument is nested and reads as written.
                let oblivious = Assert.IsType[PlatformTypeSymbol](
                    MemberLookup.GetClrEventHandlerTypeSymbol(holder.GetEvent("ObliviousEvent")!!)
                )
                Assert.Same(TypeSymbol.String, FirstTypeArgument(oblivious.UnderlyingType))
                let maybe = MemberLookup.GetClrEventHandlerTypeSymbol(holder.GetEvent("MaybeArgsEvent")!!)
                Assert.IsNotType[PlatformTypeSymbol](maybe)
                AssertNullableString(FirstTypeArgument(maybe))
                let plain = MemberLookup.GetClrEventHandlerTypeSymbol(holder.GetEvent("PlainEvent")!!)
                Assert.IsNotType[PlatformTypeSymbol](plain)
                Assert.Same(TypeSymbol.String, FirstTypeArgument(plain))
            }
        )
    }

    /// The emit shape §8 sanctions: explicit oblivious bytes. The top level of
    /// an oblivious position is `0` — never `1`, which would launder
    /// "nobody said" into a non-null guarantee in metadata. A nested position
    /// states what it spells, so an oblivious `List[string]` is written
    /// `{0, 1}`. A method
    /// whose positions are all oblivious carries `[NullableContext(0)]`,
    /// exactly the attribute csc puts on a `#nullable disable` method of
    /// an enabled type.
    @Fact
    func Oblivious_Positions_Are_Emitted_As_Explicit_Zero_Bytes() {
        WithCompiledType(
            MixedSource,
            "Probe.Holder",
            Array.Empty[string](),
            (holder Type) -> {
                AssertAllZero(NullableBytes(holder.GetField("ObliviousField")!!.GetCustomAttributesData()))
                Assert.Equal([]uint8{0, 1}, NullableBytes(holder.GetField("ObliviousList")!!.GetCustomAttributesData()))
                AssertAllZero(NullableBytes(holder.GetProperty("ObliviousProp")!!.GetCustomAttributesData()))
                Assert.Equal(uint8(0), ContextByte(holder.GetMethod("ObliviousMethod")!!.GetCustomAttributesData()))
                // The enabled neighbours keep ADR-0136's shape byte for byte: no
                // per-position attribute on a non-null member (the type-level
                // `[NullableContext(1)]` covers it), `2` on a nullable one.
                Assert.Null(NullableBytes(holder.GetField("NonNullField")!!.GetCustomAttributesData()))
                Assert.Equal([]uint8{2}, NullableBytes(holder.GetField("MaybeField")!!.GetCustomAttributesData()))
                Assert.Equal(uint8(1), ContextByte(holder.GetCustomAttributesData()))
            }
        )
    }

    /// The compilation level: `--nullability=oblivious` with no annotation
    /// anywhere, and `@NullabilityEnabled` opting one declaration back
    /// out — declaration level wins, and it wins on the way back in too.
    @Fact
    func An_Oblivious_Compilation_Round_Trips_With_Its_Enabled_Exceptions() {
        const source = `package Probe

class Holder {
    var Field string
    var Maybe string?
    @NullabilityEnabled var Enabled string = ""
    func Method(p string) string { return p }
    @NullabilityEnabled func EnabledMethod(p string) string { return p }
}`
        WithCompiledType(
            source,
            "Probe.Holder",
            []string{"/nullability:oblivious"},
            (holder Type) -> {
                AssertPlatformString(ClrNullability.GetFieldTypeSymbol(holder.GetField("Field")!!))
                AssertNullableString(ClrNullability.GetFieldTypeSymbol(holder.GetField("Maybe")!!))
                Assert.Same(TypeSymbol.String, ClrNullability.GetFieldTypeSymbol(holder.GetField("Enabled")!!))
                let method = holder.GetMethod("Method")!!
                AssertPlatformString(ClrNullability.GetParameterTypeSymbol(method.GetParameters()[0]))
                AssertPlatformString(ClrNullability.GetReturnTypeSymbol(method))
                let enabled = holder.GetMethod("EnabledMethod")!!
                Assert.Same(TypeSymbol.String, ClrNullability.GetParameterTypeSymbol(enabled.GetParameters()[0]))
                Assert.Same(TypeSymbol.String, ClrNullability.GetReturnTypeSymbol(enabled))
            }
        )
    }

    /// §8's "validated against csc for free", made concrete. The same
    /// declarations are compiled by Roslyn with `#nullable disable`
    /// regions inside an enabled type and by gsc with `@Oblivious`, and
    /// every top-level position must re-import identically from both.
    ///
    /// Nested positions deliberately differ. csc writes a
    /// `#nullable disable` `List<string>` as `{0, 0}`
    /// (`List[string!]!`), while an oblivious G# `List[string]` is
    /// `List[string]!` (`{0, 1}`). That is the owner's 2026-09-25
    /// amendment to open question 12. G# states the element as written, which
    /// is what cs2gs output already said before the scope existed.
    @Fact
    func Csc_And_Gsc_Agree_On_Every_Top_Level_Oblivious_Position() {
        const csharp = `#nullable enable
namespace Probe
{
    public class Holder
    {
        public string NonNullField = "";
        public string? MaybeField;
#nullable disable
        public string ObliviousField;
        public System.Collections.Generic.List<string> ObliviousList;
        public string ObliviousProp { get; set; }
        public string ObliviousMethod(string p) => p;
#nullable enable
    }
}`
        const gsharp = `package Probe
import System.Collections.Generic

class Holder {
    var NonNullField string = ""
    var MaybeField string?
    @Oblivious var ObliviousField string
    @Oblivious var ObliviousList List[string]
    @Oblivious prop ObliviousProp string { get; set }
    @Oblivious func ObliviousMethod(p string) string { return p }
}`
        let tempDir = Directory.CreateTempSubdirectory("gs_adr0186_csc_").FullName
        try {
            let cscPath = CompileCSharp(tempDir, csharp)
            let gscPath = CompileGSharp(tempDir, gsharp, Array.Empty[string]())
            using let cscContext = LoadContext(cscPath)
            using let gscContext = LoadContext(gscPath)
            let csc = cscContext.LoadFromAssemblyPath(cscPath).GetType("Probe.Holder")!!
            let gsc = gscContext.LoadFromAssemblyPath(gscPath).GetType("Probe.Holder")!!
            for name in[]string{"NonNullField", "MaybeField", "ObliviousField"} {
                Assert.Equal(
                    ClrNullability.GetFieldTypeSymbol(csc.GetField(name)!!).ToString(),
                    ClrNullability.GetFieldTypeSymbol(gsc.GetField(name)!!).ToString()
                )
            }
            Assert.Equal(
                ClrNullability.GetPropertyTypeSymbol(csc.GetProperty("ObliviousProp")!!).ToString(),
                ClrNullability.GetPropertyTypeSymbol(gsc.GetProperty("ObliviousProp")!!).ToString()
            )
            let cscMethod = csc.GetMethod("ObliviousMethod")!!
            let gscMethod = gsc.GetMethod("ObliviousMethod")!!
            Assert.Equal(
                ClrNullability.GetParameterTypeSymbol(cscMethod.GetParameters()[0]).ToString(),
                ClrNullability.GetParameterTypeSymbol(gscMethod.GetParameters()[0]).ToString()
            )
            Assert.Equal(
                ClrNullability.GetReturnTypeSymbol(cscMethod).ToString(),
                ClrNullability.GetReturnTypeSymbol(gscMethod).ToString()
            )
            // And the agreement is on the oblivious answer, not merely on
            // some shared answer.
            AssertPlatformString(ClrNullability.GetFieldTypeSymbol(gsc.GetField("ObliviousField")!!))
            AssertPlatformString(ClrNullability.GetReturnTypeSymbol(gscMethod))
            // The one deliberate difference: the container's top level agrees
            // (platform), its element does not (see the summary).
            Assert.Equal(
                "System.Collections.Generic.List[string!]!",
                ClrNullability.GetFieldTypeSymbol(csc.GetField("ObliviousList")!!).ToString()
            )
            Assert.Equal(
                "System.Collections.Generic.List[string]!",
                ClrNullability.GetFieldTypeSymbol(gsc.GetField("ObliviousList")!!).ToString()
            )
            // gsc's own bytes for those positions are all `0`. csc's raw shape
            // is not compared byte for byte: it chooses each type's
            // `[NullableContext]` by majority over the members, so which
            // members carry an explicit attribute at all depends on the mix.
            // What both must agree on is what the metadata SAYS, asserted above.
            AssertAllZero(NullableBytes(gsc.GetField("ObliviousField")!!.GetCustomAttributesData()))
            Assert.Equal([]uint8{0, 1}, NullableBytes(gsc.GetField("ObliviousList")!!.GetCustomAttributesData()))
            Assert.Equal(uint8(0), ContextByte(gscMethod.GetCustomAttributesData()))
        } finally {
            TryDelete(tempDir)
        }
    }

    shared {
        private const MixedSource string = `package Probe
import System
import System.Collections.Generic

delegate Mapper[T](x T) T;

class Holder {
    var NonNullField string = ""
    var MaybeField string?
    @Oblivious var ObliviousSequence sequence[List[string]?]
    @Oblivious var ObliviousMapper Mapper[string?]
    @Oblivious var ObliviousField string
    @Oblivious var ObliviousList List[string]
    @Oblivious var ObliviousStatedElements List[string?]
    prop NonNullProp string { get; set }
    prop MaybeProp string? { get; set }
    @Oblivious prop ObliviousProp string { get; set }
    @Oblivious func ObliviousMethod(p string) string { return p }
    func MixedMethod(@Oblivious oblivious string, maybe string?, nonNull string) string { return nonNull }
    @Oblivious var ObliviousMap map[string?, string]
    var EnabledMap map[string?, string] = map[string?, string]{}
    @Oblivious event ObliviousEvent Action[string]
    event MaybeArgsEvent Action[string?]
    event PlainEvent Action[string]
}`

        private func FirstTypeArgument(type TypeSymbol) TypeSymbol -> TypeArgumentAt(type, 0)

        private func TypeArgumentAt(type TypeSymbol, index int32) TypeSymbol -> switch type {
            case annotated is NullabilityAnnotatedTypeSymbol: annotated.GetTypeArgumentSymbol(index)
            case ImportedTypeSymbol{
                TypeArguments: {Length: 0},
                ClrType: {IsGenericType: true, IsGenericTypeDefinition: false} clr
            }: TypeSymbol.FromClrType(clr.GetGenericArguments()[index])
            case imported is ImportedTypeSymbol: imported.TypeArguments[index]
            case map_ is MapTypeSymbol: if index == 0 {
                map_.KeyType
            } else {
                map_.ValueType
            }
            default: throw InvalidOperationException("'$type' (${type.GetType().Name}) carries no type arguments.")
        }

        private func AssertPlatformString(symbol TypeSymbol) {
            let platform = Assert.IsType[PlatformTypeSymbol](symbol)
            Assert.Same(TypeSymbol.String, platform.UnderlyingType)
        }

        private func AssertNullableString(symbol TypeSymbol) {
            let nullable = Assert.IsType[NullableTypeSymbol](symbol)
            Assert.Same(TypeSymbol.String, nullable.UnderlyingType)
        }

        private func AssertAllZero(bytes[]?uint8) {
            Assert.NotNull(bytes)
            Assert.NotEmpty(bytes!!)
            Assert.All(bytes!!, (b uint8) -> Assert.Equal(uint8(0), b))
        }

        private func NullableBytes(attributes IEnumerable[CustomAttributeData])[]?uint8 {
            let attribute CustomAttributeData? = attributes.FirstOrDefault(
                (a CustomAttributeData) -> a
                    .AttributeType
                    .FullName == "System.Runtime.CompilerServices.NullableAttribute"
            )
            if attribute == nil {
                return nil
            }
            let argument = attribute.ConstructorArguments[0]
            return if argument.Value is uint8 scalar {
                []uint8{scalar}
            } else {
                (cast[IEnumerable[CustomAttributeTypedArgument]](argument.Value!!)).Select(
                    (a CustomAttributeTypedArgument) -> uint8(a.Value!!)
                )
                    .ToArray()
            }
        }

        private func ContextByte(attributes IEnumerable[CustomAttributeData]) uint8? {
            let attribute CustomAttributeData? = attributes.FirstOrDefault(
                (a CustomAttributeData) -> a
                    .AttributeType
                    .FullName == "System.Runtime.CompilerServices.NullableContextAttribute"
            )
            return attribute?.ConstructorArguments[0].Value as uint8?
        }

        private func WithCompiledType(source string, typeName string, extraArguments[]string, assert(Type) -> void) {
            let tempDir = Directory.CreateTempSubdirectory("gs_adr0186_roundtrip_").FullName
            try {
                let dllPath = CompileGSharp(tempDir, source, extraArguments)
                using let context = LoadContext(dllPath)
                let type = context.LoadFromAssemblyPath(dllPath).GetType(typeName) ??
                    throw InvalidOperationException("$typeName not found in emitted assembly.")
                assert(type)
            } finally {
                TryDelete(tempDir)
            }
        }

        private func LoadContext(assemblyPath string) MetadataLoadContext {
            let runtimeDir = Path.GetDirectoryName(typeof(object).Assembly.Location)!!
            let resolver = PathAssemblyResolver(
                Directory.GetFiles(runtimeDir, "*.dll").Concat(
                    []string{assemblyPath, typeof(SuspendingAttribute).Assembly.Location}
                )
            )
            return MetadataLoadContext(resolver, "System.Private.CoreLib")
        }

        private func CompileGSharp(tempDir string, source string, extraArguments[]string) string {
            let srcPath = Path.Combine(tempDir, "probe.gs")
            let outPath = Path.Combine(tempDir, "probe.dll")
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/target:library", "/targetframework:net10.0"}
            args.AddRange(extraArguments)
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            var exit int32
            try {
                exit = GscProgram.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            Assert.True(exit == 0, (`gsc failed:
stdout:
` + "$compileOut" + `
stderr:
` + "$compileErr"))
            IlVerifier.Verify(outPath)
            return outPath
        }

        private func CompileCSharp(tempDir string, source string) string {
            let references = (cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)).Split(
                Path.PathSeparator
            )
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
            let compilation = CSharpCompilation.Create(
                "CscProbe",
                []SyntaxTree{CSharpSyntaxTree.ParseText(source)},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(tempDir, "CscProbe.dll")
            let result = compilation.Emit(path)
            Assert.True(
                result.Success,
                string.Join("\n", result.Diagnostics.Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            )
            return path
        }

        private func TryDelete(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) {
                // Best-effort cleanup.

            } catch (UnauthorizedAccessException) { }
        }
    }
}
