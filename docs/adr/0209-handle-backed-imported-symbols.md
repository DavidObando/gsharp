# ADR-0209: Handle-backed imported symbols without `MetadataLoadContext`

- **Status**: Accepted (maintainer, 2026-10-23)
- **Date**: 2026-10-22
- **Phase**: Compiler architecture (study roadmap item B4; design only, the
  implementation is #5144)
- **Issue**: [#5143](https://github.com/DavidObando/gsharp/issues/5143)
- **Related**: [#2189](https://github.com/DavidObando/gsharp/issues/2189);
  [#5144](https://github.com/DavidObando/gsharp/issues/5144) (implementation);
  [#5145](https://github.com/DavidObando/gsharp/issues/5145) (resolver reuse
  across worker requests); [#5158](https://github.com/DavidObando/gsharp/issues/5158)
  (interned constructions; deduplicated output accepted as the baseline);
  [#5157](https://github.com/DavidObando/gsharp/issues/5157) (remaining
  first-chance exceptions); [#5167](https://github.com/DavidObando/gsharp/issues/5167)
  (remaining items of #5124); PRs #5156, #5162, #5166 (the first layer);
  [the compiler architecture and performance study](../compiler-architecture-and-performance-study.md)
  (sections 4.6, 4.7, 5, P5 to P7, P9, 8, 10);
  [ADR-0027](0027-roslyn-fork-decision.md) (Roslyn-free compiler),
  [ADR-0107](0107-cross-session-cold-start-cache-language-server.md) (the
  persisted type-name index), [ADR-0186](0186-platform-types-for-oblivious-clr-interop.md)
  (platform types), [ADR-0193](0193-nullability-queries-are-type-level-and-funnelled.md)
  (the nullability funnel), [ADR-0199](0199-data-types-synthesize-the-csharp-record-abi.md)
  (the record ABI; its allowance test runs beside `CorePublicApiSnapshotTests`),
  [ADR-0203](0203-measured-compiler-throughput-and-bounded-parallelism.md)
  (the compiler worker), [ADR-0156](0156-gsi-emit-to-memory-execution.md) (the
  REPL executes emitted images).

## Context

### 1. What the compiler models today

Every imported entity is a `System.Type`, `MethodInfo`, `ConstructorInfo`,
`PropertyInfo`, `FieldInfo`, `EventInfo`, `ParameterInfo` or
`CustomAttributeData` object. `ReferenceResolver.WithReferences` reads every
reference and every host trusted-platform assembly into a `byte[]`
(`Symbols/ReferenceResolver.gs:1032-1046`, so that no file handle stays open,
#853) and loads them into one `MetadataLoadContext` (`:1415-1517`). The
`TypeSymbol` base class carries the object: `prop ClrType Type?`
(`Symbols/TypeSymbol.gs:29`), and `ImportedTypeSymbol` requires it
(`Symbols/ImportedTypeSymbol.gs:43-47`). From there the whole compiler asks
reflection its questions.

Counts over `src/Core` at `c3cce6b81` (script: `inventory.py`, see
References):
3,245 mentions of `Type` as a reflection type, 901 `MethodInfo`, 254
`PropertyInfo`, 166 `ParameterInfo`, 124 `FieldInfo`, 119 `ConstructorInfo`,
116 `MemberInfo`, 73 `EventInfo`, 289 `Assembly`, 39 `CustomAttributeData`,
232 `MetadataLoadContext`; 300 of the 705 `.gs` files mention at least one.
The three largest consumers are
`Binding/OverloadResolution/ClrOverloadResolution.gs` (886 mentions),
`Binding/MemberLookup.gs` (431) and `Binding/Binder.gs` (215); the emitter's
`Emit/ImportedMemberRefFactory.gs` has 102. 547 `.FullName` reads, 306
`GetGenericArguments`, 162 `MakeGenericType`, 59 `IsAssignableFrom`, 74
`MetadataToken` and 514 `catch` clauses sit in the same files.

The public API carries the model too: 283 lines of
`test/Core.Tests/Baselines/gsharp-core-public-api.txt` name `System.Type` or a
`System.Reflection` member (`TypeSymbol.ClrType` at line 479,
`TypeSymbol.FromClrType` at 460, `ImportedTypeSymbol.Type`/`OpenDefinition`,
`ImportedFunctionSymbol.Method`, every `Bound*Clr*` node,
`FunctionSymbol.ExternalOverriddenMethod`/`ExplicitInterfaceSlot`, and
`ReferenceResolver` in full, including `Dispose`). Analyzers receive the
`Compilation` and so the resolver; `tools/gsgen` reads `ClrType` at 22 sites
and the language server at 38.

Types declared in the compilation being built have no `System.Type`: their
`ClrType` is `nil` and the emitter encodes them symbolically. Where an imported
generic is closed over such a type, binding erases the argument to
`System.Object` and carries the real symbols beside the erased CLR shape
(`Symbols/ImportedTypeSymbol.gs:61-205`). No `TypeBuilder` is created for a
user type; the `TypeBuilderInstantiation` guards (54 mentions) exist because
the runtime manufactures that object whenever a host `RuntimeType` definition
is closed over a non-runtime argument (`typeof(Func<,>)` in
`FunctionTypeSymbol.gs:579-600`, `typeof(ValueTuple<,>)` in
`TupleTypeSymbol.gs:229-239`, `typeof(Dictionary<,>)` in `MapTypeSymbol.gs`),
and about 300 `typeof(` sites in `Emit/` rely on `MapClrTypeToReferences`
(`ReferenceResolver.gs:673-766`) or `TryProjectOntoReferences`
(`ImportedMemberRefFactory.gs:2061-2090`) to project a host type onto the
reference set by name.

### 2. The measured problem

From the study (section 4.6, 4.7) and the first-layer PRs:

- `System.Reflection.*` frames are on the stack in 16.8% of main-thread
  samples of a Core compile (about 4.4 s of 26.3 s); `Monitor.Enter` under
  `ImportedTypeSymbol.Get` (`ImportedTypeSymbol.gs:252`) is 1.9% on its own.
- 4,791 first-chance exceptions per Core compile were reflection probes that
  used a throw as the answer; #5156 cut them to 84 with pre-checks
  (`Symbols/ClrTypeUtilities.gs:296-306`); #5157 lists the rest
  (`IsAssignableFrom` on a `TypeBuilderInstantiation`, `GetBaseDefinition`,
  which `MetadataLoadContext` never answers, the transitive probe, the name
  index).
- Identity is a string: `TypeIdentityComparer` keys the emitter's `TypeRefs`
  and `TypeSpecs` by `AssemblyQualifiedName` (`Emit/TypeIdentityComparer.gs:72-83`,
  `Emit/MetadataTokenCache.gs:54-55`); `LoadContextSensitiveTypeComparer` adds
  an `Assembly`-instance walk (#3826); primitives are matched by `FullName`
  switch in five places (`TypeSymbol.gs:220-276`, `Emit/SignatureEncoder.gs:624-683`,
  ...), and about 187 further sites compare `FullName` strings.
- Member enumeration is eager: `MetadataLoadContext` builds a `RoMethod` and
  resolves its signature for every member on the first `GetMethods`, and
  `ClrTypeUtilities.SafeEnumerate` touches every signature type again to
  filter unloadable members (`ClrTypeUtilities.gs:384-415, 1231-1257`).
- The first layer moved counters, not wall time: #5162 cut
  `metadata.contract-requests` from 101,595 to 29,461 and allocation by 0.4%;
  #5166 cut `references.type-name-index` from 135 ms to 17 ms on hello world
  and from 189 ms to 12.5 ms on Core; Core wall time did not change measurably
  in either, and hello world's `declarations` phase is 195 ms, mostly first-use
  cost outside any named phase (#5167).

A probe over the 171 reference assemblies of `Gsharp.Extensions.rsp` (the
`net10.0` reference pack plus repository references; the hello-world closure
of the study has 173) separates the two costs (`closure-probe.cs`, see
References; medians of three runs):

| Step | Handle-level (`MetadataReader`) | `MetadataLoadContext` |
| --- | ---: | ---: |
| Read 171 images (5 MiB) into memory | 4.0 ms | same bytes |
| Open a reader per image, count rows | 3.6 ms, +0 MiB | load: 20.1 ms, +2 MiB |
| Names of all 4,292 type definitions | 0.9 ms | `GetTypes()`: 0.8 ms (4,121 types) |
| Decode every method and field signature (55,058 methods, 76,643 parameters, 8,318 fields; 232,151 type nodes) | 16.5 ms, +0 MiB | `GetMethods` + `ReturnType` + `ParameterType` + `GetFields` on every type: 417 ms, +144 MiB |
| Walk the type of every custom attribute (44,839; 26,197 are `Nullable`/`NullableContext`) | 4.9 ms | `GetCustomAttributesData` on every type: 4.8 ms (5,988 attributes) |

The closure also holds 6,539 `TypeRef`, 7,978 `MemberRef`, 1,366 `TypeSpec`,
7,032 `ExportedType` and 585 `AssemblyRef` rows. The handle-side heap figures
are a floor: the probe's provider returns an `int` per node, so a decoder that
builds `TypeSymbol`s pays for the symbols it creates; the time comparison
stands. The finding is that the cost is the API shape, not the library:
`MetadataLoadContext` is itself a reader over `System.Reflection.Metadata`,
but `System.Type`'s member API forces eager member and signature construction,
answers "not applicable" with an exception, and offers only strings as
identity.

### 3. What the first layer already delivered, and what it cannot

#5156 (probe guards), #5162 (signature cache keyed by the reflected member)
and #5166 (`MetadataTypeNameReader`, the first handle-level reader in Core) are
the study's first layer; #5158 prototyped interning of `GetConstructed`, found
it changes the emitted PE (138 fewer `MemberRef` and 154 fewer `TypeSpec` rows
on Core), the maintainer accepted that output as the baseline, and #5184
landed the interning on the `System.Type` model. What the
first layer cannot do while the model is `System.Type`: reference identity,
lazy member construction, no string identity or host-`typeof` projection, no
exception-as-answer probe, and a reference set that survives a worker request
without a `MetadataLoadContext` that every symbol points at.

### 4. Constraints

- **N-1.** Repository source uses only features the pinned release (0.5.212)
  compiles. Implementing `ISignatureTypeProvider[TType, TGenericContext]` is
  proven under the pin (`tools/cs2gs/Cs2Gs.Tests/Issue4777InheritedDataEqualityTranslationTests.gs:207`),
  as are reference keys (`Symbols/TypeArgsKey.gs`), `ConditionalWeakTable`,
  `ConcurrentDictionary` and `Lazy`.
- **ADR-0193.** Nullability decisions go through `NullabilityImportRule`; no
  new independent "is this nullable" computation; GSA0007 stays green.
- **ADR-0186.** Oblivious positions are `PlatformTypeSymbol`; the legacy
  `enabled` mode is being retired (#4372) and gets no new code path.
- **Determinism.** Emit is byte-for-byte reproducible; no hash-ordered
  iteration assigns a number, a name or a row (#4663).
- **#853.** No file handle stays open on a reference; images are read into
  memory. Memory-mapping was re-examined and rejected in #5167.
- **Public API snapshot.** The public surface of `GSharp.Core` is pinned by
  `CorePublicApiSnapshotTests` (`test/Core.Tests/Baselines/gsharp-core-public-api.txt`);
  an intentional change regenerates the snapshot (`GSHARP_UPDATE_GOLDENS=1`)
  and carries a release note. The ADR-0199 allowance list permits only the
  record-ABI `Deconstruct` additions and nothing else
  (`test/Core.Tests/PublicApi/CorePublicApiAllowance.gs:14-18`); a removal is
  a snapshot change, not an allowance entry.
- **Concurrency.** One resolver serves parallel body binding
  (`Binding/Binder.gs:8704`) and parallel emit (`Emit/FunctionEmitter.gs:119`);
  the language server shares one resolver across requests and never disposes
  it (`src/LanguageServer/ProjectState.gs:118-131, 440-472`);
  `ReferenceResolver.Dispose` clears 21 process-wide caches
  (`ReferenceResolver.gs:233-285`), unsafe while another compilation is live.
- **Hosts without an image.** `ReferenceResolver.Default()` and
  `WithRuntimeReferences` bind against host `RuntimeType` objects (REPL first
  cell, `gsc` without `/out`, language-server fallbacks, most tests); the
  `System.Private.CoreLib` to `System.Runtime` remap
  (`ImportedMemberRefFactory.gs:2007-2040`) exists for this path.

## Decision

### 5. The model

Imported entities become symbols backed by `System.Reflection.Metadata`
handles. There is no `System.Type` behind them.

```text
ReferenceImageSet                 immutable; owns byte[] images and one PEReader + MetadataReader per image;
  │                               keyed by the ordered (path, size, mtime, MVID:SHA-256) tuple; shared by compilations
  ├── MetadataModule[i]           one per image, in reference order; row-indexed symbol slots
  │     ├── MetadataTypeSymbol    one object per TypeDefinitionHandle (TypeSymbol subclass; ClrType is nil)
  │     │     ├── members         decoded on first request, table order, one object per Method/Field/Property/Event row
  │     │     └── type parameters one TypeParameterSymbol per GenericParameter row
  │     ├── MetadataMethodSymbol / MetadataFieldSymbol / MetadataPropertySymbol / MetadataEventSymbol
  │     └── TypeRef resolution    TypeReferenceHandle -> symbol in another module, through ExportedType forwards
  ├── ConstructedTypeSymbol       interned by (definition, TypeArgsKey): on the set when every argument is consumer-independent
  ├── MissingTypeSymbol           interned per set by (assembly identity, full name); the answer for an unresolvable TypeRef
  └── name index                  the #5166 reader, first writer wins in reference order
CompilationImportContext          per compilation: consumer assembly name, InternalsVisibleTo grants, semantic aggregates,
                                  constructions whose arguments reach a source type, a source type parameter or any compilation-owned symbol
```

- **Definitions.** `MetadataTypeSymbol` is created once per
  `(module, TypeDefinitionHandle)` and stored in a per-module array indexed by
  row number, published with `Interlocked.CompareExchange` so a race creates
  one winner and the loser is discarded before anyone can observe it.
  Members, base type, interfaces, attributes and generic parameters are
  decoded on first request and published the same way. Member order is table
  order. `MetadataMethodSymbol` and the others are created in the same manner
  per row.
- **Constructions.** A constructed imported type is one object per
  `(definition symbol, TypeArgsKey)`, exactly as `StructSymbol.Construct`
  interns source constructions. Two intern tables, chosen by what the
  arguments reach: a construction whose arguments are consumer-independent
  (imported definitions, built-ins, and composites over those only) is
  interned on the set; a construction whose arguments transitively contain a
  source type, a source type parameter or any compilation-owned symbol is
  interned in `CompilationImportContext` and dies with the compilation.
  `TypeArgsKey` holds its arguments strongly (`Symbols/TypeArgsKey.gs:19-25`),
  so a set-wide table would otherwise keep every compilation's
  `List[MySourceType]` alive for as long as the set is cached (#5145's
  retained-memory goal). The same ownership rule applies to every intern and
  cache table of this ADR (section 7c): a key that reaches a compilation-owned
  symbol is owned by the compilation. Arguments may be imported types, source types, type
  parameters or composites; the erased `List<object>` CLR shape and
  `ReifyClosedClrType` disappear, because the symbolic arguments are the only
  representation. A member signature of a construction is computed from the
  definition member's cached decode, which keeps the nullability-free
  structure **and** the declaration state of every position (the `[Nullable]`
  bytes and the `[NullableContext]` in force); substitution through a
  `TypeMap` (type parameter to argument) is followed by the funnel's
  `ApplyOpenSlot` for each substituted slot and `ApplyConcrete` for each
  concrete position, so `Box<string>.Value` reads `string?` and
  `Box<int>.Value` reads `int` from one cached decode
  (`NullabilityImportRule.gs:98-106`); the result is memoized per
  construction in the table that owns the construction. This is the interning
  #5158 asked for, and the deduplicated output it produces is the accepted
  baseline.
- **One decoder.** `MetadataSignatureDecoder` implements
  `ISignatureTypeProvider[TypeSymbol, GenericContext]` and
  `ICustomAttributeTypeProvider[TypeSymbol]`. It produces nullability-free
  structure (`MetadataArrayTypeSymbol` for `SZARRAY`,
  `RectangularArrayTypeSymbol`, `PointerTypeSymbol`, `ByRefTypeSymbol`,
  `FunctionPointerTypeSymbol`, `TupleTypeSymbol`, constructed types, the
  built-in primitives by `PrimitiveTypeCode`, never by name) plus the custom
  modifiers of each position as data beside the type. The nullability of a
  position is then applied once, by the funnel: the `[Nullable]` and
  `[NullableContext]` bytes of the member and its declaring chain are read
  from the attribute blob (the existing `ClrNullability.ReadNullableFlags`
  logic, with the attribute source changed from `CustomAttributeData` to a
  `BlobReader`), classified through `ClrNullability.ClassifyPosition`, and
  mapped through `NullabilityImportRule.ApplyConcrete`/`ApplyOpenSlot`. Tuple
  element names are applied from `[TupleElementNames]` by the same walker. No
  other code constructs a `NullableTypeSymbol` or `PlatformTypeSymbol` for an
  imported position (ADR-0193 §1). The members marked `@NullabilityFunnel`
  today keep their names and the GSA0007 door list is extended with the
  decoder's producers; the #5162 cache becomes the per-member decoded
  signature slot on the member symbol.
- **Well-known types.** A `WellKnownTypes` table on the set resolves the
  types the compiler names itself (`System.Object`, `System.ValueTuple`N`,
  `System.Nullable`1`, `System.Func`N`, `System.Action`N`,
  `System.Collections.Generic.Dictionary`2`, the async builders, the
  attribute types the emitter writes, ...) by name once, into the reference
  set, with a `SpecialType` tag on the resulting symbol. This replaces every
  host `typeof(...)` entry point (`MapClrTypeToReferences`,
  `TryProjectOntoReferences`, `EmitContext.ResolveCoreType`,
  `TupleTypeSymbol.GetOpenClrType`, `FunctionTypeSymbol`'s `typeof(Func<...>)`
  closures) and the five primitive `FullName` switches at once, and with them
  the whole `TypeBuilderInstantiation` class of probes. A well-known type that
  the reference set does not supply is a `MissingTypeSymbol`, and the use site
  reports GS0546 (today's "target framework member unavailable" diagnostic)
  instead of falling back to the host type. The eighteen built-in symbols
  that carry a host `typeof(...)` today (`TypeSymbol.Bool` through `Void`,
  `TypeSymbol.gs:113-164`) keep their identity and gain the `SpecialType` tag;
  their `ClrType` is `nil` like every other symbol's. **Canonical form rule:**
  the decoder returns the process-wide symbol exactly where today's
  `FromClrType` does, and a metadata definition or construction otherwise.
  `PrimitiveTypeCode` maps onto the built-ins directly; the `System.Decimal`
  definition (a `VALUETYPE` `TypeRef` in a blob, not a primitive code) maps
  onto `TypeSymbol.Decimal`; every **construction** of `System.Nullable`1`,
  over a closed `V` or over a type parameter (`Nullable<T>` with `T : struct`,
  which `GetValueTypeNullableUnderlyingClr` wraps today, `NullableLifting.gs:234-260`),
  maps onto `NullableTypeSymbol.Get(argument)`, and only the unconstructed
  definition stays a metadata definition; a constructed `System.ValueTuple`N` maps onto
  `TupleTypeSymbol` only for the shapes `TryGetTupleTypeSymbol` accepts
  (`TypeSymbol.gs:1692-1740`: two to eight arguments, a `TRest` chain of
  constructed `ValueTuple`s), while a standalone one-element `ValueTuple<T>`,
  an open definition and an unsupported `TRest` shape stay metadata symbols,
  because `TupleTypeSymbol.Get` rejects fewer than two elements
  (`TupleTypeSymbol.gs:148-150`); `WellKnownTypes` maps definitions only, and
  a construction over one (`Func<int>`) is an ordinary construction over the
  definition symbol. Source binding reaches the same objects, so
  `List<decimal>` from a signature and from source is one interned
  construction. The emitter resolves a built-in or composite back to the
  set's definition through the table when it needs a `TypeRef`.
- **Name index.** The set owns the #5166 index (`ReferenceTypeNameIndex`,
  names to module index, first writer wins in reference order, forwards
  verified against the target image). #5166 keeps one conservative rule: an
  image with a type name that reflection escapes (`,`, `+`, `&`, `*`, `[`,
  `]`, `\`) is read through reflection (`MetadataTypeNameReader.gs:28-29,
  109-111`). The handle model has no fallback, so PR 1 extends the reader to
  spell those names as reflection does; the ordered-names test of
  `Issue5124TypeNameIndexTests` (178 Core-closure assemblies against
  `GetTypes()` plus `GetForwardedTypes()`) stays the witness, plus a synthetic
  image with an escaped name.
- **Hosts without an image.** `Default()` and `WithRuntimeReferences` read
  the image of each host assembly from `Assembly.Location` into the same
  `ReferenceImageSet`, so the REPL, `gsc` without `/out` and the tests bind
  against the same model as `gsc`. An assembly with no location is not
  importable; the two in the repository are REPL submissions, already written
  to disk before the next cell binds (`src/Repl/Engine/EmittedSessionEngine.gs:312-314`),
  and the `StructValue` layout helper, which is not a reference. The
  `System.Private.CoreLib` to `System.Runtime` remap stays as it is today:
  type-based (`IsCoreLibBaseType`, `ImportedMemberRefFactory.gs:553-560,
  2007-2040`), applied to any base type whose module is `System.Private.CoreLib`,
  which only a host-backed set of either kind can contain.

### 6. Representation of each metadata shape

| Shape | Representation | Source |
| --- | --- | --- |
| Open generic definition | `MetadataTypeSymbol` with `TypeParameterSymbol`s from the `GenericParam` table; constraints from `GenericParamConstraint`; variance and special constraints from `GenericParameterAttributes` | `TypeDefinition.GetGenericParameters` |
| Closed or partially constructed type | interned `ConstructedTypeSymbol` over the definition | `TypeSpecification` blob through the decoder, or `Construct(args)` from binding |
| Nested type | `MetadataTypeSymbol` with `ContainingType`; name spelled `Outer+Inner` for the name index, as #5166 does | `TypeDefinition.GetDeclaringType` |
| Type forward | the destination definition; the facade never gets a symbol of its own; a chain is followed with a cycle guard | `ExportedType` with an `AssemblyReference` implementation, resolved through the set |
| Unresolvable `TypeRef` | `MissingTypeSymbol(assembly identity, full name)`, interned; equal to itself, to nothing else | `TypeReference` whose scope is not in the set or whose name is absent |
| `Nullable<V>` | `NullableTypeSymbol.Get(V)`, never a construction over the `Nullable`1` definition (today `FromClrType` does this first, `TypeSymbol.gs:198-199`) | `GENERICINST` over the `System.Nullable`1` well-known type |
| By-ref, pointer, pinned | `ByRefTypeSymbol`, `PointerTypeSymbol`, `PinnedTypeSymbol` (locals only) | `ELEMENT_TYPE_BYREF`, `PTR`, `PINNED` |
| Array | `MetadataArrayTypeSymbol(element)` for a single-dimensional array: length-free, interned by element under the ownership rule of section 7c (a `MetadataArrayTypeSymbol(MySourceType)` produced by substituting `T[]` belongs to the compilation), the handle twin of today's `ImportedTypeSymbol` over `T[]` that `ContainsMetadataRecoveredArray` detects (`TypeSymbol.gs:730-760`); never `ArrayTypeSymbol`, which is the fixed-length `[N]T` (`ArrayTypeSymbol.gs:10-21`), and never `SliceTypeSymbol`, so the metadata-recovered leniency in `ConversionClassifier.gs:1578-1586` and the source-array distinction in `TypeSymbol.gs:682-741` keep their inputs. `RectangularArrayTypeSymbol` (rank, bounds) for `ARRAY` | `SZARRAY`, `ARRAY` |
| Function pointer | `FunctionPointerTypeSymbol` with calling convention and `CallConv*` modifiers | `FNPTR` |
| Custom modifiers | `ImmutableArray[CustomModifier(type, isRequired)]` on the position (parameter, return, field, local), in blob order; `modreq(InAttribute)` and `modreq(IsExternalInit)` are read from it | `CMOD_REQD`, `CMOD_OPT` |
| Method | `MetadataMethodSymbol`: attributes, impl attributes, signature header (calling convention, instance, generic arity, vararg), parameters with names and flags from `Param` rows, return type, default values from `Constant`, `MethodImpl` rows for explicit overrides | `MethodDefinition`, `Parameter`, `Constant`, `MethodImpl` |
| Property, event | symbol over the `Property`/`Event` row with accessor method symbols from `MethodSemantics` | `PropertyDefinition`, `EventDefinition`, `MethodSemantics` |
| Field | `MetadataFieldSymbol` with literal value from `Constant`, offset from `FieldLayout`, marshalling from `FieldMarshal` | `FieldDefinition` |
| Constant, enum underlying type | `Constant` row of the field; the `value__` field's type | `Constant`, `FieldDefinition` |
| Required members, `SetsRequiredMembers`, `CompilerFeatureRequired` | flags on the member symbol, read by name from the attribute table | `CustomAttribute` on the member/ctor |
| Default interface methods, static virtual members | a method with `Virtual` and a body RVA, or `Abstract`; `MethodImpl` for the implementation | `MethodAttributes`, `MethodImplAttributes`, `MethodImpl` |
| Covariant returns | `PreserveBaseOverrides` attribute flag and `MethodImpl` rows | `CustomAttribute`, `MethodImpl` |
| Extension holders | `[Extension]` on the type and method, read into the #5108 extension index without constructing a type | `CustomAttribute` |
| Attributes consumed by the compiler | decoded by well-known name without constructing the attribute type: `Nullable`, `NullableContext`, `TupleElementNames`, `Dynamic`, `NativeInteger`, `IsReadOnly`, `IsByRefLike`, `IsUnmanaged`, `InlineArray`, `Obsolete`, `Experimental`, `ParamArray`, `ParamCollection`, `AsyncMethodBuilder`, `Extension`, `RequiredMember`, `SetsRequiredMembers`, `CompilerFeatureRequired`, `NotNullIfNotNull`, `NotNullWhen`, `MemberNotNull(When)`, `DoesNotReturn`, `DecimalConstant`, `DateTimeConstant`, `Optional`, `In`, `ScopedRef`, `UnscopedRef`, `RefSafetyRules`, `InterpolatedStringHandler(Argument)`, `CallerMemberName` and the other `Caller*`, `CollectionBuilder`, `DefaultMember`, `AttributeUsage`, `InternalsVisibleTo`, `AssemblyMetadata("GSharp.TypeSemantics")`, `Gsharp.Concurrency.Suspending`, `GSharp.MagicCollectionFields` | `CustomAttribute` blob through `ICustomAttributeTypeProvider` |
| Assembly identity | `AssemblyIdentity(name, version, culture, public key token)` on the module | `AssemblyDefinition` |

### 7. The closed inventory

Every question the compiler asks of an imported entity is listed here with its
metadata source and its failure behaviour. **Conservative default: a question
that is not in this table is not answered.** In comparison mode (section 10)
it is a test failure that names the site; in a release build it is the
internal compiler error GS9998 with the question and symbol in the message.
It is never a defaulted answer. Adding a row is a change to this table and a
corpus row in the implementation PR. The "today" column cites one site per
row; the site inventories named in References hold the rest.

Failure tags: **S** skip the member and report nothing (today's
`IsMetadataLoadFailure` pattern, `ClrTypeUtilities.gs:369-375`); **D**
diagnostic at the use site; **M** `MissingTypeSymbol`; **E** GS9998.

| # | Question | Metadata source | New failure | Today (representative site and behaviour) |
| --- | --- | --- | --- | --- |
| Q1 | Type by full name, by name in one assembly, nested type by dotted path | name index (#5166), `TypeDefinition` rows | M | `ReferenceResolver.TryResolveType` `:389`; `TryResolveTypeInAssembly` `:514`; `GetNestedType` `:567` |
| Q2 | Namespace, name, arity, nesting, containing type | `TypeDefinition` | none | `Type.Namespace`/`Name`/`DeclaringType`, ~56 sites in Emit alone |
| Q3 | Kind flags: value type, enum, interface, abstract, sealed, delegate, by-ref-like, primitive, static class | `TypeAttributes`; base chain to `System.ValueType`/`System.Enum`/`System.MulticastDelegate` by `SpecialType`; `IsByRefLike` attribute | none | raw `IsValueType` at ~65 sites answers `false` across contexts (`ClrTypeUtilities.gs:1546-1578`); `IsDelegateType` by `FullName` `:263-275` |
| Q4 | Base type and the base chain | `TypeDefinition.BaseType` (TypeDef, TypeRef or TypeSpec) | M for an unresolvable link; the chain stops there and the use site reports D | `GetBaseTypeSafe` `ImportedClassSymbol.gs:869-875` returns `nil` (S) |
| Q5 | Interfaces, transitive closure, interface map | `InterfaceImpl` rows; closure computed once per type; map from `MethodImpl` plus name-and-signature match in the C# rules | M per link | `SafeGetInterfaces` `:813-858` completes a graph MLC leaves partial; `GetInterfaceMap` throws and is caught (`ExpressionBinder.Access.MemberLookup.gs:5275-5282`) |
| Q6 | Members by name; all members per level (methods, properties, fields, events, constructors, operators, indexers) | `TypeDefinition.GetMethods/GetFields/GetProperties/GetEvents`, `MethodSemantics`; a per-type name-to-members dictionary built once | a member whose signature holds a `MissingTypeSymbol` is kept and reported D only when selected | `SafeEnumerate` `:1231-1257` drops the member silently (S); `ClrTypeMayHaveMember` answers `true` on any exception (fail-open, `:205-229`) |
| Q7 | Method signature: calling convention, vararg, instance, generic arity, return, parameters, custom modifiers | `MethodDefinition.DecodeSignature` through the one decoder | D at use when a position is M; blob error is E | `GetParameters`/`ReturnType` ~310 sites; modifiers partly lost (`SignatureEncoder.gs:757-808`) |
| Q8 | Field type, property type, event handler type, indexer parameters | `FieldDefinition.DecodeSignature`, `PropertyDefinition.DecodeSignature`, event type handle | as Q7 | `ClrNullability.Get*TypeSymbol` `ClrNullability.gs:147-308` |
| Q9 | Parameter name, in/out/optional flags, default value, `params`, ref kind, `scoped` | `Parameter` row, `Constant` row, attributes `ParamArray`/`ParamCollection`/`Optional`/`DecimalConstant`/`DateTimeConstant`/`In`/`ScopedRef`, `modreq(InAttribute)` | none; a malformed constant is E | `ConversionClassifier.gs:4883-5010` blanket catch means "no default"; `RefCapabilities.gs:429-449` |
| Q10 | Method flags: static, virtual, abstract, final, newslot, special name, has body | `MethodAttributes`, `MethodImplAttributes`, RVA | none | `IsOverrideFromMetadataAttributes` `:949-956` |
| Q11 | Override slot identity (which base method does this override; explicit interface implementations) | **Parity stages (PRs 3 to 7), per resolver kind, because today's answer differs by kind:** for a `WithReferences` set (MLC today) two methods are the same slot when they are the same method definition (same module and handle; the token-and-module identity `SameClrMethodSlot` falls back to when `GetBaseDefinition` throws); for a host-backed set (`Default()`, `WithRuntimeReferences`, `metadataContext: nil`, `ReferenceResolver.gs:1269-1274`) `GetBaseDefinition` succeeds today, so `object.ToString` and `string.ToString` are one slot, and the handle model answers with the `MethodImpl` and base-chain walk from PR 6 on. Explicit implementations keep the name-suffix rule in both. **After stage 7** (decision Q4, #5174): the walk for every set. Both answers exist behind one switch from PR 3; the corpus holds a case per resolver kind. | none; an unresolvable base is M and the walk stops | `SameClrMethodSlot` degrades to token identity because `GetBaseDefinition` throws under MLC (`:5073-5085`; wrong for overrides); explicit implementations detected by a name-suffix heuristic (`:5340-5384`) |
| Q12 | Accessibility; `InternalsVisibleTo` grant to the consumer | `MethodAttributes`/`FieldAttributes`/`TypeAttributes` visibility; `InternalsVisibleTo` rows of the module against the `CompilationImportContext` | none | `ClrMemberVisibility.gs:37-171`; `GrantsInternalAccessTo` `ImportedAssemblySemantics.gs:241-268` (blanket catch denies) |
| Q13 | Generic type parameters: position, owner, constraints, variance, special constraints | `GenericParam`, `GenericParamConstraint`, `GenericParameterAttributes` | **Parity stages:** the legacy fallback. When a parameter's constraint list cannot be read, that parameter's whole type-bound constraint list is skipped and the candidate stays viable; the special constraints (`struct`, `class`, `new()`) checked before the read stay checked (`ClrOverloadResolution.gs:4136-4146, 7505-7511, 7754-7764`). In the handle model "cannot be read" is "a constraint type is M", so the same skip applies to that parameter. **After stage 7 (#5176):** M per constraint type makes the constraint unsatisfiable, not satisfied. | `ClrOverloadResolution.gs:7393-7705`; a failed read `continue`s (`:4141, 7509, 7760`) |
| Q14 | Construct a type or method over arguments; substitute a signature | `Construct(args)`, `TypeMap` | none; constraint checks are the binder's (`SatisfiesDeclaredConstraints`) and never a thrown `ArgumentException` | `MakeGenericType`/`MakeGenericMethod` with 35 `catch (ArgumentException)` sites used as the constraint oracle (`ClrOverloadResolution.gs:5555-5575`) |
| Q15 | Assignability, identity and variance conversions between imported types | structural rules over Q4, Q5, Q13 on symbols; reference identity for definitions and interned constructions | none | `IsAssignableFrom` with `catch (InvalidOperationException)` then a by-name walk (`ClrTypeUtilities.gs:171-231`, `ClrOverloadResolution.gs:8954-9050`) |
| Q16 | Attributes by well-known name, with constructor and named arguments | `CustomAttribute` rows, `DecodeValue` through the decoder | a malformed blob is E; an attribute whose type is M is ignored and counted | `SafeGetCustomAttributesData` `ClrNullability.gs:1367`; 16 attribute kinds are never read from imports today (section 15) |
| Q17 | Nullable flags and context of a member and its declaring chain | `Nullable`/`NullableContext` blobs on member, type, declaring types, module | none; absent is oblivious (ADR-0186) | `ReadNullableFlags` `ClrNullability.gs:475-530` |
| Q18 | Tuple element names | `TupleElementNames` blob | none | `TupleElementNamesReader.gs:44-66` (counter on failure) |
| Q19 | Constant and literal field values; enum members | `Constant` rows | E on a malformed constant | `GetRawConstantValue` `ExpressionBinder.Access.MemberLookup.gs:784-803`, unguarded |
| Q20 | Struct layout, field offsets, marshalling, P/Invoke import | `ClassLayout`, `FieldLayout`, `FieldMarshal`, `ImplMap` | none | `BlittableDetector.gs:191-235`; `Marshal.SizeOf` on an MLC type always fails (`StructLayoutBinder.gs:218-229`) and stays a host-reflection fallback (section 8) |
| Q21 | Data-type semantics markers (`GSharp.TypeSemantics`, C# record shape, magic-collection fields) | assembly and type attributes, member names | none | `ImportedAssemblySemantics.gs:173-470` (blanket catches deny) |
| Q22 | Delegate `Invoke` signature | Q6 on the delegate type, then Q7 | D when absent | `ClrLoadContext.TryGetDelegateSignature` with `Func`/`Action` prefix decomposition (`ClrLoadContext.gs:102-190`) |
| Q23 | `GetEnumerator`/`Current`/`MoveNext`, awaitable and async-enumerable shapes, interpolated-string handler shape, async method builder | Q6 and Q7 on the symbols | D (the existing pattern diagnostics) | `Lowerer.gs:655-725, 1405-1669`; `AsyncMethodBuilderInfo.gs:225-360` with host `Type.GetType(fullName + ", System.Runtime")` |
| Q24 | Assembly identity, name, version, public key token, is-reference-assembly, `Location` for documentation | `AssemblyDefinition`, module path | none | `ImportedMemberRefFactory.gs:445-469`; `Assembly.Location` throws for in-memory assemblies (`ReferenceResolver.gs:1240`) |
| Q25 | Which assembly a `TypeRef` resolution scope names at emit | the definition's module; forwards already resolved; the type-based `IsCoreLibBaseType` remap for a `System.Private.CoreLib` base type in a host-backed set of either kind | none | `ImportedMemberRefFactory.gs:548-565`; host `System.Runtime` version (`:477-523`) |
| Q26 | Whole-assembly scans: extension holders, placeholder types for inference | `TypeDefinition` rows in table order; attributes by Q16 | none | `BuildImportedExtensionHolderIndex` `MemberLookup.gs:396-423`; `GetTypes().OrderBy(FullName)` `ClrOverloadResolution.gs:2488` |
| Q27 | Documentation comment for a member | documentation id built from the symbol | none | `AssemblyDocumentationProvider.Resolve(OpenDefinition ?? Type)` |
| Q28 | Display name | symbol printer | none | `RenderClrType` `TypeSymbol.gs:102` |
| Q29 | Does a source member implement or override an imported interface or virtual member (name, substituted signature, default-method presence, covariant return) | Q6 and Q7 on the imported side; `MethodImpl` and `MethodImplAttributes` | **Parity stages:** today's signature match. **After stage 7 (#5174):** `MethodImpl`-aware. | `DeclarationBinder.InterfaceVerification.gs` (23 `ClrType` reads); `ExternalClrOverrideResolver.GetEffectiveAbstractSlots` `:285-326` |
| Q30 | Storage size and field offsets of a struct whose fields are built-in, enum or imported value types | **Parity stages:** the `LayoutHostTypes` bridge of section 8. **PR 6:** symbolic layout from `SpecialType` sizes, enum underlying type, `ClassLayout`, `FieldLayout` and the target pointer size | `false` (no size) where today's oracle answers `false` | `StructLayoutBinder.gs:170-229`; `StructValue.gs:258-343` |

Questions that have no row and are not ported: `MetadataToken`+`Module` as
identity (Q11 replaces it), `AssemblyQualifiedName` keys (reference identity
replaces them), host `typeof(...)` projection (the `WellKnownTypes` table
replaces it), `IsAssignableFrom`, `GetBaseDefinition`, `GetInterfaceMap`,
`MakeGenericType` as a constraint oracle. The fail-open probes
`ClrTypeMayHaveMember`, `ImportedExtensionMayApply` and
`HasExplicitClrInterfaceImplementation` keep their answer during the parity
stages (table 7b) and go with #5183.

### 7a. Completeness audit

A mechanical audit at `2e9fd1a1d` of every way the compiler reaches the
reflection model (grep hits over `src/Core/CodeAnalysis` unless stated), so a
consumer outside the table is found by grep, not by review. **Conservative
default: a site this audit does not map to a row keeps its legacy behaviour
during the parity stages**; PR 2 re-runs the audit as a test input, and a new
site is mapped there before it is migrated.

| Family (grep) | Sites | Rows | Disposition |
| --- | ---: | --- | --- |
| `TypeSymbol` base members that read `ClrType` (`ConstructedTypeArguments`, `ConstructedFrom`, `IsValueType`, `BaseType`, `ToDisplayString`, `TypeSymbol.gs:37-106`) | 12 | Q2 to Q4, Q28 | become handle members |
| Conversions and classification (`Conversion.gs` 130, `ConversionClassifier.gs` 38, `StructuralProjectionPlan.gs` 9, `ExpressionBinder.NativeSlices.gs` 9) | 186 | Q3, Q13, Q15 | structural rules on symbols |
| Member access, calls, overloads (`ExpressionBinder.Access.*` 68, `ExpressionBinder.Calls*` 63, `MemberLookup.gs` 47, `ClrOverloadResolution.gs` 20, `OverloadResolver.Candidates.gs` 9, `ImportedClassSymbol.gs` 9) | 216 | Q6 to Q11, Q14, Q22 | |
| Operators, loops, literals, assignments, blocks, `Binder.gs` | 135 | Q3, Q19, Q22, Q23 | enumerator, awaitable and handler shapes |
| Source attributes whose attribute type is imported (`KnownAttributes.gs` 19, `DeclarationBinder.Attributes.gs` 17) | 36 | Q16 | `AttributeUsage` walk, constructor selection |
| Interface and override verification of source members (`DeclarationBinder.InterfaceVerification.gs` 23, `ExternalClrOverrideResolver.gs`) | 30 | **Q29** (new) | |
| Emit (`MethodBodyEmitter.*` 131, `ImportedMemberRefFactory.gs` 21, `UserTokenResolver.gs` 20, `CustomAttributeEncoder.gs` 15, `NullableFlagsBuilder.gs` 13, `ReflectionMetadataEmitter.gs` 12, `SignatureEncoder.gs` 9, `TypeDefEmitter.gs` 8, others) | 294 | Q2, Q3, Q7, Q8, Q19, Q24, Q25 | IL choice by kind flags; tokens |
| Lowering (`Lowerer.gs` 9, async and handler shapes) | 36 | Q23 | |
| Layout oracle (`StructValue.gs` 8, `StructLayoutBinder.gs` 4) | 12 | **Q30** (new) | section 8 bridge, then symbolic |
| Documentation ids (`SymbolDocumentationIdProvider.gs:313-318`) | 2 | Q27 | |
| `GetEffectiveClrType` (closes `Nullable<>` over a `ClrType`; 20 files) | 54 | section 5 canonical form | `NullableTypeSymbol.Get` over symbols |
| Producer doors `FromClrType` 26, `FromClrTypeWithoutNullability` 265, `MapOpenClrTypeToSymbolic` 64 | 355 | Q7, Q8, Q14 | become the decoder's outputs; a door fed a host `typeof` becomes a `WellKnownTypes` lookup |
| Host `typeof(` (Binding 478, Emit 443, Lowering 357, Symbols 181, other 8) | 1,467 | section 5 `WellKnownTypes` | PR 1 generates the per-site list; a `typeof` used as a metadata identity becomes a table lookup, one used as a runtime value (attribute instance, pattern test, host helper) is not import and is untouched |
| Guarded reflection calls: `catch` 434 in the four layers (`IsMetadataLoadFailure` 79, `NotSupportedException` 36, `ArgumentException` 42, blanket 65) | 434 | table 7b | each guard's legacy answer is a 7b row or "no import" |
| Language server (`BoundSemantics.gs`, `ImportedClrMemberResolver.gs`, `SemanticLookup.gs`) | 25 | Q6, Q15 | stage 6 |
| `tools/gsgen` type speller | 11 | Q28 | stage 6 |

Total `.ClrType` reads: 1,242 in 138 files of `src/Core`; every family above
is a row or a named disposition, and no read was found outside them.

**7b. Legacy fallback kept during the parity stages, and the fail-closed
answer it becomes.** Each row is a corpus entry in PR 2 that records today's
answer; the follow-up issue flips it after stage 7.

| Row | Legacy fallback on a read failure (kept, PRs 2 to 7) | Fail-closed answer (after stage 7) | Issue |
| --- | --- | --- | --- |
| Q4, Q5 | base chain or interface list stops at the failing link (`nil`, partial) | `MissingTypeSymbol` link; GS9106 if the use needs it | #5183 |
| Q6 | member dropped when any signature type fails to load; `ClrTypeMayHaveMember`, `ImportedExtensionMayApply` answer `true` on an exception | member kept with M positions; GS9106 when selected; probes fail closed | #5183 |
| Q7, Q8 | member dropped (as Q6) | as Q6 | #5183 |
| Q9 | "no default value", "not `params`" on a failed read | GS9998 for a malformed constant; attribute absent otherwise | #5183 |
| Q11 | same method definition handle; name-suffix rule | `MethodImpl` and base-chain walk | #5174 |
| Q1 | a second module with an already-loaded simple name is loaded silently; first writer wins | first writer still wins; a diagnostic names both paths (decision Q3) | #5183 |
| Q12 | internal access denied on a failed `InternalsVisibleTo` read | unchanged (deny) | none |
| Q13 | the parameter's type-bound constraint list skipped, candidate viable | constraint unsatisfiable | #5176 |
| Q16 | attribute treated as absent on a failed read; 12 attribute kinds never read | read; malformed blob GS9998 | #5177 |
| Q20, Q30 | no size (`false`) | symbolic layout | Q30 (PR 6) |
| Q21 | semantics denied on a failed read | unchanged (deny) | none |
| Q22 | `TryGetDelegateSignature` blanket catch: no signature | diagnostic at use | #5183 |
| Q25, emit | `Object()`, `STRING`, `int32`, host `typeof` written | diagnostics; GS0546 | #5183 |
| Q29 | signature match without `MethodImpl` | `MethodImpl`-aware | #5174 |

**7c. Cache and intern tables.** Owner is the set when a key can never reach
a compilation-owned symbol, otherwise the compilation; the test is the one
rule of section 5.

| Table | Key | Owner | Consumer-independence test |
| --- | --- | --- | --- |
| Definition slots | (module, row) | set | always independent |
| `MissingTypeSymbol` | (assembly identity, full name) | set | always |
| `WellKnownTypes` | `SpecialType` or name | set | always |
| Name index (#5166) | name to module index | set | always |
| Per-definition member-by-name map, interface closure, base chain | definition | set | a definition reaches only definitions and its own type parameters |
| Decoded member signature (structure plus declaration states) | member definition | set | as above |
| Constructions | (definition, `TypeArgsKey`) | set or compilation | every argument consumer-independent, recursively |
| Substituted member signature | (construction, member) | the construction's owner | inherits |
| `MetadataArrayTypeSymbol`, `PointerTypeSymbol`, `ByRefTypeSymbol`, `PinnedTypeSymbol`, `FunctionPointerTypeSymbol`, `TupleTypeSymbol`, `NullableTypeSymbol`, `PlatformTypeSymbol`, `NullabilityAnnotatedTypeSymbol` | element or parts | the parts' owner | every part consumer-independent; these are process-wide today and `Dispose` clears them, M5 moves them |
| Extension holder index (#5108, names and holder definitions) | set | set | the consumer's visibility filter is applied by the compilation, not stored |
| Semantic aggregates, `InternalsVisibleTo` grants | (type, consumer) | compilation | consumer-dependent by definition |
| Emitter row caches (`TypeRefs`, `TypeSpecs`, `MethodRefs`, `MethodSpecs`, `CtorRefs`, `FieldRefs`) | symbol, plus `RemapScope` where a type parameter can occur | one emit session | not shared; D1 applies within equal scopes |
| Comparison answers (`compare` mode) | (question, symbol) | one run | not a cache |

**7d. Permitted differences and parity exceptions.** The single source of
truth for both gates. **Compare gate**: zero disagreements between `mlc` and
`handles` on every question of section 7 over Core, Core.Tests and the pinned
Oahu inputs, except the rows below. **Output gate**: implementation, reference,
PDB and XML output and the diagnostics text byte-identical between the two
modes and against the previous stage, except the rows below. Every other
difference is a defect of the stage that introduced it; sections 10, 14, 16
and 19 refer here.

| # | Permitted difference | Accepted by | Appears | Checked by |
| --- | --- | --- | --- | --- |
| D1 | Row deduplication: `TypeRef`, `TypeSpec` and `MemberRef` rows keyed by symbol identity, `AssemblyRef` rows by assembly identity; fewer rows, same program. A row key that involves a type-parameter symbol also carries the active `RemapScope` (section 9), so rows that differ by VAR/MVAR ordinal are not merged | #5158 (maintainer, 2026-10-22) | PR 5 in `handles` and `compare`; every user from PR 6 | per-table row counts on Core and Core.Tests, every removed row a duplicate with an equal scope; ILVerify; conformance suites; repeat-run determinism |
| D2 | The `System.Runtime` `AssemblyRef` version read from the reference set instead of the host runtime (`ImportedMemberRefFactory.gs:477-523`), and with it the fields derived from the PE content hash: the MVID, the PE timestamp, the reference assembly's `.mvid` section and the PDB id and checksum (`ReflectionMetadataEmitter.gs:4085-4141, 5001-5010`) | decision Q5 | PR 5; visible only when the host runtime version differs from the target reference pack | a corpus case that compiles a `net8.0`-targeted program on the `net10.0` host: the version field and the derived identity fields differ (the regions `build/compiler-bench.py` already masks), everything else byte-identical |
| D3 | Member and candidate order for host-backed sets (`Default()`, `WithRuntimeReferences`): table order instead of `RuntimeType`'s unspecified `GetMethods` order | section 12 | PR 6 | the compare gate compares those sets' member lists as sets. The output gate includes the on-disk host-backed path (`gsc /out:` with no `/reference`, `src/Compiler/Program.gs:415-420`) with **no** exception: an output difference there is attributed to one of the order-dependent sites (GS0160 listing order, `FindReferenceTypeConstraintPlaceholder`, the first-interface `fallback ??=` in `ResolveGetEnumerator`) and fixed in PR 6 by sorting the legacy answer, or the stage does not land |

Nothing else is permitted during PRs 1 to 7: no diagnostic text or count
change (table 7b keeps every legacy answer), no candidate or tie change for a
`WithReferences` compile, no custom-modifier change (decision Q6), no
fail-closed answer or new diagnostic before its follow-up issue (#5183, #5176,
#5174, #5177; the Q3 duplicate-simple-name diagnostic lands with #5183). A
stage that needs a new row adds it here first, with its decision.

### 8. What stays on runtime reflection, and why

- **Executing code.** `EmittedProgramHost`, `InteractiveSessionHost` and the
  REPL value formatter load the emitted image into a collectible
  `AssemblyLoadContext` and invoke it (`Execution/EmittedProgramHost.gs:112-150`);
  analyzer and generator hosts load and run analyzer assemblies
  (`Analyzers/GSharpAnalyzerHost.gs:34-131`, `GeneratorRunner.gs:33-89`); hot
  reload applies deltas with `MetadataUpdater`. None imports symbols; none
  changes.
- **The layout oracle** (`StructValue.TryGetStorageSize`, `StructValue.gs:258-343`;
  consumer `StructLayoutBinder.TryGetStorageSize`, `StructLayoutBinder.gs:170-229`,
  which feeds overlap validation) defines a runtime type with
  `AssemblyBuilder.DefineDynamicAssembly` and reads its inputs through
  `ClrType`: `ResolveRuntimeType` takes an enum's `ClrType` or its underlying
  type's, and every other field type through `GetEffectiveClrType`, which falls
  back to `typeSymbol.ClrType` (`:328-343`). With section 5's `nil` backing an
  `int32` field would become `typeof(object)` storage, so this consumer
  migrates **before** any built-in loses its `ClrType` (row Q30): PR 2 gives
  the oracle a private `LayoutHostTypes` bridge (a built-in's `SpecialType` to
  the host primitive, an enum to its underlying primitive's host type, an
  imported value type to the host type of the same assembly-qualified name
  when the host runtime has it, otherwise `typeof(object)` exactly as today),
  which reproduces today's answers during the parity stages and is checked by
  the `StructLayoutBinder` tests and a corpus row per `StructLayout` fixture.
  PR 6 replaces the oracle with a symbolic layout calculation (primitive sizes
  by `SpecialType`, enum underlying type, nested source struct layouts, imported
  value types from `ClassLayout` and `FieldLayout`, pointer size from the
  target); the bridge and the dynamic assembly go with it. `Marshal.SizeOf` on
  an imported type fails today (`StructLayoutBinder.gs:224`) and keeps that
  answer through stage 7 (section 15).
- **The `MetadataLoadContext` oracle** stays in the tree until the comparison
  gate of the last stage passes, then is deleted (section 11).

### 9. Identity and equality

- A definition is reference-equal to itself and to nothing else. Two
  `ReferenceImageSet`s never share a symbol, so a symbol from one compilation
  cannot answer another's lookup (the #3826 defect is impossible by
  construction, with no comparer). The definition slots and the
  consumer-independent construction table live on the set.
- A construction is reference-equal to the construction with the same
  definition object and the same argument objects (`TypeArgsKey`). Within one
  compilation there is one answer per key: the compilation's table is
  consulted first and defers to the set's table when every argument is
  consumer-independent, so a construction never has two objects, and a
  construction over a source type is never reachable from the set.
- Symbol identity is binding identity, not row identity. The emitter encodes
  one `TypeParameterSymbol` as different VAR/MVAR ordinals under an active
  iterator or lambda remap (`SignatureEncoder.gs:242-275`), so every emitted
  row key that can involve a type parameter carries the `RemapScope`, as
  `MethodSpecSymbolKey` and `CtorRefSymbolKey` do today
  (`MetadataTokenCache.gs:439-537`); D1 deduplicates only rows with equal
  scopes.
- Cross-assembly identity: a `TypeRef` resolves to the definition in the
  module its `AssemblyRef` names, following `ExportedType` forwards, so two
  references that reach one type through different facades are one object;
  today's emitted `TypeRef` scope is already the implementation assembly
  (`ImportedMemberRefFactory.gs:548-565`), so rows do not move.
- Two reference assemblies with the same simple name in one set: the set keeps
  today's rule (the name index and `AssemblyRef` binding are first-writer-wins
  by simple name, in reference order; Roslyn's version unification is not
  adopted) and, after stage 7 with #5183, reports a diagnostic when a second
  module with that simple name is loaded (decision Q3; table 7b).
- Same-compilation types as arguments of imported constructions need no
  erasure: `ConstructedTypeSymbol` holds the symbol, and the emitter's
  symbolic parent (`TryNormalizeToSymbolicContainer`,
  `ImportedMemberRefFactory.gs:2339-2426`) becomes the only path.
- `TypeSymbol.ClrType` is `nil` for every handle-backed symbol (section 14).

### 10. The adapter and the comparison mode

The change lands behind the existing symbol API: `ImportedTypeSymbol`,
`ImportedFunctionSymbol`, `ImportedClassSymbol` and the `Bound*Clr*` nodes
keep their names and gain a construction over a handle-backed symbol. A
consumer that still needs the reflection object asks the adapter, which
materializes it from the oracle `MetadataLoadContext` by name (as the
warm-index path does, `ReferenceResolver.gs:955`); as each consumer family
moves to symbol queries, its reflection accessor loses its last caller and is
deleted.

**Comparison mode** is a dual-resolver run. `GSHARP_METADATA_MODEL` selects
`mlc` (today), `handles` (the new model) or `compare`. In `compare`, every
question in section 7 is asked of both implementations through one
`ImportQuery` facade; the two answers are compared as normalized identities,
not as display strings: a type definition is (assembly identity, module, full
metadata name); a member is (its type's identity, metadata table, row), so
`C.M<T>(T)` and `C.M<T>(T, int)` are distinct owners; a constructed method is
(receiver identity, member identity, ordered normalized method type arguments), so `M<int>()`
and `M<string>()` differ even when `T` occurs in no parameter or return
(`MethodSpec` rows encode the arguments, `ImportedMemberRefFactory.gs:731-752`);
a generic parameter is (owner identity, ordinal); a composite is its kind plus
its parts recursively;
each position carries its nullability, its modifiers in order, flags,
accessibility, constant values and member lists in table order. The same key
function runs on both models (`Type`, `MemberInfo` and `MetadataToken` on one
side, handles on the other), so a wrong resolution scope or a wrong parameter
owner cannot pass as a same-named type (the printer omits the assembly and
prints only a parameter's name, `TypeSymbol.gs:1742-1764`); the corpus has an
overloaded-generic-owner case. Display strings appear only in the report. A
disagreement is recorded with the question id, the symbol and the asking site,
in a counter (`metadata.model-disagreements`) and a report file next to the
phase JSON. The two gates and the only differences they permit are defined once,
in section 7d. `Issue5124TypeNameIndexTests.AssertIndexMatchesReflection` is
the shape to generalize: it compares the metadata reader against reflection in
exact order for all 178 assemblies of the Core closure.

**Order of migration**, one PR each (section 19 has the acceptance criteria):

1. `ReferenceImageSet`, modules, assembly identity, the name index moved onto
   the set, `TypeRef` and forward resolution, `MissingTypeSymbol`,
   `WellKnownTypes`. No consumer changes; the set is built beside the
   `MetadataLoadContext`.
2. `MetadataTypeSymbol` and the decoder behind the `ClrNullability` funnel.
   The adapter materializes `Type` on demand. Comparison mode and the
   generated corpus (section 19) start here.
3. Member lookup (`MemberLookup`, `TypeMemberModel`, `ImportedClassSymbol`,
   `ClrMemberVisibility`, the extension index) reads members from symbols.
4. Overload resolution, conversions and inference
   (`ClrOverloadResolution`, `ConversionClassifier`, `Conversion`,
   `ExternalClrOverrideResolver`) on symbols; constraint checks are the
   binder's own; Q15 becomes structural; Q11 keeps its legacy answer behind
   the switch (section 7).
5. Lowering and emit: `SignatureEncoder`, `ImportedMemberRefFactory`,
   `CustomAttributeEncoder`, `NullableFlagsBuilder`, `UserTokenResolver`,
   `WellKnownReferences` take symbols; `MetadataTokenCache` is keyed by
   symbol identity; `TypeIdentityComparer` and `LoadContextSensitiveTypeComparer`
   are deleted.
6. The remaining binder and symbol sites (`KnownAttributes`,
   `RefCapabilities`, `ImportedAssemblySemantics`, `NullableLifting`,
   `ManagedReferenceTypes`, the `Lowering/Async` shapes), the language
   server (`BoundSemantics`, `ImportedClrMemberResolver`, `SemanticLookup`)
   and `tools/gsgen`.
7. Public API change (section 14), deletion of the `MetadataLoadContext`
   path and the adapter accessors, `Dispose` becomes a release of the set.

Stages 2 to 6 each run in all three modes; `compare` is the gate. One
transition point: `mlc` is the default through stage 5; PR 6 makes `handles`
the default and keeps `mlc` and `compare` selectable (maintainer decision Q7:
a user who hits a divergence can still produce the report); PR 7 deletes
both. No other statement in this ADR moves that point.

### 11. Lifetime and memory

- `ReferenceImageSet` is immutable after construction and owns the `byte[]`
  images and readers. Symbols hold a strong reference to their module, and a
  module to its set, so no handle outlives its image; a set is released when
  the last compilation, symbol and cache entry that reaches it is collected.
  This is the ownership `MetadataLoadContext` `Type` objects have today,
  minus the explicit `Dispose`.
- The set is the consumer-independent partition of #5145: keyed by the
  ordered references with path, size, mtime and `MVID:SHA-256` (the ADR-0107
  fingerprint), cached across worker requests and language-server rebuilds
  under the worker's memory bound (`src/Compiler/WorkerProtocol.gs:12-17`).
  The consumer-dependent state (`CurrentAssemblyName`, the `InternalsVisibleTo`
  grant, the aggregates `BuildSemanticAggregate` builds with it,
  `ImportedTypeSymbol.gs:455-461`, and the tables 7c assigns to the
  compilation) lives in `CompilationImportContext` and is never shared, so a
  friend and a non-friend compilation over one set see different aggregates.
  **Retention test (PR 2, and #5145's worker test):** compile a program twice
  in one process over one cached set, hold a `WeakReference` to a
  `List[MySourceType]` construction, to the `MetadataArrayTypeSymbol(MySourceType)`
  that substituting an imported `T[]` member produced, to a
  `NullableTypeSymbol` over a source struct and to a source `StructSymbol`
  from the first compile, drop the compilation, collect, and assert all are
  dead while the set and its `List<int>` construction stay alive.
- `ReferenceResolver.Dispose` stops clearing the 21 process-wide caches. The
  wrapper tables that made that necessary move to the owner table 7c names
  (study item M5, #5145 item 1, tracked as #5228); until they move, a set referenced from a
  process-wide cache stays alive with it, as the `MetadataLoadContext` does
  today, a memory cost and not an identity defect.
- Host TPA images stay one copy per process per (path, size, mtime,
  fingerprint), as `SharedHostAssemblyBytes` does today (`ReferenceResolver.gs:1133-1136`).
- Thread safety: slot publication by `Interlocked.CompareExchange`; interning
  through `ConcurrentDictionary.GetOrAdd` with a reference-equal key; one
  decode per member under a per-entry lock, as #5162 does; a decode that saw a
  `MissingTypeSymbol` or a blob error is stored, because the answer is stable
  for the set (the handle model has no retryable read).
- Images stay `byte[]` (#853; mapping rejected again in #5167); a `PEReader`
  over an `ImmutableArray[uint8]` view is zero-copy (`MetadataTypeNameReader.gs:48`).

### 12. Determinism

Symbol slots are arrays indexed by row number; member lists are table order;
the name index is built in reference order with first writer wins (#5166
pins the order against reflection); intern tables are never enumerated;
candidate order is table order, as for `MetadataLoadContext` today (host
`RuntimeType` order is unspecified, hence D3 in section 7d). Emit row order
follows the emitter's traversal, unchanged. Every stage adds a repeat-run
test: two compiles of Core by the same compiler are byte-identical.

### 13. Failure model

Today a missing or unreadable reference is a caught exception at the site
that touched it: `IsMetadataLoadFailure` drops the member (73 sites), 64
blanket `catch` sites return `false`, `nil` or `true`, and the emitter writes a
wrong encoding in four places (`CustomAttributeEncoder.gs:899-902, 2175-2188,
2292-2295`; `WellKnownReferences.gs:315-328`).

The answers below are the end state. **During the parity stages (PRs 2 to 7)
the handle model reproduces the legacy fallback of each row of table 7b
behind the same legacy-answers switch as Q11**, so the compare gate stays at
zero; the follow-up PRs of #5183 (member skips, fail-open probes, silent
emitter encodings), #5176 (constraints) and #5174 (slot identity) flip the
switch after stage 7 with a witness each (maintainer decision Q4).

In the new model:

- An image that is not a PE file or has no metadata is GS9105 at
  reference-set construction naming the path (today `MetadataLoadContext`
  throws `BadImageFormatException` at load).
- A `TypeRef` that resolves nowhere is a `MissingTypeSymbol` that flows through
  signatures, so member lists are complete; a candidate whose selected position
  is missing reports GS9106 at the use site, naming the type and the assembly
  (the under-referenced condition of `MissingTransitiveReferences`,
  `ReferenceResolver.gs:290-299`), and the compile fails instead of emitting a
  reference the runtime cannot load. An unselected candidate costs nothing.
- A malformed signature or attribute blob (`BadImageFormatException` from the
  reader) is GS9998 with the module, the handle and the question.
- A question outside section 7 is GS9998 (section 7, conservative default).
- Nothing is a silent fallback: the four emitter encodings above become
  diagnostics and `WellKnownTypes` misses report GS0546, in the #5183 PR
  after stage 7 (table 7b).

The remaining 84 first-chance exceptions of #5157 that come from import are
gone: the model has no probe that throws, and the transitive probe and the
name index are replaced by `MissingTypeSymbol` and the reader.

### 14. Compatibility and observable changes

- **Diagnostics.** Unchanged during the parity stages (table 7b keeps every
  legacy answer). The follow-ups after stage 7 add GS9105, GS9106, the
  duplicate-simple-name report, GS0546 where the emitter fell back to a host
  type, and GS9998 for malformed blobs and unlisted questions, and turn the
  fail-open probes fail-closed.
- **Overload resolution.** Candidate order and ties are unchanged for
  `WithReferences` compiles (table order before and after); host-backed sets
  are D3 of section 7d. Section 15's silent wrong answers are not corrected
  inside a parity stage (decision Q4).
- **Emitted metadata.** Identical to the `mlc` mode except the permitted
  differences D1 (row deduplication) and D2 (the `System.Runtime` `AssemblyRef`
  version) of section 7d, both from PR 5 and both in PR 6's release note.
- **Public API.** Stage 7 removes `TypeSymbol.ClrType`, `TypeSymbol.FromClrType`,
  `ImportedTypeSymbol.Type`/`OpenDefinition`, `ImportedFunctionSymbol.Method`,
  the reflection-typed members of the `Bound*Clr*` nodes,
  `FunctionSymbol.ExternalOverriddenMethod`/`ExplicitInterfaceSlot` and their
  property and event twins, `BaseConstructorInitializer.ClrConstructor`, and
  the `Assembly`- and `Type`-typed members of `ReferenceResolver`, replacing
  each with the symbol it wraps. In-repository consumers (`tools/gsgen` 22
  sites, the language server 38, tests 251 in 106 files) move in stage 6. This
  is a breaking change for external analyzers, recorded by the regenerated
  snapshot and the release notes (decision Q1); an analyzer that needs the CLR
  type loads the reference itself.
- **Language server.** Hover, completion and definition read the same
  symbols; the three `ClrType`-based helpers move to symbol queries. The
  persisted index of ADR-0107 is unchanged: `ReferenceMetadataIndex` holds
  names and fingerprints only and already reads through the #5166 reader.
- **REPL and `gsc` without `/out`.** Bind against images read from
  `Assembly.Location`; execution is unchanged (ADR-0156).

### 15. Pre-existing gaps the parity stages must not change silently

Found by the inventories; reproduced, not fixed, through stage 7 (decision
Q4). Each has or gets an issue and a corpus row that records today's answer;
where the handle model's natural answer differs (Q11, Q13) the legacy answer
sits behind the switch of table 7b. Filed with this ADR, each P2 until a repro
confirms it: #5174 (override slot identity), #5175 (inference bounds by name),
#5176 (unreadable constraints), #5177 (attributes never read from imports),
#5183 (fail-closed import failures).

- Override slot identity is token identity under MLC (`SameClrMethodSlot`,
  `ExpressionBinder.Access.MemberLookup.gs:5073-5085`); explicit
  implementations by name suffix (`:5340-5384`); `GetEffectiveAbstractSlots`
  ignores `MethodImpl` (`ExternalClrOverrideResolver.gs:285-326`).
- Raw `IsValueType` across contexts chooses boxing against reference
  conversion (`ClrOverloadResolution.gs:390, 427, 530`).
- Inference bounds keyed by the type parameter's `Name`
  (`ClrOverloadResolution.gs:8961-9050`).
- A failed constraint read treats the constraint as satisfied
  (`ClrOverloadResolution.gs:4141, 7509, 7760`).
- Owner matching of method generic parameters by token without module
  (`MemberLookup.gs:1914`; `ExternalClrOverrideResolver.gs:586`).
- Twelve attribute kinds never read from imports (`Obsolete`, `RequiredMember`,
  `SetsRequiredMembers`, `CompilerFeatureRequired`, `Dynamic`,
  `ParamCollection`, `InlineArray`, `Experimental`,
  `OverloadResolutionPriority`, `Caller*`, `CollectionBuilder`,
  `DefaultMember`; `KnownAttributes.TryGetObsolete` reads source only).
- Custom modifiers re-ordered or dropped (`SignatureEncoder.gs:757-808`);
  `TypedReference` encodes as a `VALUETYPE` `TypeRef`; an imported
  function-pointer `Type` falls through to a `TypeRef`.
- `InternalsVisibleTo` is matched by simple name without a public key.
- `Marshal.SizeOf` on an imported type always fails (`StructLayoutBinder.gs:224`).

### 16. Bootstrap and N-1

The change is ordinary library code under the pin (generic BCL interface
implementations, `ImmutableArray`, `ConcurrentDictionary`,
`ConditionalWeakTable`, `Interlocked.CompareExchange`, key classes,
`BlobReader`); no new language feature is used. The pinned compiler compiles
the new model and `src/Core`'s own 176-reference closure is the first consumer
of every stage, so a defect shows as a wrong compile of a consumer, caught by
the compare gate and Core.Tests under the stage-1 compiler. Stage-2
certification (ADR-0198) stays byte-identical once both compilers carry the
same stage, because the model is deterministic (section 12); across a pin move
the output differs only by D1 and D2 of section 7d, which the pin-move PR's
release note records (D2 only when the build host's runtime version differs
from the target's).

### 17. Performance expectations

Stated against the study's numbers and what the first layer measured:

- Hello world (`declarations` 195 ms after #5166): the `MetadataLoadContext`
  load (20 ms in the probe), the host-`typeof` projections and the first
  `GetMethods` on the types a one-line program touches go away; the rest is
  JIT and binder first-use (#5167), untouched here. Expected: `declarations`
  under 150 ms (the #5124 criterion #5166 did not reach), total under 330 ms
  from 375 ms.
- Core (18.3 s on the study host): the achievable gain is a part of the 16.8%
  reflection share, minus what #5162 and #5166 already removed without moving
  wall time. Measurable items: eager member construction and signature
  resolution (417 ms and 144 MiB for the whole closure in the probe), the
  `lock` in `ImportedTypeSymbol.Get` (1.9%), AQN key construction,
  `GetWrappedTypes` walks on erased shapes (9.8% of allocation in the 0.5.199
  profile), interned constructions (48,272 of 53,017 removed in the #5158
  prototype). Expected: 5 to 10% of Core wall time and a larger share of
  allocation; the study's 10 to 20% is the upper end and is not promised.
- Compiler worker (#5145): a warm request reuses the `ReferenceImageSet`; this
  is the gain the model is for, measured by #5145.

Every stage reports `build/compiler-bench.py` on Core, LanguageServer and
hello world against its base, with the reflection share from a sample profile.
**Kill criterion:** if after stage 4 the reflection share on Core has not
fallen and wall time has not improved outside noise, the maintainer decides
whether stages 5 to 7 proceed for the worker-reuse and correctness benefits.

### 18. Risks

- **A consumer or question the audit missed.** The conservative defaults
  (section 7: unlisted question is GS9998 with the site; section 7a: unmapped
  site keeps legacy behaviour) and the compare gate over Core, Core.Tests and
  Oahu find it before the oracle is removed; `mlc` stays selectable until
  stage 7 and the nightly apps run in `handles` from stage 5.
- **Public API break.** Its own PR, regenerated snapshot, release note, and
  the in-repository consumers moved first (decision Q1).
- **Memory growth** from sets pinned by process-wide caches until M5 moves
  them, or from a table that violates the ownership rule of 7c: the retention
  test of section 11, `build/lsp-soak.py` and the worker's retained-memory
  retirement rule; #5145 measures 50 requests.
- **Behaviour change hidden in a parity stage** (section 15, table 7b): a
  corpus row per gap pins today's answer; a change is a separate PR with a
  witness.
- **Decoder divergence from `MetadataLoadContext`'s reading of nullable
  bytes.** ADR-0193 §4's reader-agreement test is extended to the handle
  reader; the funnel members are shared, only the byte source changes.

### 19. Implementation plan (#5144)

Each PR passes both gates of section 7d with only the permitted differences
that have appeared by its stage (none before PR 5; D1 and D2 from PR 5; D3
from PR 6); `gsfmt --check` clean; targeted test filters locally, full suites
on CI; `build/compiler-bench.py` on the three cells; an ADR-0154 witness per
new behavioural test (a mutant in the decoder, the resolver or the intern
table, recorded in the PR). No PR before the follow-ups of table 7b changes a
diagnostic or a legacy answer (decision Q4).

| PR | Content | Acceptance beyond the gates |
| --- | --- | --- |
| 1 | `ReferenceImageSet`, `MetadataModule`, identities, name index moved onto the set (reusing `MetadataTypeNameReader`), `TypeRef`/forward resolution, `MissingTypeSymbol`, `WellKnownTypes`, the `GSHARP_METADATA_MODEL` switch and the `metadata.model-disagreements` counter. The set is built beside the MLC and compared on names. | Name index equal to reflection in order for Core's 178 assemblies (the #5166 test, re-pointed at the set); every `TypeRef` in the Core closure resolves to the same definition the MLC reaches by name, or is a listed missing type; `references.setup` not slower. |
| 2 | `MetadataTypeSymbol`, member symbols, `MetadataSignatureDecoder`, nullability and tuple-name application through the funnel, the `LayoutHostTypes` bridge, the adapter on `ImportedTypeSymbol`/`ImportedFunctionSymbol`, comparison mode for Q1 to Q10 and Q16 to Q19. **The generated corpus:** a test that enumerates every type and member of the Core, Core.Tests and Oahu closures and asserts, per question, that both models give the same canonical answer; it records today's answer for every row of table 7b and section 15, per resolver kind where the answer differs (Q11), and holds the overloaded-generic-owner, constructed-method (`M<int>()` against `M<string>()` with an unused `T`), struct-constrained `Nullable<T>`, D2 host/target mismatch, `/out`-without-`/reference` (D3 output, asserting that `System.Object`'s `TypeRef` scope stays the `System.Runtime` `AssemblyRef`), duplicate-simple-name (7b row Q1) and `StructLayout` cases. | GSA0007 green with the decoder's producers listed; `Adr0193` reader-agreement test extended; the retention test of section 11. Witness: a decoder mutant (drop `CMOD_OPT`, swap `NotAnnotated`/`Annotated`) is red. |
| 3 | Member lookup on symbols (Q6, Q11 with its legacy answers behind the switch, Q12, Q22, Q23, Q26, Q29). | `references.extension-holders` count unchanged or lower. |
| 4 | Overload resolution, conversions, inference, override resolution on symbols (Q13 with its legacy skip, Q14, Q15). Constraint checks are structural; no `MakeGenericType`. | Conformance suites green in `handles`; first-chance exceptions from import 0 (the #5157 counting hook); `compiler-bench.py` reflection share reported (kill criterion, section 17). |
| 5 | Emit on symbols: `SignatureEncoder`, `ImportedMemberRefFactory`, `CustomAttributeEncoder`, `NullableFlagsBuilder`, `UserTokenResolver`, `WellKnownReferences`; `MetadataTokenCache` keyed by symbols; comparers deleted. Introduces D1 and D2. | D1 and D2 evidence per 7d; the four legacy emitter encodings of section 13 are preserved behind the legacy-answers switch and checked by the corpus (#5183 replaces them after stage 7). |
| 6 | Remaining binder, lowering and symbol sites; the symbolic layout calculation (Q30); language server; `tools/gsgen`; `Default()` and `WithRuntimeReferences` on images. Introduces D3. | LanguageServer.Tests and Interpreter.Tests green in `handles`; `handles` becomes the default, `mlc` and `compare` stay selectable. The first PR whose output every user gets: it carries the release-notes bullet for D1 and D2 and the note that the next pin move is the first whose pinned compiler emits them for the repository's own build (section 16). |
| 7 | Public API change per section 14; delete the MLC path, the adapter accessors and the 21 `ClearCache` calls from `Dispose`; `gsharp-core-public-api.txt` regenerated (the ADR-0199 allowance test stays green: nothing is added); release note (breaking change). | Full CI green; `ResourceLeakRegressionTests` green; `lsp-soak` memory flat; `compiler-bench.py` final table against the stage-0 base. |

PR 2 adds a corpus row per row of table 7b and per section 15 gap; an issue
moves to P1 when its corpus row shows wrong code or a wrong diagnostic.

### 20. Open questions and the maintainer's decisions

The maintainer answered on 2026-10-23: the recommended option of each of Q1 to
Q7 stands, and for Q8 the house rule below applies. The maintainer accepted
the ADR as a whole on 2026-10-23; the implementation is #5144, then #5145.

1. **Public API break.** Remove the `System.Type` and `System.Reflection`
   members from the public surface in stage 7 (one release note, regenerated
   snapshot, external analyzers adapt), rather than keep a `Type`-producing
   adapter, which would keep `MetadataLoadContext` forever. **Decided: remove in stage 7.**
2. **Hosts without an image.** Read `Assembly.Location` for `Default()` and
   `WithRuntimeReferences` into the same set (section 5), rather than keep a
   reflection-backed module kind that would keep two models alive forever.
   **Decided: read the images into the same set.**
3. **Duplicate simple names in one reference set.** Keep first-writer-wins
   and report a diagnostic when a second module with the same simple name is
   loaded, rather than adopt Roslyn's version unification (bind to the
   highest version, `CS1702`-style warnings). **Decided: first-writer-wins
   plus the diagnostic**; the diagnostic is a new report, so it lands after
   stage 7 with #5183 (table 7b, row Q1), not in a parity stage.
4. **The pre-existing silent wrong answers of section 15.** Fix them after
   stage 7 in their own PRs, keeping each stage a parity stage. **Decided:
   after stage 7**; Q11 and Q13 keep their legacy answers behind a switch.
5. **`System.Runtime` `AssemblyRef` version from the reference set** rather
   than from the host, accepting the change on a host/target version mismatch
   (D2). **Decided: from the reference set; listed in PR 6's release note.**
6. **Custom modifier fidelity.** Keep today's encoder shape through stage 7
   rather than write modifiers in blob order now. **Decided: keep it**; the
   follow-up after stage 7 is #5229.
7. **Comparison mode in release builds.** Keep `GSHARP_METADATA_MODEL=compare`
   in the shipped `gsc` until stage 7, rather than debug-only. **Decided: keep it.**
8. **Diagnostic ids.** The maintainer has no preference and names the house
   rule: a user-facing diagnostic takes an open slot near the bottom of its
   category's used range, an internal one near the top. Both are
   reference-closure diagnostics ("Reference closure diagnostics (GS9100)" in
   `docs/diagnostics.md`) and take that category's next open slots; ADR-0040's
   paper reservations GS9101 to GS9104 (`yield` diagnostics that shipped under
   other ids) are left alone. **Assigned: GS9105** (error: a reference image
   cannot be read as a PE file with metadata; names the path) and **GS9106**
   (error: a selected member's signature names a type whose assembly is not
   in the reference set; names both and refers to GS9100). Both are free on
   `origin/main` at `081a72bd4` and in the open PR branches #5179, #5164,
   #5161 and #3737 (`git grep` on their heads). The #5183 PR adds them to
   `docs/diagnostics.md` and `DiagnosticDescriptors.gs` when it starts
   emitting them; until then the ids are reserved here.

## Consequences

### Positive

- Imported identity is the object: the AQN and load-context comparers, the
  erased-shape work-arounds and the `TypeBuilderInstantiation` probes go away;
  equal constructions are one symbol and the emitter's caches hit (#5158).
- Import cost is proportional to what the compile touches; no exception is an
  answer, and after the follow-ups every failure is a diagnostic.
- The reference set is reusable across compilations in one process (#5145);
  the language server stops depending on an unsafe `Dispose`; one decoder
  behind the ADR-0193 funnel; the compiler's own build benefits after the pin
  moves to a release carrying the model.

### Negative

- A release or more of staged work across the two largest files in the
  compiler and the emitter's reference factory, with two models in the tree
  until stage 7, and legacy answers kept behind a switch until the follow-ups.
- A public API break for analyzers and tools that read `ClrType` or
  `MethodInfo`.
- The deduplicated output changes PE bytes against the pinned compiler
  (accepted in #5158) and the `System.Runtime` version row (decision Q5).

### Neutral

- The persisted index (ADR-0107) and its invalidation rules are unchanged;
  binding, lowering and emit order are unchanged; consumers outside import see
  `TypeSymbol` objects with `ClrType == nil`, as they already do for
  source-declared types; analyzers and generators keep running code on runtime
  reflection.

## Alternatives considered

- **Keep `MetadataLoadContext` and add caches.** This is the first layer, and
  it is done: #5162 and #5166 moved the counters (section 2) with no Core
  wall-time change. The remaining cost is `System.Type`'s shape, which a cache
  in front of it cannot change, and a `Type`-bearing symbol cannot survive a
  worker request without its context.
- **Write our own `Type` subclass over `System.Reflection.Metadata`.**
  Rejected: it keeps the API shape that is the problem and every `Type`-typed
  public member.
- **Adopt Mono.Cecil or ILSpy's metadata library.** Rejected: a dependency
  for a reader the BCL already ships (`System.Reflection.Metadata` is what
  `MetadataLoadContext`, the emitter and #5166 use), with its own type model
  to adapt to `TypeSymbol`; ADR-0027's reason for a Roslyn-free compiler
  (owning the model) applies.
- **Roslyn's PE symbol model, as comparison.** `PEModuleSymbol`
  (`src/Compilers/CSharp/Portable/Symbols/Metadata/PE/`) wraps a `PEModule`
  over a `MetadataReader`; `PENamedTypeSymbol` is cached per
  `TypeDefinitionHandle` (`TypeHandleToTypeMap`); members load on first
  `GetMembers()` into a by-name dictionary in table order; `PEMethodSymbol`
  decodes its signature lazily through `MetadataDecoder`; attributes are
  decoded by name on demand; an unresolvable `TypeRef` is a
  `MissingMetadataTypeSymbol`, a malformed one an `UnsupportedMetadataTypeSymbol`,
  each reported at use; publication uses `Interlocked.CompareExchange`. All of
  that transfers. What does not: Roslyn compares types structurally and does
  not intern constructions (its emitter deduplicates rows itself; G#'s caches
  are identity-keyed, so this ADR interns); its `ReferenceManager` unifies
  assembly versions (`CS1701`/`CS1702`) where this ADR keeps first-writer
  (decision Q3); it memory-maps images, which #853 forbids here.
- **Keep `Type` on the public surface through a permanent shim.** Rejected
  as the default (decision Q1): it keeps `MetadataLoadContext` alive for
  every compilation to serve a few analyzer call sites.

## References and reproducibility

- Inventory script `inventory.py` (counts in section 1; run as
  `python3 -I inventory.py src/Core` at `c3cce6b81`) and the closure probe
  `closure-probe.cs` (a file-based C# program, `dotnet run closure-probe.cs --
  <rsp>`, over the 171 references of
  `out/obj/Gsharp.Extensions/Release/Gsharp.Extensions.rsp`; three runs,
  medians in section 2). Both sources are published in full in
  [a comment on PR #5173](https://github.com/DavidObando/gsharp/pull/5173#issuecomment-6356684287).
  The published text was copied back out, compiled and run (exit 0, same
  counts). They are not repository tools (the probe is C#, which
  `CONTRIBUTING.md` keeps out of the tree); the gate numbers for #5144 come
  from the tracked `build/compiler-bench.py`.
- Site inventories were taken by reading the files named in sections 7, 13
  and 15 at `c3cce6b81`; line numbers refer to that commit.
- Study tables: sections 4.2, 4.6, 4.7 and 5 of
  `docs/compiler-architecture-and-performance-study.md`; first-layer
  measurements: PRs #5162 and #5166 and issues #5158 and #5167.
