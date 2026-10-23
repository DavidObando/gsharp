# ADR-0209: Handle-backed imported symbols without `MetadataLoadContext`

- **Status**: Proposed
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

The public API carries the model too. 283 lines of
`test/Core.Tests/Baselines/gsharp-core-public-api.txt` name `System.Type` or a
`System.Reflection` member: `TypeSymbol.ClrType` (line 479),
`TypeSymbol.FromClrType(System.Type)` (460), `ImportedTypeSymbol.Type` and
`OpenDefinition`, `ImportedFunctionSymbol.Method`, every `Bound*Clr*` node
(`BoundClrCallExpression.Method`, `BoundClrIndexAssignmentExpression.Indexer`,
...), `FunctionSymbol.ExternalOverriddenMethod` and `ExplicitInterfaceSlot`,
and `ReferenceResolver` in full, including `Dispose`. Analyzers receive the
`Compilation` and so the resolver. `tools/gsgen` reads `ClrType` at 22 sites
(`GsToCSharpTypeSpeller.gs`, `GsStubRenderer.gs`); the language server at 38
(`BoundSemantics.gs`, `ImportedClrMemberResolver.gs`, `SemanticLookup.gs`).

Types declared in the compilation being built have no `System.Type`: their
`ClrType` is `nil` and the emitter encodes them symbolically. Where an imported
generic is closed over such a type, binding erases the argument to
`System.Object` and carries the real symbols beside the erased CLR shape
(`ImportedTypeSymbol.TypeArguments`, `HasSubstitutableTypeArgument`,
`ReifyClosedClrType`, `Symbols/ImportedTypeSymbol.gs:61-205`). No
`TypeBuilder` is created for a user type. The `TypeBuilderInstantiation`
guards (54 mentions) exist because the runtime manufactures that object
whenever a host `RuntimeType` definition is closed over a non-runtime argument:
`typeof(Func<,>)` closed over a context type in `FunctionTypeSymbol.gs:579-600`,
`typeof(ValueTuple<,>)` in `TupleTypeSymbol.gs:229-239`, `typeof(Dictionary<,>)`
in `MapTypeSymbol.gs` (#4023), and about 300 `typeof(` sites in `Emit/` that
rely on `MapClrTypeToReferences` (`ReferenceResolver.gs:673-766`) or
`TryProjectOntoReferences` (`ImportedMemberRefFactory.gs:2061-2090`) to project
a host type onto the reference set by name.

### 2. The measured problem

From the study (section 4.6, 4.7) and the first-layer PRs:

- `System.Reflection.*` frames are on the stack in 16.8% of main-thread
  samples of a Core compile (about 4.4 s of 26.3 s). `Monitor.Enter` under
  `ImportedTypeSymbol.Get` (`lock bucket.Gate`, `ImportedTypeSymbol.gs:252`) is
  1.9% on its own.
- 4,791 first-chance exceptions per Core compile were reflection probes that
  used a throw as the answer; #5156 cut them to 84 by testing
  `IsTypeBuilderInstantiation` and `IsMetadataLoadContextMember` first
  (`Symbols/ClrTypeUtilities.gs:296-306`). #5157 lists the remainder:
  `IsAssignableFrom` on a `TypeBuilderInstantiation`, `GetBaseDefinition` (which
  `MetadataLoadContext` never answers), `FileNotFoundException` from the one-hop
  transitive probe, `ReflectionTypeLoadException` from the name index.
- Identity is a string. `TypeIdentityComparer` keys the emitter's `TypeRefs`
  and `TypeSpecs` by `AssemblyQualifiedName` (`Emit/TypeIdentityComparer.gs:72-83`,
  `Emit/MetadataTokenCache.gs:54-55`); `LoadContextSensitiveTypeComparer` adds a
  walk that requires the same `Assembly` instance at every position (#3826,
  `Symbols/LoadContextSensitiveTypeComparer.gs:74-102`). Primitives are matched
  by `FullName` switch in `TypeSymbol.FromClrType` (`TypeSymbol.gs:220-276`),
  `SignatureEncoder.EncodeClrType` (`Emit/SignatureEncoder.gs:624-683`),
  `CustomAttributeEncoder` and `ConversionEmitter`; about 187 further sites
  compare `FullName` strings.
- Member enumeration is eager. `MetadataLoadContext` builds a `RoMethod` and
  resolves its signature for every member the first time `GetMethods` is
  called, and `ClrTypeUtilities.SafeEnumerate` then touches every signature
  type again to filter unloadable members (`ClrTypeUtilities.gs:384-415,
  1231-1257`).
- The decoded-signature cache (#5162) cut `metadata.contract-requests` from
  101,595 to 29,461 and raw decodes to 6,640 on Core, and allocation by 0.4%.
  Wall time did not change within noise. The metadata-name index (#5166) cut
  `references.type-name-index` from 135 ms to 17 ms on hello world and from
  189 ms to 12.5 ms on Core; Core wall time did not change measurably, and
  hello world's `declarations` phase is 195 ms, of which about 170 ms is now
  first-use cost outside any named phase (#5167).

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
are a floor for the API shape: the probe's provider returns an `int` per
node and allocates no symbol, so a decoder that builds `TypeSymbol`s pays for
the symbols it creates. The time comparison stands. The finding is that the cost
is the API shape, not the library: `MetadataLoadContext` is itself a reader
over `System.Reflection.Metadata`, but `System.Type`'s member API forces eager
member and signature construction, answers "not applicable" with an exception,
and offers only strings as identity. Decoding every signature in the closure
through handles costs less than the name index did before #5166.

### 3. What the first layer already delivered, and what it cannot

#5156 (probe guards), #5162 (signature cache keyed by the reflected member,
one decode per member and nullability mode, failed reads never cached) and
#5166 (`MetadataTypeNameReader`, the first handle-level reader in Core,
`Symbols/MetadataTypeNameReader.gs`) are the building blocks the study called
the first layer. #5158 prototyped interning of `ImportedTypeSymbol.GetConstructed`
and found it changes the emitted PE (138 fewer `MemberRef` rows, 154 fewer
`TypeSpec` rows on Core); the maintainer accepted the deduplicated output as
the new baseline. What the first layer cannot do while the model is
`System.Type`: give reference identity to definitions and constructions, stop
eager member construction, remove the string identity and the host-`typeof`
projection, remove the exception-as-answer probes that have no pre-check, or
let a reference set survive a compiler-worker request without carrying a
`MetadataLoadContext` whose `Type` objects every symbol points at.

### 4. Constraints

- **N-1.** Repository source uses only features the pinned release (0.5.212)
  compiles. Implementing a generic BCL interface such as
  `ISignatureTypeProvider[TType, TGenericContext]` is proven under the pin
  (`tools/cs2gs/Cs2Gs.Tests/Issue4777InheritedDataEqualityTranslationTests.gs:207`),
  as are struct-like reference keys (`Symbols/TypeArgsKey.gs`),
  `ConditionalWeakTable`, `ConcurrentDictionary` and `Lazy`.
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
  (`Binding/Binder.gs:8704`, `CompilationWorkBudget.gs:99`) and parallel emit
  (`Emit/FunctionEmitter.gs:119`); the language server hands one resolver to
  concurrent requests and never disposes it (`src/LanguageServer/ProjectState.gs:118-131,
  440-472`); `ReferenceResolver.Dispose` clears 21 process-wide caches
  (`ReferenceResolver.gs:233-285`), which is unsafe when another compilation
  in the process is live.
- **Hosts without an image.** `ReferenceResolver.Default()` and
  `WithRuntimeReferences` bind against host `RuntimeType` objects (REPL first
  cell, `gsc` without `/out`, language-server fallbacks, most tests). The
  `System.Private.CoreLib` to `System.Runtime` remap (`IsCoreLibBaseType`,
  `ImportedMemberRefFactory.gs:2007-2040`) exists for this path.

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
  ├── ConstructedTypeSymbol       interned per set by (definition, TypeArgsKey); arguments may be any TypeSymbol
  ├── MissingTypeSymbol           interned per set by (assembly identity, full name); the answer for an unresolvable TypeRef
  └── name index                  the #5166 reader, first writer wins in reference order
CompilationImportContext          per compilation: consumer assembly name, InternalsVisibleTo grants, semantic aggregates
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
  `(definition symbol, TypeArgsKey)`, interned in the set, exactly as
  `StructSymbol.Construct` interns source constructions. Arguments may be
  imported types, source types, type parameters or composites; the erased
  `List<object>` CLR shape and `ReifyClosedClrType` disappear, because the
  symbolic arguments are the only representation. Member signatures of a
  construction are the definition's decoded signatures substituted through a
  `TypeMap` (type parameter to argument), memoized per construction. This is
  the interning #5158 asked for, and the deduplicated output it produces is
  the accepted baseline.
- **One decoder.** `MetadataSignatureDecoder` implements
  `ISignatureTypeProvider[TypeSymbol, GenericContext]` and
  `ICustomAttributeTypeProvider[TypeSymbol]`. It produces nullability-free
  structure (`ArrayTypeSymbol`, `PointerTypeSymbol`, `ByRefTypeSymbol`,
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
  the decoder never returns a `MetadataTypeSymbol` for a type that has a
  process-wide symbol. `PrimitiveTypeCode` maps onto the built-ins directly;
  `System.Decimal` (a `VALUETYPE` `TypeRef` in a blob, not a primitive code)
  maps onto `TypeSymbol.Decimal`; `System.Nullable`1` over `V` maps onto
  `NullableTypeSymbol.Get(V)`; `System.ValueTuple`N` maps onto
  `TupleTypeSymbol`; the other `WellKnownTypes` entries map onto their
  composite symbols. Source binding reaches the same objects, so `List<decimal>`
  from a signature and from source is one interned construction. The emitter
  resolves a built-in or composite back to the set's definition through the
  table when it needs a `TypeRef`.
- **Hosts without an image.** `Default()` and `WithRuntimeReferences` read
  the image of each host assembly from `Assembly.Location` into the same
  `ReferenceImageSet`, so the REPL, `gsc` without `/out` and the tests bind
  against the same model as `gsc`. An assembly with no location (dynamic, or
  loaded from a stream) is not importable in the handle model; the two cases
  in the repository are REPL submissions, which are already written to disk
  before the next cell binds (`src/Repl/Engine/EmittedSessionEngine.gs:312-314`),
  and the `StructValue` layout helper, which is not a reference. The
  `System.Private.CoreLib` to `System.Runtime` remap stays as a rule of the
  `Default()` set only, since a reference pack never contains
  `System.Private.CoreLib`.

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
| Array | `ArrayTypeSymbol` (SZ), `RectangularArrayTypeSymbol` (rank, bounds) | `SZARRAY`, `ARRAY` |
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
| Q11 | Override slot identity (which base method does this override; explicit interface implementations) | `MethodImpl` rows, then the C# rule: walk the base chain for a `Virtual` method with the same name and substituted signature until `NewSlot` | none; an unresolvable base is M and the walk stops | `SameClrMethodSlot` degrades to token identity because `GetBaseDefinition` throws under MLC (`:5073-5085`; wrong for overrides); explicit implementations detected by a name-suffix heuristic (`:5340-5384`) |
| Q12 | Accessibility; `InternalsVisibleTo` grant to the consumer | `MethodAttributes`/`FieldAttributes`/`TypeAttributes` visibility; `InternalsVisibleTo` rows of the module against the `CompilationImportContext` | none | `ClrMemberVisibility.gs:37-171`; `GrantsInternalAccessTo` `ImportedAssemblySemantics.gs:241-268` (blanket catch denies) |
| Q13 | Generic type parameters: position, owner, constraints, variance, special constraints | `GenericParam`, `GenericParamConstraint`, `GenericParameterAttributes` | M per constraint type; the constraint is then unsatisfiable, not satisfied | `ClrOverloadResolution.gs:7393-7705`; a failed read `continue`s, which treats the constraint as satisfied (`:4141, 7509, 7760`) |
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
| Q25 | Which assembly a `TypeRef` resolution scope names at emit | the definition's module; forwards already resolved; the `System.Runtime` rule of the `Default()` set | none | `ImportedMemberRefFactory.gs:548-565`; host `System.Runtime` version (`:477-523`) |
| Q26 | Whole-assembly scans: extension holders, placeholder types for inference | `TypeDefinition` rows in table order; attributes by Q16 | none | `BuildImportedExtensionHolderIndex` `MemberLookup.gs:396-423`; `GetTypes().OrderBy(FullName)` `ClrOverloadResolution.gs:2488` |
| Q27 | Documentation comment for a member | documentation id built from the symbol | none | `AssemblyDocumentationProvider.Resolve(OpenDefinition ?? Type)` |
| Q28 | Display name | symbol printer | none | `RenderClrType` `TypeSymbol.gs:102` |

Questions that have no row and are not ported: `MetadataToken`+`Module` as
identity (Q11 replaces it), `AssemblyQualifiedName` keys (reference identity
replaces them), host `typeof(...)` projection (the `WellKnownTypes` table
replaces it), `IsAssignableFrom`, `GetBaseDefinition`, `GetInterfaceMap`,
`MakeGenericType` as a constraint oracle, and the fail-open probes
`ClrTypeMayHaveMember`, `ImportedExtensionMayApply` and
`HasExplicitClrInterfaceImplementation` (an exception never means "yes").

### 8. What stays on runtime reflection, and why

- **Executing code.** `EmittedProgramHost`, `InteractiveSessionHost` and the
  REPL value formatter load the emitted image into a collectible
  `AssemblyLoadContext` and invoke it (`Execution/EmittedProgramHost.gs:112-150`).
  Analyzer and generator hosts load analyzer assemblies into collectible
  contexts and run them (`Analyzers/GSharpAnalyzerHost.gs:34-131`,
  `tools/gsgen/GSharp.GeneratorHost/GeneratorRunner.gs:33-89`). Hot reload
  diffs images with `PEReader` and applies them with `MetadataUpdater` in the
  running process (`src/Sdk/Gsharp.HotReload.Runtime`). None of these imports
  symbols; none changes.
- **`StructValue.TryGetStorageSize`** defines a runtime type with
  `AssemblyBuilder.DefineDynamicAssembly` to measure a layout at host bitness
  (`StructValue.gs:258-325`). It is a layout oracle over host types, not an
  import; it stays, and a follow-up may compute sizes from `ClassLayout` and
  the target's pointer size instead.
- **The `MetadataLoadContext` oracle** stays in the tree until the comparison
  gate of the last stage passes, then is deleted (section 11).

### 9. Identity and equality

- A definition is reference-equal to itself and to nothing else. Two
  `ReferenceImageSet`s never share a symbol, so a symbol from one compilation
  cannot answer another's lookup (the #3826 defect is impossible by
  construction, with no comparer). Interning tables live on the set.
- A construction is reference-equal to the construction with the same
  definition object and the same argument objects (`TypeArgsKey`). Source
  constructions over imported definitions and imported constructions over
  source types use the one table.
- Cross-assembly identity: a `TypeRef` resolves to the definition in the
  module its `AssemblyRef` names, following `ExportedType` forwards; the
  resulting symbol is the destination's, so two references that reach the same
  type through different facades are one object. Today's emitted `TypeRef`
  scope is already the implementation assembly (`ImportedMemberRefFactory.gs:548-565`),
  so rows do not move.
- Two reference assemblies with the same simple name in one set: today the
  name index is first-writer-wins and `MetadataLoadContext` binds an
  `AssemblyRef` by simple name. The set keeps that rule (bind by simple name
  to the first module with that name, in reference order) and records a
  diagnostic when a second module with the same simple name is loaded, so the
  behaviour is stated rather than accidental. Roslyn's version unification is
  not adopted (open question 3).
- Same-compilation types as arguments of imported constructions need no
  erasure: `ConstructedTypeSymbol` holds the symbol. The emitter already
  encodes a symbolic parent (`TryNormalizeToSymbolicContainer`,
  `ImportedMemberRefFactory.gs:2339-2426`) and this becomes the only path.
- `TypeSymbol.ClrType` is `nil` for every handle-backed symbol. The public
  API consequences are in section 14.

### 10. The adapter and the comparison mode

The change lands behind the existing symbol API. `ImportedTypeSymbol`,
`ImportedFunctionSymbol`, `ImportedClassSymbol` and the `Bound*Clr*` nodes
keep their names; each gains a construction over a handle-backed symbol and
delegates to it. A consumer that still needs the reflection object asks the
adapter, which materializes it from the oracle `MetadataLoadContext` by name
(the warm-index path already does this, `ReferenceResolver.gs:955`). The
adapter is the migration seam: as each consumer family moves to symbol
queries, its reflection accessor loses its last caller and is deleted.

**Comparison mode** is a dual-resolver run. `GSHARP_METADATA_MODEL` selects
`mlc` (today), `handles` (the new model) or `compare`. In `compare`, every
question in section 7 is asked of both implementations through one
`ImportQuery` facade; the two answers are printed in a canonical form (display
string with nullability and modifiers, flags, accessibility, constant values,
member lists in order) and a disagreement is recorded with the question id,
the symbol and the asking site, in a counter
(`metadata.model-disagreements`) and a report file next to the phase JSON.
Parity is at the answer level: PE-byte parity is already relaxed by #5158's
deduplication, so the compare gate asks "did both models say the same thing
about every imported entity the compile touched", and the output gate asks
"is the PE identical except for the documented row deduplication".
`Issue5124TypeNameIndexTests.AssertIndexMatchesReflection` is the shape to
generalize: it already compares the metadata reader against reflection in
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
   binder's own; Q11 and Q15 become structural.
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

Stages 2 to 6 each run in all three modes; `compare` is the gate. The `mlc`
mode remains the default until stage 7.

### 11. Lifetime and memory

- `ReferenceImageSet` is immutable after construction and owns the `byte[]`
  images and readers. Symbols hold a strong reference to their module, and a
  module to its set, so no handle outlives its image; a set is released when
  the last compilation, symbol and cache entry that reaches it is collected.
  This is the ownership `MetadataLoadContext` `Type` objects have today,
  minus the explicit `Dispose`.
- The set is the consumer-independent partition of #5145: keyed by the
  ordered references with path, size, mtime and `MVID:SHA-256` (the ADR-0107
  fingerprint), it can be cached across compiler-worker requests and language-
  server rebuilds, with the memory bound the worker already enforces
  (`src/Compiler/WorkerProtocol.gs:12-17`). The consumer-dependent state
  (`CurrentAssemblyName`, the `InternalsVisibleTo` grant, the semantic
  aggregates `BuildSemanticAggregate` builds with that grant,
  `ImportedTypeSymbol.gs:455-461`) lives in `CompilationImportContext` and is
  never shared; a friend and a non-friend compilation over the same set see
  different aggregates by construction.
- `ReferenceResolver.Dispose` stops clearing the 21 process-wide caches. The
  interning tables that made that necessary (`NullableTypeSymbol`,
  `StructSymbol` constructions, `FunctionTypeSymbol`, ...) are keyed by
  symbols that belong to one set; they move onto the set or the compilation
  (study item M5, #5145 item 1) so nothing process-wide pins a set. Until
  they move, a set that is referenced from a process-wide cache stays alive
  with it, exactly as the `MetadataLoadContext` does today; this is a memory
  cost, not an identity defect.
- Host TPA images: today `SharedHostAssemblyBytes` keeps them process-wide
  and never evicts (`ReferenceResolver.gs:1133-1136`). The set keeps the same
  policy for the framework images (one copy per process, shared by every set
  that references the same file by path, size, mtime and fingerprint).
- Thread safety: slot publication by `Interlocked.CompareExchange`; interning
  through `ConcurrentDictionary.GetOrAdd` with a reference-equal struct key;
  per-member decode under a per-entry lock, as #5162 does, so concurrent
  first callers decode once; a decode that observed a `MissingTypeSymbol` or
  a blob error is stored (the answer is stable for the set), unlike today's
  retryable reflection failures, which the handle model does not have.
- Images stay `byte[]` (#853). Memory-mapping remains rejected (#5167). A
  `PEReader` over an `ImmutableArray[uint8]` view of the array is zero-copy
  (`MetadataTypeNameReader.gs:48`).

### 12. Determinism

Symbol slots are arrays indexed by row number; member lists are table order;
the name index is built in reference order with first writer wins (#5166
pins the order against reflection); intern tables are never enumerated;
overload candidate order is table order, as it is for `MetadataLoadContext`
today and was not for host `RuntimeType` members (where `GetMethods` order is
unspecified), so `Default()`-mode candidate order becomes stable. Row creation
order in emit follows the emitter's traversal, unchanged. Every stage adds a
repeat-run test: two compiles of Core by the same compiler are byte-identical.

### 13. Failure model

Today a missing or unreadable reference is a caught exception at the site
that happened to touch it: `IsMetadataLoadFailure` drops the member (73
sites), 64 blanket `catch` sites return `false`, `nil` or `true`, and the
emitter writes a wrong encoding in four places (`Object()` for an unknown
attribute parameter type, `CustomAttributeEncoder.gs:899-902`; `STRING` for an
unknown field type, `:2292-2295`; `int32` for an unknown enum underlying type,
`:2175-2188`; a host `typeof` when `TryResolveType` fails, `WellKnownReferences.gs:315-328`).

In the new model:

- An image that is not a PE file or has no metadata is a diagnostic at
  reference-set construction naming the path (today `MetadataLoadContext`
  throws `BadImageFormatException` at load).
- A `TypeRef` that resolves nowhere is a `MissingTypeSymbol`. It flows through
  signatures, so a member list is complete and overload resolution sees every
  candidate. A candidate whose selected signature position is missing reports
  a diagnostic at the use site that names the type and the assembly (the #340
  "under-referenced" condition the resolver already computes as
  `MissingTransitiveReferences`, `ReferenceResolver.gs:290-299`), and the
  compile fails instead of emitting a reference to a type the runtime cannot
  load. A candidate that is not selected costs nothing.
- A malformed signature or attribute blob (`BadImageFormatException` from the
  reader) is GS9998 with the module, the handle and the question; it is not a
  skipped member.
- A question outside section 7 is GS9998 (section 7, conservative default).
- Nothing is a silent fallback. The four emitter encodings above become
  diagnostics; `WellKnownTypes` misses report GS0546.

The remaining 84 first-chance exceptions of #5157 that come from import are
gone, because the model has no probe that throws; the `FileNotFoundException`
and `ReflectionTypeLoadException` of the transitive probe and the name index
are replaced by `MissingTypeSymbol` and the reader.

### 14. Compatibility and observable changes

- **Diagnostics.** Text of existing diagnostics is unchanged. New reports:
  the reference-set construction diagnostic, the missing-type diagnostic at a
  selected candidate, GS0546 where the emitter fell back to a host type, and
  GS9998 for malformed blobs and unlisted questions. The fail-open probes of
  section 7 become fail-closed, so a member that reflection could not load but
  the binder treated as "may exist" now resolves or reports.
- **Overload resolution.** Candidate order and ties are unchanged for
  `WithReferences` compiles (table order both before and after). `Default()`
  compiles gain a stable order. The silent wrong answers listed in section 15
  are pre-existing and are not corrected inside a parity stage (open question 4).
- **Emitted metadata.** Within a stage the output is identical to the `mlc`
  mode except for the deduplication #5158 accepted: `TypeRef` and `TypeSpec`
  rows are keyed by symbol identity (today AQN, equivalent), `MemberRef` rows
  by member symbol (today by `MethodInfo` object, which misses on equal
  constructions), `AssemblyRef` rows by identity (today by `Assembly` object,
  one row per object). Each stage's PR shows the per-table row-count change on
  Core and Core.Tests and that every removed row was a duplicate, and adds the
  release-notes bullet the #5158 decision requires. The `System.Runtime`
  `AssemblyRef` version is read from the reference set, not from the host
  (`ImportedMemberRefFactory.gs:477-523` reads `Assembly.Load("System.Runtime")`
  of the host today); this changes one row's version field on a build whose
  host runtime is newer than its target and is listed as an intentional
  change (open question 5).
- **Public API (ADR-0199).** Stage 7 removes `TypeSymbol.ClrType`,
  `TypeSymbol.FromClrType`, `ImportedTypeSymbol.Type`/`OpenDefinition`,
  `ImportedFunctionSymbol.Method`, the `MethodInfo`/`PropertyInfo`/`FieldInfo`/
  `EventInfo`/`ConstructorInfo`/`Type` members of the `Bound*Clr*` nodes,
  `FunctionSymbol.ExternalOverriddenMethod`/`ExplicitInterfaceSlot` and their
  property and event twins, `BaseConstructorInitializer.ClrConstructor`, and
  the `Assembly`-typed and `Type`-typed members of `ReferenceResolver`
  (`Assemblies`, `TryResolveType(out Type)`, `MapClrTypeToReferences`,
  `GetCoreType`), replacing each with the symbol it wraps. The in-repository
  consumers (`tools/gsgen` 22 sites, the language server 38 sites, tests 251
  sites in 106 files) move in stage 6. This is a breaking change for external
  analyzers, recorded by the regenerated snapshot and the release notes, and the
  reason stage 7 is its own PR (open question 1). An analyzer that needs the
  CLR type can still load the reference itself; the compiler no longer hands
  one out.
- **Language server.** Hover, completion and definition read the same
  symbols; the three `ClrType`-based helpers move to symbol queries. The
  persisted index of ADR-0107 is unchanged: `ReferenceMetadataIndex` holds
  names and fingerprints only and already reads through the #5166 reader.
- **REPL and `gsc` without `/out`.** Bind against images read from
  `Assembly.Location`; execution is unchanged (ADR-0156).

### 15. Pre-existing gaps the parity stages must not change silently

These were found by the inventories and are reproduced, not fixed, until the
compare gate for the affected stage passes; each has or gets an issue and a
corpus row that documents today's answer, and a later PR changes the answer
with a witness. Filed with this ADR: #5174 (override slot identity), #5175
(inference bounds by name), #5176 (unreadable constraints), #5177 (attributes
never read from imports); each is P2 until a repro confirms it.

- Override slot identity is token identity under MLC (`SameClrMethodSlot`,
  `ExpressionBinder.Access.MemberLookup.gs:5073-5085`); explicit interface
  implementations are detected by a name suffix (`:5340-5384`);
  `GetEffectiveAbstractSlots` ignores `MethodImpl` rows
  (`ExternalClrOverrideResolver.gs:285-326`).
- Raw `IsValueType` across contexts chooses boxing against reference
  conversion (`ClrOverloadResolution.gs:390, 427, 530`).
- Inference bounds are keyed by the type parameter's `Name`
  (`ClrOverloadResolution.gs:8961-9050`); a method `T` and a type `T` share a
  slot.
- A failed constraint read treats the constraint as satisfied
  (`ClrOverloadResolution.gs:4141, 7509, 7760`).
- Owner matching of method generic parameters by token without module
  (`MemberLookup.gs:1914`; `ExternalClrOverrideResolver.gs:586`).
- `[Obsolete]`, `[RequiredMember]`, `[SetsRequiredMembers]`,
  `[CompilerFeatureRequired]`, `[Dynamic]`, `[ParamCollection]`,
  `[InlineArray]`, `[Experimental]`, `[OverloadResolutionPriority]`, the
  `[Caller*]` family, `[CollectionBuilder]` and `[DefaultMember]` are never
  read from imported metadata (`KnownAttributes.TryGetObsolete` reads source
  attributes only).
- Custom modifiers: parameter modifiers are re-ordered required-then-optional,
  return modifiers are written only for void and by-ref returns, field
  modifiers are never written (`SignatureEncoder.gs:757-808`);
  `TypedReference` encodes as a `VALUETYPE` `TypeRef`; an imported
  function-pointer `Type` falls through to a `TypeRef`.
- `InternalsVisibleTo` is matched by simple name without a public key.
- `Marshal.SizeOf` on an imported type always fails (`StructLayoutBinder.gs:224`).

### 16. Bootstrap and N-1

The change is ordinary library code under the pin: generic BCL interface
implementations, `ImmutableArray`, `ConcurrentDictionary`,
`ConditionalWeakTable`, `Interlocked.CompareExchange`, struct-like key classes,
`BlobReader`. No new language feature is used or needed. The compiler compiles
itself, so `src/Core`'s own 176-reference closure is the first consumer of
every stage, and the pinned compiler is the one that compiles the new model;
a defect in the new model shows as a wrong compile of a consumer, caught by
the compare gate and by Core.Tests under the stage-1 compiler. Stage-2
certification (ADR-0198) compares `GSharp.Core.dll` and `gsc.dll` built by the
pinned compiler and by the stage-1 compiler; because the model is
deterministic by construction (section 12) and changes emitted rows only
through the documented deduplication, the stage-2 comparison stays
byte-identical once both compilers carry the same stage. Across a pin move the
output differs only by the deduplication, which the pin-move PR's release note
records.

### 17. Performance expectations

Stated against the study's numbers and what the first layer measured:

- Hello world (`declarations` 195 ms after #5166, of which `type-name-index`
  17 ms and `namespace-index` 23 ms): the `MetadataLoadContext` load (20 ms in
  the probe), the host-`typeof` projections and the first `GetMethods` on the
  types a one-line program touches go away. The rest of the 195 ms is JIT and
  binder first-use (#5167), which this ADR does not touch. Expected:
  `declarations` under 150 ms (the #5124 criterion #5166 did not reach), total
  hello world under 330 ms from 375 ms.
- Core (18.3 s on the study host, bodies 57%): the achievable gain is a part
  of the 16.8% of samples with a reflection frame, minus what #5162 and #5166
  already removed without moving wall time. The eager member construction and
  signature resolution (417 ms and 144 MiB for the whole closure in the probe;
  Core touches a fraction of it many times), the `lock` in
  `ImportedTypeSymbol.Get` (1.9%), AQN key construction, `GetWrappedTypes`
  walks on erased shapes (9.8% of allocation in the 0.5.199 profile) and the
  interning of constructions (48,272 of 53,017 constructions removed in the
  #5158 prototype) are the measurable items. Expected: 5 to 10% of Core wall
  time and a larger share of allocation; the study's 10 to 20% is the upper
  end and is not promised.
- Compiler worker (#5145): a warm request reuses the `ReferenceImageSet`, so
  the per-request cost falls to the compilation-owned state. This is the
  gain the model is for; it is measured by #5145, not here.
- Memory: no `RoType` graph; one array of slots per module; constructions
  interned once.

Every stage reports `build/compiler-bench.py` on Core, LanguageServer and
hello world against its base, with the reflection share from a sample profile.
**Kill criterion:** if after stage 4 (binder consumers on symbols) the
reflection share of main-thread samples on Core has not fallen and wall time
has not improved outside noise, the maintainer decides whether stages 5 to 7
proceed for the worker-reuse and correctness benefits alone.

### 18. Risks

- **A question the inventory missed.** Mitigation: the conservative default
  (section 7) turns it into a GS9998 with the site, and the compare gate over
  Core, Core.Tests and Oahu finds it before the oracle is removed.
- **The compare gate passes but a reference set outside the three corpora
  differs.** Mitigation: the `mlc` mode stays selectable until stage 7; the
  nightly apps run (`cs2gs-apps-nightly`) and the conformance suites run in
  `handles` mode from stage 5.
- **Public API break.** Mitigation: its own PR, regenerated snapshot, release note,
  and the in-repository consumers moved first; open question 1.
- **Memory growth** from sets pinned by process-wide caches until M5 moves
  them. Mitigation: `build/lsp-soak.py` and the worker's retained-memory
  retirement rule stay in force; #5145 measures 50 requests.
- **Behaviour change hidden in a parity stage** (section 15). Mitigation: a
  corpus row per gap pins today's answer; a change is a separate PR with a
  witness.
- **Decoder divergence from `MetadataLoadContext`'s reading of nullable
  bytes.** Mitigation: ADR-0193 §4's reader-agreement test is extended to the
  handle reader; the funnel members are shared, only the byte source changes.

### 19. Implementation plan (#5144)

Each PR: representation-preserving unless stated; `gsfmt --check` clean;
targeted test filters locally, full suites on CI; `build/compiler-bench.py`
on the three cells; an ADR-0154 witness per new behavioural test (a mutant in
the decoder, the resolver or the intern table, recorded in the PR).

| PR | Content | Acceptance |
| --- | --- | --- |
| 1 | `ReferenceImageSet`, `MetadataModule`, identities, name index moved onto the set (reusing `MetadataTypeNameReader`), `TypeRef`/forward resolution, `MissingTypeSymbol`, `WellKnownTypes`, the `GSHARP_METADATA_MODEL` switch and the `metadata.model-disagreements` counter. The set is built beside the MLC and compared on names. | Name index equal to reflection in order for Core's 178 assemblies (the #5166 test, re-pointed at the set); every `TypeRef` in the Core closure resolves to the same definition the MLC reaches by name, or is a listed missing type; output byte-identical; `references.setup` not slower. |
| 2 | `MetadataTypeSymbol`, member symbols, `MetadataSignatureDecoder`, nullability and tuple-name application through the funnel, the adapter on `ImportedTypeSymbol`/`ImportedFunctionSymbol`, comparison mode for Q1 to Q10 and Q16 to Q19. **The generated corpus:** a test that enumerates every type and member of the Core, Core.Tests and Oahu closures and asserts, per question, that both models give the same canonical answer; the corpus file lists today's answers for the section 15 gaps. | Zero disagreements on the three closures; GSA0007 green with the decoder's producers listed; `Adr0193` reader-agreement test extended; output byte-identical in `mlc` and `compare` modes. Witness: a decoder mutant (drop `CMOD_OPT`, swap `NotAnnotated`/`Annotated`) is red. |
| 3 | Member lookup on symbols (Q6, Q11, Q12, Q22, Q23, Q26). | Zero disagreements; `references.extension-holders` count unchanged or lower; output identical except documented deduplication. |
| 4 | Overload resolution, conversions, inference, override resolution on symbols (Q13, Q14, Q15). Constraint checks are structural; no `MakeGenericType`. | Zero disagreements; conformance suites green in `handles`; first-chance exceptions from import 0 (the #5157 counting hook); `compiler-bench.py` reflection share reported (kill criterion, section 17). |
| 5 | Emit on symbols: `SignatureEncoder`, `ImportedMemberRefFactory`, `CustomAttributeEncoder`, `NullableFlagsBuilder`, `UserTokenResolver`, `WellKnownReferences`; `MetadataTokenCache` keyed by symbols; comparers deleted. Intentional output change (#5158). | Per-table row-count change shown on Core and Core.Tests, each removed row a duplicate; ILVerify green; conformance green; repeat-run determinism; release-notes bullet; the four silent encodings of section 13 are diagnostics with tests. |
| 6 | Remaining binder, lowering and symbol sites; language server; `tools/gsgen`; `Default()` and `WithRuntimeReferences` on images. | Zero disagreements; LanguageServer.Tests and Interpreter.Tests green in `handles`; `handles` becomes the default, `mlc` stays selectable. |
| 7 | Public API change per section 14; delete the MLC path, the adapter accessors and the 21 `ClearCache` calls from `Dispose`; `gsharp-core-public-api.txt` regenerated (the ADR-0199 allowance test stays green: nothing is added); release note (breaking change). | Full CI green; `ResourceLeakRegressionTests` green; `lsp-soak` memory flat; `compiler-bench.py` final table against the stage-0 base. |

PR 2 adds a corpus row per section 15 gap and files the issues that section
15 does not already name; an issue moves to P1 when its corpus row shows wrong
code or a wrong diagnostic (override identity, raw `IsValueType`, inference
bound names, skipped constraints).

### 20. Open questions for the maintainer

1. **Public API break.** Remove the `System.Type` and `System.Reflection`
   members from the public surface in stage 7 (recommended; one release note,
   regenerated snapshot, external analyzers adapt), or keep a `Type`-producing
   adapter on the public surface, which means the `MetadataLoadContext` is
   never retired and the model pays for both.
2. **Hosts without an image.** Read `Assembly.Location` for `Default()` and
   `WithRuntimeReferences` (recommended, section 5), or keep a reflection-
   backed module kind for those resolvers. The second keeps two models alive
   forever.
3. **Duplicate simple names in one reference set.** Keep first-writer-wins
   with a new diagnostic (recommended), or adopt Roslyn's version unification
   (bind to the highest version, report `CS1702`-style warnings).
4. **The pre-existing silent wrong answers of section 15.** Fix them in the
   stage that touches the site, with the compare gate accepting the listed
   rows as intentional differences, or fix them after stage 7 in their own
   PRs (recommended; keeps each stage a parity stage).
5. **`System.Runtime` `AssemblyRef` version from the reference set** rather
   than the host (section 14). Accept the one-row change, or keep the host
   version until a separate decision.
6. **Custom modifier fidelity.** Write modifiers in blob order on every
   position (changes output where today's encoder re-orders or drops them;
   exact C# parity), or keep today's shape through stage 7 and change it
   afterwards (recommended for parity).
7. **Comparison mode in release builds.** Keep `GSHARP_METADATA_MODEL=compare`
   available in the shipped `gsc` until stage 7 (recommended; a user who
   hits a divergence can produce the report), or make it debug-only.
8. **Diagnostic ids.** The reference-set construction diagnostic and the
   missing-type-at-selected-candidate diagnostic need ids; PR 1 assigns the
   next free numbers in `docs/diagnostics.md`.

## Consequences

### Positive

- Imported identity is the object. The AQN comparer, the load-context
  comparer, the `TypeArgsKey` work-arounds for erased shapes and the
  `TypeBuilderInstantiation` probes go away; equal constructions are one
  symbol and the emitter's caches hit (the #5158 gain lands as a side effect).
- Import cost is proportional to what the compile touches: a type that is
  never named is a row that is never read; a member that is never selected is
  never decoded.
- No exception is an answer. The 84 remaining first-chance exceptions of
  #5157 that come from import are gone, and every failure is a diagnostic
  that names the type and the assembly.
- The reference set is reusable across compilations in one process, which is
  what #5145 needs to turn shared compilation on by default, and the language
  server's long-lived resolver stops depending on a `Dispose` that is unsafe
  to call.
- One decoder behind the ADR-0193 funnel; the nullability producers are
  fewer, not more.
- The compiler's own build (176 references) is the first beneficiary once
  the pin moves to a release carrying the model.

### Negative

- A release or more of staged work across the two largest files in the
  compiler (`ClrOverloadResolution.gs`, `MemberLookup.gs`) and the emitter's
  reference factory, with two models in the tree until stage 7.
- A public API break for analyzers and tools that read `ClrType` or
  `MethodInfo`.
- The deduplicated output changes PE bytes against the pinned compiler
  (accepted in #5158) and the `System.Runtime` version row (open question 5).
- `StructValue`'s layout oracle keeps a Reflection.Emit dependency until a
  follow-up computes layouts from metadata.

### Neutral

- The persisted index (ADR-0107) and its invalidation rules are unchanged.
- Binding, lowering and emit order are unchanged; the symbol API consumers
  outside import see the same `TypeSymbol` objects with `ClrType == nil`,
  which is what they already see for source-declared types.
- Analyzers and generators keep running code on runtime reflection.

## Alternatives considered

- **Keep `MetadataLoadContext` and add caches.** This is the first layer, and
  it is done: #5162 removed 70% of the raw decodes and 0.4% of allocation with
  no wall-time change; #5166 took the name index from 135 ms to 17 ms with no
  Core wall-time change. The remaining cost is `System.Type`'s shape (eager
  member construction, exceptions as answers, string identity), which a cache
  in front of it cannot change, and a `Type`-bearing symbol cannot survive a
  worker request without its context.
- **Write our own `Type` subclass over `System.Reflection.Metadata`** (an
  in-house `RoType`). Rejected: it keeps the API shape that is the problem,
  keeps `IsAssignableFrom`, `GetBaseDefinition` and `MakeGenericType` as the
  questions, and keeps every `Type`-typed public member.
- **Adopt Mono.Cecil or ILSpy's metadata library.** Rejected: a dependency
  for a reader the BCL already ships (`System.Reflection.Metadata` is what
  `MetadataLoadContext`, the emitter and #5166 use), with its own type model
  to adapt to `TypeSymbol`; ADR-0027's reason for a Roslyn-free compiler
  (owning the model) applies.
- **Roslyn's PE symbol model, as comparison.** Roslyn's `PEAssemblySymbol`
  and `PEModuleSymbol` (`src/Compilers/CSharp/Portable/Symbols/Metadata/PE/`)
  wrap a `PEModule` over a `MetadataReader`; `PENamedTypeSymbol` is created
  per `TypeDefinitionHandle` and cached in `PEModuleSymbol.TypeHandleToTypeMap`
  (a `ConcurrentDictionary`); members are loaded on first `GetMembers()`
  (`EnsureAllMembersAreLoaded`, a by-name dictionary built from table order);
  `PEMethodSymbol` decodes its signature lazily (`LoadSignature`) through
  `MetadataDecoder`, which implements the signature provider; attributes are
  decoded on demand by name (`PEModule.HasAttribute`, `FindTargetAttribute`);
  an unresolvable `TypeRef` is a `MissingMetadataTypeSymbol` and a malformed
  one an `UnsupportedMetadataTypeSymbol`, each reported at use; publication
  uses `Interlocked.CompareExchange`. What transfers: the per-handle cache,
  lazy members and signatures, the single decoder, decoding attributes by
  name, the missing and unsupported symbols, interlocked publication, and
  identity by object. What does not: Roslyn compares types structurally
  (`TypeSymbol.Equals(TypeCompareKind)`) and does not intern constructions,
  because its emitter deduplicates rows itself; G#'s emitter caches are
  identity-keyed, so this ADR interns. Roslyn's `ReferenceManager` unifies
  assembly versions and reports `CS1701`/`CS1702`; this ADR keeps the
  first-writer rule (open question 3). Roslyn memory-maps images
  (`ModuleMetadata.CreateFromFile`); #853 forbids it here.
- **Memory-map images instead of copying.** Rejected in #5167: a mapped file
  holds a handle and blocks `CopyRefAssembly` (#853).
- **Keep `Type` on the public surface through a permanent shim.** Rejected
  as the default (open question 1): it keeps `MetadataLoadContext` alive for
  every compilation to serve a few analyzer call sites.

## References and reproducibility

- Inventory script and outputs: `~/.cache/metadata-adr/inventory.py`,
  `inventory-core-main.txt` (counts in section 1; run as
  `python3 -I inventory.py src/Core` at `c3cce6b81`).
- Closure probe: `~/.cache/metadata-adr/exp/closure-probe.cs`, a file-based
  C# program (`dotnet run closure-probe.cs -- <rsp>`) over the 171 references
  of `out/obj/Gsharp.Extensions/Release/Gsharp.Extensions.rsp`; three runs,
  medians in section 2. It is a probe of the two API shapes, not of `gsc`.
- Site inventories (binder and emitter) were taken by reading the files named
  in sections 7, 13 and 15 at `c3cce6b81`; line numbers refer to that commit.
- Study tables: sections 4.2, 4.6, 4.7 and 5 of
  `docs/compiler-architecture-and-performance-study.md`; first-layer
  measurements: PRs #5162 and #5166 and issues #5158 and #5167.
