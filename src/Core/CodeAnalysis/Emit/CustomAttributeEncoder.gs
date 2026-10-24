// <copyright file="CustomAttributeEncoder.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import System.Collections.Generic
import System.Globalization

/// PR-E-12: custom-attribute blob encoder. Owns every helper that writes an
/// ECMA-335 II.23.3 `CustomAttribute` value blob plus the
/// per-attribute orchestration that maps a (cref:BoundAttribute)
/// onto a constructor and named-argument pair.
/// @remarks Methods moved here from (cref:ReflectionMetadataEmitter) in
/// PR-E-12:
///
/// - `EmitBoundAttribute` — entry point for emitting a single bound user attribute (resolves ctor,
/// encodes fixed and named args, attaches the row to the supplied parent).
/// - `EmitUserAttributes` — convenience iterator that filters a symbol's bound attributes by target
/// kind and forwards each match to `EmitBoundAttribute`.
/// - `EmitStringAttribute` — fixed-shape single-string attribute emitter (used by the assembly-level
/// orchestrators on the root).
/// - `EmitIsReadOnlyAttributeOnParameter` — emits a parameter-level `IsReadOnlyAttribute` row using the
/// well-known ctor reference.
/// - `NextParameterHandle` — small helper that returns the next (cref:ParameterHandle) the metadata
/// builder will allocate; lives here because attribute emission is the dominant consumer (it must be
/// threaded into every `AddMethodDefinition` call so the Param-table runs stay monotone — see issue
/// #170).
///
/// Plus the private static blob-encoding helpers:
/// `ResolveAttributeConstructor`, `ArgAssignable`,
/// `NormalizeWellKnownType`, `IsTriviallyConvertible`,
/// `EncodeClrTypeForCtorSig`, `WriteCustomAttributeFixedArg`,
/// `WriteCustomAttributeArrayArg`, `GetSerializedTypeName`,
/// `GetEnumUnderlyingTypeSafe`, `WriteCustomAttributeNamedArg`,
/// `WriteCustomAttributeFieldOrPropertyType`.
///
/// The assembly-level orchestrators
/// (`EmitReferenceAssemblyAttribute`,
/// `EmitAssemblyInteropAttributes`, `EmitDebuggableAttribute`,
/// `EmitNullableContextAttribute`) moved onto
/// (cref:AssemblyAttributeEmitter) in PR-E-13: they are called once
/// each from `EmitCore` and forward into this encoder for the actual
/// blob writes.
internal class CustomAttributeEncoder {
    private let emitCtx EmitContext
    private let wellKnown WellKnownReferences
    private let getTypeReference(Type) -> TypeReferenceHandle
    private let resolvePrimaryCtorToken((StructSymbol) -> EntityHandle)?
    private let resolveDefaultCtorToken((StructSymbol) -> EntityHandle)?
    private let resolveExplicitCtorToken((StructSymbol, ConstructorSymbol) -> EntityHandle)?

    init(
        emitCtx EmitContext,
        wellKnown WellKnownReferences,
        getTypeReference(Type) -> TypeReferenceHandle,
        resolvePrimaryCtorToken((StructSymbol) -> EntityHandle)? = nil,
        resolveDefaultCtorToken((StructSymbol) -> EntityHandle)? = nil,
        resolveExplicitCtorToken((StructSymbol, ConstructorSymbol) -> EntityHandle)? = nil
    ) {
        this.emitCtx = emitCtx ?? throw ArgumentNullException("emitCtx")
        this.wellKnown = wellKnown ?? throw ArgumentNullException("wellKnown")
        this.getTypeReference = getTypeReference ?? throw ArgumentNullException("getTypeReference")
        this.resolvePrimaryCtorToken = resolvePrimaryCtorToken
        this.resolveDefaultCtorToken = resolveDefaultCtorToken
        this.resolveExplicitCtorToken = resolveExplicitCtorToken
    }

    private enum AttributeConstructorArgumentForm {
        Normal,
        Defaulted,
        ParamsExpanded
    }

    /// Emits a fixed-shape custom attribute whose constructor takes a single
    /// (cref:string) argument, used by assembly-level helpers such as
    /// `EmitReferenceAssemblyAttribute` and the AssemblyInfo emitters.
    func EmitStringAttribute(parent EntityHandle, typeName string, fallbackType Type, value string) {
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(typeName, requireExternalVisibility: false, out var resolved) {
            resolved!!
        } else {
            fallbackType
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            1,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> p.AddParameter().Type().String()
        )
        let ctorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001) // Prolog
        valueBlob.WriteSerializedString(value)
        valueBlob.WriteUInt16(0) // NumNamed
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    func EmitStringPairAttribute(
        parent EntityHandle,
        typeName string,
        fallbackType Type,
        firstValue string,
        secondValue string
    ) {
        let attrType = if this
            .emitCtx
            .References
            .TryResolveType(typeName, requireExternalVisibility: false, out var resolved) {
            resolved!!
        } else {
            fallbackType
        }
        let attrTypeRef = this.getTypeReference(attrType)
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            2,
            (r ReturnTypeEncoder) -> r.Void(),
            (p ParametersEncoder) -> {
                p.AddParameter().Type().String()
                p.AddParameter().Type().String()
            }
        )
        let ctorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001) // Prolog
        valueBlob.WriteSerializedString(firstValue)
        valueBlob.WriteSerializedString(secondValue)
        valueBlob.WriteUInt16(0) // NumNamed
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    func EmitIsReadOnlyAttributeOnParameter(paramHandle ParameterHandle) {
        let ctorRef = this.wellKnown.GetIsReadOnlyAttributeCtorRef()
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: paramHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// ADR-0101 / issue #799: emits a parameter-level
    /// (cref:System.ParamArrayAttribute) row using the well-known ctor
    /// reference. Stamped on the last (variadic) parameter of every
    /// G#-authored variadic function so the metadata signature is
    /// indistinguishable from a C#-authored `params T[]` method.
    /// @param paramHandle The Param row to attach the attribute to.
    func EmitParamArrayAttributeOnParameter(paramHandle ParameterHandle) {
        let ctorRef = this.wellKnown.GetParamArrayAttributeCtorRef()
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: paramHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// ADR-0173 / issue #3627: emits
    /// `System.Runtime.CompilerServices.ParamCollectionAttribute` on a
    /// Param row — the C#13 params-collections marker for a variadic
    /// parameter whose carrier is a non-array collection. Silently no-ops
    /// when the attribute type can't be resolved (pre-.NET 9 TFMs).
    /// @param paramHandle The Param row to attach the attribute to.
    func EmitParamCollectionAttributeOnParameter(paramHandle ParameterHandle) {
        let ctorRef = this.wellKnown.GetParamCollectionAttributeCtorRef()
        if ctorRef.IsNil {
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: paramHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Issue #1354: emits a per-field
    /// `System.Runtime.CompilerServices.NullableAttribute` on a Field row
    /// when [`type`](paramref) has at least one position that deviates from
    /// the non-null default (i.e. the computed flags array contains a byte other
    /// than (cref:NullableFlagsBuilder.NotAnnotated)). All-non-null
    /// reference fields rely on the enclosing type's `NullableContextAttribute(1)`
    /// instead, matching the compact C#/Roslyn emit shape and keeping round-trip
    /// fidelity (importer reads non-null via the type-chain context walk).
    /// @param fieldHandle The Field row to attach the attribute to.
    /// @param type The field's declared type.
    func EmitNullableAttributeOnField(fieldHandle FieldDefinitionHandle, type TypeSymbol) {
        let flags = NullableFlagsBuilder.Build(type)
        if ShouldEmitPerPositionNullable(flags) {
            this.EmitNullableAttributeOnEntity(fieldHandle, flags)
        }
        // ADR-0172 Phase B: every per-field slot-metadata pass also carries
        // tuple element names when the declared type has any.
        this.EmitTupleElementNamesAttribute(fieldHandle, type)
    }

    /// ADR-0172 Phase B: emits
    /// `System.Runtime.CompilerServices.TupleElementNamesAttribute(string[])`
    /// on a Param / Field / Property row when [`type`](paramref) declares
    /// at least one tuple element name anywhere in its tree (flattened DFS
    /// pre-order, null entries for unnamed positions — the C# encoding).
    /// Silently no-ops when no name exists or the attribute type can't be
    /// resolved (very old TFMs).
    /// @param parent The metadata row to attach the attribute to.
    /// @param type The declared parameter / return / field / property type.
    func EmitTupleElementNamesAttribute(parent EntityHandle, type TypeSymbol) {
        let names = TupleElementNamesBuilder.Build(type)
        if names.IsDefaultOrEmpty {
            return
        }
        let ctorRef = this.wellKnown.GetTupleElementNamesAttributeCtorRef()
        if ctorRef.IsNil {
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteInt32(names.Length)
        for name in names {
            valueBlob.WriteSerializedString(name)
        }
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Issue #1354: emits a per-property
    /// `System.Runtime.CompilerServices.NullableAttribute` on a Property row
    /// under the same "deviates from non-null default" condition as
    /// (cref:EmitNullableAttributeOnField). Properties have no dedicated
    /// return-parameter row, so the attribute lands on the Property row itself
    /// (mirrors `ClrNullability.GetPropertyTypeSymbol`'s read path).
    /// @param propertyHandle The Property row to attach the attribute to.
    /// @param type The property's declared type.
    func EmitNullableAttributeOnProperty(propertyHandle PropertyDefinitionHandle, type TypeSymbol) {
        let flags = NullableFlagsBuilder.Build(type)
        if ShouldEmitPerPositionNullable(flags) {
            this.EmitNullableAttributeOnEntity(propertyHandle, flags)
        }
        // ADR-0172 Phase B: see EmitNullableAttributeOnField.
        this.EmitTupleElementNamesAttribute(propertyHandle, type)
    }

    /// ADR-0186 §8: emits a per-event
    /// `System.Runtime.CompilerServices.NullableAttribute` on an Event row
    /// under the same "deviates from non-null default" condition as
    /// (cref:EmitNullableAttributeOnField). The Event row is where the
    /// import side reads an event's handler nullability
    /// (`MemberLookup.ApplyEventDeclarationNullability` reads
    /// `ClrNullability.ReadNullableFlags` off the event), and it is where
    /// csc writes it; before ADR-0186 step 5 gsc wrote nothing there, so an
    /// event's handler type re-imported through the type-level
    /// `[NullableContext(1)]` as wholly non-null — an `@Oblivious`
    /// event came back non-null, and so did the `string?` in an
    /// `Action[string?]` handler.
    /// @param eventHandle The Event row to attach the attribute to.
    /// @param type The event's declared handler type.
    func EmitNullableAttributeOnEvent(eventHandle EventDefinitionHandle, type TypeSymbol) {
        let flags = NullableFlagsBuilder.Build(type)
        if ShouldEmitPerPositionNullable(flags) {
            this.EmitNullableAttributeOnEntity(eventHandle, flags)
        }
    }

    /// Issue #4988: stamps a method signature's nullability exactly as
    /// [`plan`](paramref) decided it — the method-level
    /// `[NullableContext]`, then a `[Nullable]` on each Param row whose
    /// bytes differ from that context. Every MethodDef-minting path calls this,
    /// so whether a position keeps its annotation can no longer depend on which
    /// declaration path produced the method.
    /// @param methodHandle The MethodDef the signature belongs to.
    /// @param plan The signature's plan.
    /// @param returnRow The sequence-0 Param row; required when (cref:MethodNullabilityPlan.ReturnNeedsAttribute).
    /// @param parameterRows The parameter rows, one per (cref:MethodNullabilityPlan.ParameterFlags) entry.
    /// @exception InvalidOperationException The caller did not mint the rows the plan needs. Dropping the
    /// annotation silently is what #4988 was, so a path that forgets the row fails loudly instead.
    func EmitMethodNullability(
        methodHandle MethodDefinitionHandle,
        plan MethodNullabilityPlan,
        returnRow ParameterHandle?,
        parameterRows ImmutableArray[ParameterHandle]
    ) {
        if parameterRows.Length != plan.ParameterFlags.Length {
            throw InvalidOperationException(
                "Invariant violated: a nullability plan for ${plan.ParameterFlags.Length} parameter(s) was applied to ${parameterRows.Length} Param row(s)."
            )
        }
        if plan.ReturnNeedsAttribute && returnRow == nil {
            throw InvalidOperationException(
                "Invariant violated: the return position needs [Nullable] but no sequence-0 Param row was minted for it."
            )
        }
        if plan.ContextByteToEmit is uint8 contextByte {
            this.EmitNullableContextAttributeOnMethod(methodHandle, contextByte)
        }
        if returnRow is {} returnHandle && plan.ReturnNeedsAttribute {
            this.EmitNullableAttributeOnEntity(returnHandle, plan.ReturnFlags)
        }
        for var i = 0; i < parameterRows.Length; i++ {
            if plan.ParameterNeedsAttribute(i) {
                this.EmitNullableAttributeOnEntity(parameterRows[i], plan.ParameterFlags[i])
            }
        }
    }

    private func EmitNullableAttributeOnEntity(parent EntityHandle, flags ImmutableArray[uint8]) {
        if flags.IsDefaultOrEmpty {
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        var ctorRef EntityHandle
        if flags.Length == 1 {
            ctorRef = this.wellKnown.GetNullableAttributeByteCtorRef()
            if ctorRef.IsNil {
                return
            }
            valueBlob.WriteByte(flags[0])
        } else {
            ctorRef = this.wellKnown.GetNullableAttributeByteArrayCtorRef()
            if ctorRef.IsNil {
                return
            }
            valueBlob.WriteInt32(flags.Length)
            for b in flags {
                valueBlob.WriteByte(b)
            }
        }
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Issue #834: emits
    /// `System.Runtime.CompilerServices.NullableContextAttribute()`
    /// on a MethodDef row to declare the method-level default nullability
    /// context (per-position `NullableAttribute` rows only need to cover
    /// positions that deviate from this default).
    /// @param methodHandle The MethodDef row to attach the attribute to.
    /// @param flag The nullability flag (0/1/2).
    func EmitNullableContextAttributeOnMethod(methodHandle MethodDefinitionHandle, flag uint8) {
        let ctorRef = this.wellKnown.GetNullableContextAttributeByteCtorRef()
        if ctorRef.IsNil {
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteByte(flag)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: methodHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Issue #1354: emits
    /// `System.Runtime.CompilerServices.NullableContextAttribute()`
    /// on a TypeDef row to declare the type-level default nullability context.
    /// This is the linchpin of gsc→gsc round-trip: the metadata importer's
    /// `ReadNullableFlags` fallback walks the `DeclaringType` chain, so a
    /// non-null reference field/property emitted with no per-position
    /// `[NullableAttribute]` is re-read as non-null only when this type-level
    /// context is present (otherwise, post-#1354, the absence would read as
    /// nullable). Mirrors what C#/Roslyn emits on every nullable-aware type.
    /// @param typeHandle The TypeDef row to attach the attribute to.
    /// @param flag The nullability flag (0/1/2).
    func EmitNullableContextAttributeOnType(typeHandle TypeDefinitionHandle, flag uint8) {
        let ctorRef = this.wellKnown.GetNullableContextAttributeByteCtorRef()
        if ctorRef.IsNil {
            return
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        valueBlob.WriteByte(flag)
        valueBlob.WriteUInt16(0)
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: typeHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Phase 3 of #141 / ADR-0047 §3: emits a `CustomAttribute` row for
    /// every bound user annotation on [`symbol`](paramref) whose target
    /// matches [`filter`](paramref). Resolves the attribute type to a
    /// CLR (cref:Type), picks a constructor matching the supplied
    /// positional argument arity / element types, writes the ECMA-335 II.23.3
    /// value blob (prolog `0x0001`, fixed args, named-arg count, named
    /// args), and attaches it to [`parent`](paramref).
    /// Attributes whose CLR type can't be resolved or whose ctor cannot be
    /// matched are silently skipped — the binder owns user-facing diagnostics.
    /// @remarks Pseudo-custom attributes (`@DllImport`, `@LibraryImport`,
    /// `@StructLayout`, `@FieldOffset`) are always skipped — they
    /// are written into dedicated metadata-table rows (ImplMap,
    /// ClassLayout, FieldLayout) by other emit paths, and duplicating them
    /// as `CustomAttribute` rows would create a misleading reflection
    /// view (see (cref:KnownAttributes.IsPseudoCustomAttribute)).
    /// @param parent The metadata entity (TypeDef / MethodDef / ...) to attach the attribute to.
    /// @param symbol The symbol carrying the bound annotation list.
    /// @param filter Only attributes whose (cref:BoundAttribute.Target) equals this kind are emitted.
    func EmitUserAttributes(parent EntityHandle, symbol Symbol, filter AttributeTargetKind) {
        if symbol?.Attributes.IsDefaultOrEmpty != false {
            return
        }
        for attr in symbol.Attributes {
            if attr.Target != filter {
                continue
            }
            if KnownAttributes.IsPseudoCustomAttribute(attr) {
                continue
            }
            this.EmitBoundAttribute(parent, attr)
        }
    }

    /// Variant of (cref:EmitUserAttributes) that skips any attribute
    /// matching [`excludePredicate`](paramref). Used historically by
    /// the P/Invoke emitter (ADR-0086 / issue #727) to elide the
    /// `@DllImport` attribute itself; the universal pseudo-custom
    /// filter on (cref:EmitUserAttributes) now covers
    /// `@DllImport`, `@LibraryImport`, `@StructLayout`, and
    /// `@FieldOffset` automatically, so this overload is retained
    /// only for callers that need additional, narrower exclusion logic.
    /// @param parent The metadata entity (TypeDef / MethodDef / ...) to attach the attributes to.
    /// @param symbol The symbol carrying the bound annotation list.
    /// @param filter Only attributes whose (cref:BoundAttribute.Target) equals this kind are considered.
    /// @param excludePredicate Attributes for which this predicate returns `true` are skipped.
    func EmitUserAttributesExcept(
        parent EntityHandle,
        symbol Symbol,
        filter AttributeTargetKind,
        excludePredicate((BoundAttribute) -> bool)?
    ) {
        if symbol?.Attributes.IsDefaultOrEmpty != false {
            return
        }
        for attr in symbol.Attributes {
            if attr.Target != filter {
                continue
            }
            if KnownAttributes.IsPseudoCustomAttribute(attr) {
                continue
            }
            if excludePredicate != nil && excludePredicate(attr) {
                continue
            }
            this.EmitBoundAttribute(parent, attr)
        }
    }

    /// Returns the next (cref:ParameterHandle) that will be assigned by
    /// the next call to (cref:MetadataBuilder.AddParameter). Issue #170:
    /// every `AddMethodDefinition` call must thread this value into its
    /// `parameterList` argument so the Param table's per-method runs stay
    /// monotone — methods that emit no parameter rows must share the same
    /// "next" handle, and methods that emit N rows anchor the run that follows.
    func NextParameterHandle() ParameterHandle -> MetadataTokens.ParameterHandle(
        this.emitCtx.Metadata.GetRowCount(TableIndex.Param) + 1
    )

    func EmitBoundAttribute(parent EntityHandle, attr BoundAttribute) {
        // Issue #1921: a same-compilation user class deriving from
        // System.Attribute (accepted by GS0200 via
        // StructSymbol.DerivesFromSystemAttribute) has no ClrType until
        // emitted — the CLR-reflection path below can't resolve its
        // constructor. Mirror that path symbolically instead so a plain
        // `@Note("x")` on a user `NoteAttribute` round-trips into a real
        // CustomAttribute row the same way a BCL attribute does.
        if attr.AttributeType is StructSymbol userAttrType && userAttrType.ClrType == nil {
            this.EmitUserBoundAttribute(parent, userAttrType, attr)
            return
        }
        let clrType Type? = attr.AttributeType.ClrType
        if clrType == nil {
            return
        }
        // Type.FullName is null for a constructed generic whose type argument
        // has no full name of its own -- reachable via the C#11-style generic
        // attribute application in DeclarationBinder.Attributes.cs. That is a
        // resolve FAILURE, not a reason to skip the attribute: TryResolveType
        // already returned false for a null name (its first statement is an
        // IsNullOrEmpty check) and the emit continued against the raw CLR type.
        // Returning here instead silently dropped the CustomAttribute row.
        let fullName string? = clrType.FullName
        if fullName == nil ||
            !this
            .emitCtx
            .References
            .TryResolveType(fullName, requireExternalVisibility: false, out var resolved) {
            resolved = clrType
        }
        let ctor ConstructorInfo? = ResolveAttributeConstructor(
            resolved!!,
            attr,
            out var effective,
            out var memberArguments
        )
        if ctor == nil {
            // Issue #4097: "no candidate matched" is the right ANSWER for this
            // program; treating it as "nothing to emit" was the bug. Dropping
            // the row here compiled clean, IL-verified and ran, and the
            // annotation the author wrote was simply absent from the metadata.
            // That silence is how issue #4073's `Type[]` half stayed invisible.
            EmitDiagnosticException.ThrowAttributeConstructorNotFound(
                attr.Syntax,
                attr.AttributeType.Name,
                DescribeArgumentList(attr.PositionalArguments)
            )
        }
        let ctorParams = ctor!!.GetParameters()
        let ctorSig = BlobBuilder()
        BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true).Parameters(
            ctorParams.Length,
            (r ReturnTypeEncoder) -> r.Void(),
            (ps ParametersEncoder) -> {
                for p in ctorParams {
                    this.EncodeClrTypeForCtorSig(ps.AddParameter().Type(), p.ParameterType)
                }
            }
        )
        let attrTypeRef = this.getTypeReference(resolved!!)
        let ctorRef = this
            .emitCtx
            .MetadataRows
            .AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig)
        )
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001)
        for var i = 0; i < ctorParams.Length; i++ {
            // Normalize to the executing runtime's Type so the reference-equality
            // checks in the value-blob writer succeed even when the attribute was
            // resolved through a MetadataLoadContext (e.g. third-party packages).
            let writeType = NormalizeWellKnownType(ctorParams[i].ParameterType)
            WriteCustomAttributeFixedArg(valueBlob, writeType!!, effective[i])
        }
        valueBlob.WriteUInt16(uint16(memberArguments.Length))
        for arg in memberArguments {
            WriteCustomAttributeNamedArg(valueBlob, resolved!!, arg)
        }
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: parent,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Issue #1921: emits a `CustomAttribute` row for an attribute whose
    /// resolved type is a same-compilation (cref:StructSymbol) (no
    /// `ClrType` yet — it hasn't been emitted). Selects the
    /// primary or an explicit constructor by exact arity against
    /// [`attr`](paramref)'s positional arguments (the same "match the
    /// constructor shape" step (cref:ResolveAttributeConstructor) does
    /// for CLR types, minus params-array expansion, which no G# constructor
    /// declaration can express) and writes the fixed-argument blob using each
    /// parameter's own (always-primitive-or-string, hence already-resolved)
    /// `TypeSymbol.ClrType`.
    /// @remarks Named (property/field) arguments are intentionally NOT supported for
    /// user-defined attribute types here: (cref:WriteCustomAttributeNamedArg)
    /// resolves the target member's CLR type via `Type.GetProperty`/
    /// `Type.GetField` reflection, which is unavailable for a type
    /// that hasn't been emitted yet. Reimplementing that against
    /// (cref:StructSymbol) fields/properties (including nested-enum
    /// underlying types, (cref:System.Type) arguments, etc.) is a
    /// separate, considerably larger feature than closing the GS0200
    /// recognition gap this issue is about. Named arguments on a
    /// same-compilation user attribute are now rejected at bind time (GS0466,
    /// see `DeclarationBinder.BindAttribute`), so [`attr`](paramref)
    /// never carries any by the time it reaches the emitter — this method
    /// only ever writes `NumNamed = 0`.
    private func EmitUserBoundAttribute(parent EntityHandle, attributeType StructSymbol, attr BoundAttribute) {
        if !this.TryResolveUserAttributeConstructor(
            attributeType,
            attr,
            out var ctorToken,
            out var paramTypes,
            out var effectiveArguments,
            out var unsupportedParameter
        ) {
            // Issue #4097: both failure modes used to drop the row silently.
            // They are genuinely different and must not share one message. An
            // invalid PARAMETER type means the attribute DECLARATION is
            // ill-formed — measured: every shape that reaches here is one csc
            // rejects as CS0181 — so the arguments are not what to talk about
            // (GS0584). Anything else means no constructor accepts what was
            // written (GS0583).
            if unsupportedParameter is {} offending {
                EmitDiagnosticException.ThrowAttributeConstructorParameterTypeNotSupported(
                    attr.Syntax,
                    offending.Name,
                    attributeType.Name,
                    offending.Type?.Name ?? "?"
                )
            }
            EmitDiagnosticException.ThrowAttributeConstructorNotFound(
                attr.Syntax,
                attributeType.Name,
                DescribeArgumentList(attr.PositionalArguments)
            )
        }
        let valueBlob = BlobBuilder()
        valueBlob.WriteUInt16(0x0001) // Prolog
        for var i = 0; i < paramTypes!!.Length; i++ {
            let writeType = NormalizeWellKnownType(paramTypes!![i])
            WriteCustomAttributeFixedArg(valueBlob, writeType!!, effectiveArguments!![i])
        }
        valueBlob.WriteUInt16(0) // NumNamed — see remarks above.
        this
            .emitCtx
            .Metadata
            .AddCustomAttribute(
            parent: parent,
            constructor: ctorToken,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob)
        )
    }

    /// Selects the primary or an explicit constructor of [`attributeType`](paramref)
    /// whose arity matches [`attr`](paramref)'s positional argument count
    /// AND whose parameter types actually accept the supplied argument values
    /// (the same (cref:ArgAssignable) check (cref:ResolveAttributeConstructor)
    /// uses for CLR-imported attribute types), returning the already-correct
    /// emit-ready (cref:EntityHandle) for it (a bare `MethodDef`,
    /// or — for a constructed generic attribute type — a `MemberRef`
    /// parented at the constructed TypeSpec; both cases are handled by the
    /// injected resolver delegates, the same ones used for `newobj` against a
    /// user constructor). Returns `false` when no arity match
    /// exists or a parameter's type has no (cref:TypeSymbol.ClrType)
    /// (an as-yet-unemitted user type used as an attribute constructor
    /// parameter — unsupported, same as the CLR path bailing out when it
    /// can't resolve a parameter type). Throws (cref:EmitDiagnosticException)
    /// (surfaced as GS9998) when two or more same-arity explicit constructors
    /// both accept the supplied arguments — overload resolution has no way to
    /// silently guess which one the user meant (issue #1921 code review).
    private func TryResolveUserAttributeConstructor(
        attributeType StructSymbol,
        attr BoundAttribute,
        out ctorToken EntityHandle,
        @NotNullWhen(true) out paramTypes[]?Type,
        @NotNullWhen(true) out effectiveArguments[]?object?,
        out unsupportedParameter ParameterSymbol?
    ) bool {
        let argCount = attr.PositionalArguments.Length
        ctorToken = default(EntityHandle)
        paramTypes = nil
        effectiveArguments = nil
        unsupportedParameter = nil
        var sawProjectableCandidate = false
        var positionalConflict BoundAttributeArgument? = nil
        ValidateUniqueNamedConstructorArguments(attr)
        for useDefaults in[]bool{false, true} {
            if attributeType.HasPrimaryConstructor && this.resolvePrimaryCtorToken != nil {
                if !TryMapUserAttributeConstructorArgumentSlots(
                    attributeType.PrimaryConstructorParameters,
                    attr,
                    out var slots,
                    out var usedDefault,
                    out var conflict
                ) {
                    positionalConflict ??= conflict
                } else if usedDefault == useDefaults {
                    if !TryGetClrParameterTypes(
                        attributeType.PrimaryConstructorParameters,
                        out paramTypes,
                        out var offending
                    ) {
                        unsupportedParameter = offending
                    } else {
                        // A by-reference parameter keeps no narrowing across a call (ADR-0208 R12).
                        let resolvedTypes = paramTypes
                        SawProjectable(&sawProjectableCandidate)
                        if TryBuildUserAttributeConstructorArguments(slots, resolvedTypes, out effectiveArguments) {
                            ctorToken = this.resolvePrimaryCtorToken!!(attributeType)
                            return true
                        }
                        // Issue #4097: a primary constructor was previously
                        // accepted on arity alone, allowing an argument type
                        // mismatch to reach the blob writer as GS9998.
                        paramTypes = nil
                    }
                }
            }
            if this.resolveExplicitCtorToken != nil {
                var matchedCtor ConstructorSymbol? = nil
                var matchedParamTypes[]?Type = nil
                var matchedArguments[]?object? = nil
                var ambiguousCtor ConstructorSymbol? = nil
                for ctor in attributeType.EffectiveExplicitConstructors {
                    if !TryMapUserAttributeConstructorArgumentSlots(
                        ctor.Parameters,
                        attr,
                        out var slots,
                        out var usedDefault,
                        out var conflict
                    ) {
                        positionalConflict ??= conflict
                        continue
                    }
                    if usedDefault != useDefaults {
                        continue
                    }
                    if !TryGetClrParameterTypes(ctor.Parameters, out var candidateParamTypes, out var offending) {
                        unsupportedParameter ??= offending
                        continue
                    }
                    sawProjectableCandidate = true
                    if !TryBuildUserAttributeConstructorArguments(
                        slots,
                        candidateParamTypes,
                        out var candidateArguments
                    ) {
                        continue
                    }
                    if matchedCtor != nil {
                        ambiguousCtor = ctor
                        break
                    }
                    matchedCtor = ctor
                    matchedParamTypes = candidateParamTypes
                    matchedArguments = candidateArguments
                }
                if ambiguousCtor != nil {
                    EmitDiagnosticException.Throw(
                        attr.Syntax,
                        "Ambiguous constructor for attribute '${attributeType.Name}': more than one 'init(...)' overload accepts the given arguments. Add an explicit conversion or change the argument types to disambiguate."
                    )
                }
                if matchedCtor != nil && matchedParamTypes != nil && matchedArguments != nil {
                    ctorToken = this.resolveExplicitCtorToken!!(attributeType, matchedCtor)
                    paramTypes = matchedParamTypes
                    effectiveArguments = matchedArguments
                    return true
                }
            }
        }
        if sawProjectableCandidate {
            // Review feedback on PR #4137: an unprojectable parameter was
            // recorded before applicability was settled. If some other
            // layout-applicable constructor projected fine and the argument
            // types simply did not match it, the author's problem is the
            // arguments (GS0583), not a parameter type on a constructor that
            // was never going to be chosen (GS0584). Clearing the record here
            // keeps GS0584 when every layout-applicable candidate failed to
            // project.
            unsupportedParameter = nil
        }
        if positionalConflict != nil {
            EmitDiagnosticException.ThrowDiagnostic(
                positionalConflict.Syntax ?? attr.Syntax,
                DiagnosticDescriptors.NamedArgumentAlsoSpecifiedPositionally,
                positionalConflict.Name,
                positionalConflict.Name
            )
        }
        if argCount == 0 && this.resolveDefaultCtorToken != nil {
            try {
                ctorToken = this.resolveDefaultCtorToken(attributeType)
            } catch (InvalidOperationException) {
                // No emitted default ctor (e.g. an attribute class declared
                // with only explicit `init(...)` constructors) — nothing
                // else to try for a zero-arg application.
                return false
            }
            paramTypes = Array.Empty[Type]()
            effectiveArguments = Array.Empty[object?]()
            return true
        }
        paramTypes = nil
        effectiveArguments = nil
        return false
    }

    private func EncodeClrTypeForCtorSig(enc SignatureTypeEncoder, t Type) {
        if t.IsSameAs(typeof(bool)) {
            enc.Boolean()
        } else if t.IsSameAs(typeof(char)) {
            enc.Char()
        } else if t.IsSameAs(typeof(int8)) {
            enc.SByte()
        } else if t.IsSameAs(typeof(uint8)) {
            enc.Byte()
        } else if t.IsSameAs(typeof(int16)) {
            enc.Int16()
        } else if t.IsSameAs(typeof(uint16)) {
            enc.UInt16()
        } else if t.IsSameAs(typeof(int32)) {
            enc.Int32()
        } else if t.IsSameAs(typeof(uint32)) {
            enc.UInt32()
        } else if t.IsSameAs(typeof(int64)) {
            enc.Int64()
        } else if t.IsSameAs(typeof(uint64)) {
            enc.UInt64()
        } else if t.IsSameAs(typeof(float32)) {
            enc.Single()
        } else if t.IsSameAs(typeof(float64)) {
            enc.Double()
        } else if t.IsSameAs(typeof(string)) {
            enc.String()
        } else if t.IsSameAs(typeof(object)) {
            enc.Object()
        } else if t.IsEnum {
            // Issue #3892: this is the METHOD SIGNATURE of the attribute's
            // `.ctor` MemberRef, not the custom-attribute VALUE blob. ECMA-335
            // II.23.3 says the *value* of an enum-typed fixed argument is
            // serialised as its underlying type — that rule is applied by
            // WriteCustomAttributeFixedArg below and is correct there. It does
            // NOT apply to the signature: II.23.2.12 requires the parameter to
            // be encoded as VALUETYPE <TypeRef to the enum>. Substituting the
            // underlying type here produced `AttributeUsageAttribute..ctor(Int32)`,
            // a MemberRef the runtime cannot resolve — so any type carrying such
            // an attribute threw MissingMethodException the moment reflection
            // touched it (xunit discovery enumerating GetExportedTypes()).
            enc.Type(this.getTypeReference(t), isValueType: true)
        } else if t.IsArray && t.GetArrayRank() == 1 {
            // ECMA-335 II.23.2.12: SZARRAY element-type for a single-dimensional array parameter.
            this.EncodeClrTypeForCtorSig(enc.SZArray(), t.GetElementType()!!)
        } else if t.IsSameAs(typeof(Type)) {
            // System.Type parameter: encoded as a CLASS type reference in the ctor signature.
            enc.Type(this.getTypeReference(typeof(Type)), isValueType: false)
        } else {
            // Fallback: encode as object so the signature is still well-formed.
            enc.Object()
        }
    }

    private func WriteCustomAttributeFixedArg(bb BlobBuilder, paramType Type, value object?) {
        var value = value
        if value is BoundAttributeArgument argument {
            if paramType.IsSameAs(typeof(object)) &&
                (argument.Type is EnumSymbol || argument.Type.ClrType?.IsEnum == true) &&
                TryGetAttributeParameterWriteType(argument.Type, out var enumType) {
                // A boxed enum's tag names the enum, not its integer payload.
                bb.WriteByte(0x55)
                bb.WriteSerializedString(this.GetSerializedTypeName(argument.Type))
                this.WriteCustomAttributeFixedArg(bb, enumType!!, argument.Value)
                return
            }
            let arrayElement TypeSymbol? = switch argument.Type {
                case slice is SliceTypeSymbol: slice.ElementType
                case array is ArrayTypeSymbol: array.ElementType
                default: default(TypeSymbol?)
            }
            if paramType.IsSameAs(typeof(object)) &&
                (arrayElement is EnumSymbol || arrayElement?.ClrType?.IsEnum == true) &&
                TryGetAttributeParameterWriteType(arrayElement, out var elementWriteType) {
                // The array's runtime container stores integers, but its boxed
                // metadata tag must retain the source enum element identity.
                bb.WriteByte(0x1D)
                bb.WriteByte(0x55)
                bb.WriteSerializedString(this.GetSerializedTypeName(arrayElement!!))
                this.WriteCustomAttributeArrayArg(bb, elementWriteType!!, argument.Value)
                return
            }
            if paramType.IsSameAs(typeof(object)) &&
                arrayElement != nil &&
                TryGetAttributeParameterWriteType(argument.Type, out var arrayWriteType) &&
                arrayWriteType!!.IsArray &&
                arrayWriteType!!.GetArrayRank() == 1 {
                // A widened runtime container still carries the source array
                // type in the wrapper (for example Type[] stored as object[]
                // because it contains a same-compilation TypeSymbol).
                WriteCustomAttributeFieldOrPropertyType(bb, arrayWriteType!!)
                this.WriteCustomAttributeFixedArg(bb, arrayWriteType!!, argument.Value)
                return
            }
            value = argument.Value
        }
        if paramType.IsEnum {
            WriteCustomAttributeFixedArg(bb, GetEnumUnderlyingTypeSafe(paramType), value)
            return
        }
        if paramType.IsSameAs(typeof(bool)) {
            bb.WriteByte(
                if object.Equals(value, true) {
                    uint8(1)
                } else {
                    uint8(0)
                }
            )
        } else if paramType.IsSameAs(typeof(char)) {
            let charValue = Convert.ToUInt16(value, CultureInfo.InvariantCulture)
            bb.WriteByte(uint8(charValue))
            bb.WriteByte(uint8((int32(charValue) >> 8)))
        } else if paramType.IsSameAs(typeof(int8)) {
            bb.WriteSByte(Convert.ToSByte(value))
        } else if paramType.IsSameAs(typeof(uint8)) {
            bb.WriteByte(Convert.ToByte(value))
        } else if paramType.IsSameAs(typeof(int16)) {
            bb.WriteInt16(Convert.ToInt16(value))
        } else if paramType.IsSameAs(typeof(uint16)) {
            bb.WriteUInt16(Convert.ToUInt16(value))
        } else if paramType.IsSameAs(typeof(int32)) {
            bb.WriteInt32(Convert.ToInt32(value))
        } else if paramType.IsSameAs(typeof(uint32)) {
            bb.WriteUInt32(Convert.ToUInt32(value))
        } else if paramType.IsSameAs(typeof(int64)) {
            bb.WriteInt64(Convert.ToInt64(value))
        } else if paramType.IsSameAs(typeof(uint64)) {
            bb.WriteUInt64(Convert.ToUInt64(value))
        } else if paramType.IsSameAs(typeof(float32)) {
            bb.WriteSingle(Convert.ToSingle(value))
        } else if paramType.IsSameAs(typeof(float64)) {
            bb.WriteDouble(Convert.ToDouble(value))
        } else if paramType.IsSameAs(typeof(string)) {
            bb.WriteSerializedString(cast[string?](value))
        } else if paramType.IsSameAs(typeof(Type)) {
            // ECMA-335 II.23.3: a System.Type argument is encoded as a
            // SerString carrying the canonical type-name. A null Type
            // serialises as the SerString null marker (0xFF).
            bb.WriteSerializedString(
                switch value {
                    case t is Type: GetSerializedTypeName(t)
                    case symbol is TypeSymbol: this.GetSerializedTypeName(symbol)
                    default: default(string?)
                }
            )
        } else if paramType.IsArray && paramType.GetArrayRank() == 1 {
            WriteCustomAttributeArrayArg(bb, paramType.GetElementType()!!, value)
        } else if paramType.IsSameAs(typeof(object)) {
            // ECMA-335 II.23.3: boxed object argument carries the
            // FieldOrPropType tag of the runtime type then the value.
            if value == nil {
                // Null object: encode as STRING null marker per common practice.
                WriteCustomAttributeFieldOrPropertyType(bb, typeof(string))
                bb.WriteSerializedString(nil)
            } else {
                let runtimeType = if (value is Type or TypeSymbol) {
                    typeof(Type)
                } else {
                    value.GetType()
                }
                WriteCustomAttributeFieldOrPropertyType(bb, runtimeType)
                WriteCustomAttributeFixedArg(bb, runtimeType, value)
            }
        } else {
            // Fallback: serialise as string round-trip (best-effort).
            bb.WriteSerializedString(value?.ToString())
        }
    }

    private func WriteCustomAttributeArrayArg(bb BlobBuilder, elementType Type, value object?) {
        // ECMA-335 II.23.3: an SZARRAY argument is encoded as an Int32 length
        // (or 0xFFFFFFFF for a null array) followed by length elements of
        // FixedArg(elementType).
        if value == nil {
            bb.WriteUInt32(0xFFFFFFFFu)
            return
        }
        let array = cast[Array](value)
        bb.WriteInt32(array.Length)
        for var i = 0; i < array.Length; i++ {
            WriteCustomAttributeFixedArg(bb, elementType, array.GetValue(i))
        }
    }

    /// Issue #4073: writes the assembly-qualified name of a SYMBOLIC
    /// `typeof` argument, recursing through every structural position so a
    /// constructed generic names its real arguments.
    /// @remarks This used to be one line — the type's own metadata name plus the
    /// assembly under compilation — which is correct for a scalar
    /// same-compilation type and wrong for everything else. A constructed
    /// generic's DEFINITION usually lives in a referenced assembly while its
    /// arguments live here, so a single trailing assembly name cannot describe
    /// it; and the definition needs its arity suffix and an argument list, which
    /// a constructed (cref:StructSymbol) could not supply because it
    /// carries its arguments on `TypeArguments` and leaves
    /// `TypeParameters` empty (so the suffix computed to zero and
    /// `typeof(MyBox[Status])` serialised as the unresolvable
    /// `P.MyBox`).
    ///
    /// The shape is ECMA-335 I.8.5.2 / (cref:Type.AssemblyQualifiedName):
    /// `Ns.Def`N[[argAqn],[argAqn]], DefAssembly`, with array and
    /// `Nullable` wrappers attaching to the NAME while the assembly stays
    /// the wrapped part's (respectively the core library's).
    /// @param type The symbolic type to serialise.
    /// @returns The assembly-qualified name.
    private func GetSerializedTypeName(type TypeSymbol) string {
        let (name, assembly) = this.GetSerializedTypeParts(type)
        return name + ", " + assembly
    }

    /// Splits a symbolic type's serialised form into its name and its declaring
    /// assembly, so a wrapper (array, `Nullable`) can attach to the name
    /// without disturbing the assembly, and a generic instantiation can qualify
    /// each argument independently.
    /// @param type The symbolic type.
    /// @returns The name part and the assembly part.
    private func GetSerializedTypeParts(type TypeSymbol)(Name string, Assembly string) {
        switch type {
            case nullable is NullableTypeSymbol when nullable.UnderlyingType is {} underlying {
                // A nullable REFERENCE has no distinct runtime type (ADR: the
                // annotation is metadata over the same CLR shape), so it
                // serialises as its underlying type. A nullable VALUE type is a
                // real `System.Nullable<T>` instantiation.
                return if NullableLifting.IsAnyValueTypeNullable(nullable) {
                    this.BuildNullableParts(underlying)
                } else {
                    this.GetSerializedTypeParts(underlying)
                }
            }
            case _ is MapTypeSymbol or
                _ is TupleTypeSymbol or
                _ is FunctionTypeSymbol or
                _ is ChannelTypeSymbol or
                _ is SequenceTypeSymbol or
                _ is AsyncSequenceTypeSymbol when this.TryGetStructuralTypeParts(type, out var structuralParts) {
                return structuralParts
            }
            case slice is SliceTypeSymbol {
                return AppendNameSuffix(this.GetSerializedTypeParts(slice.ElementType), "[]")
            }
            case array is ArrayTypeSymbol {
                return AppendNameSuffix(this.GetSerializedTypeParts(array.ElementType), "[]")
            }
            case rectangular is RectangularArrayTypeSymbol {
                return AppendNameSuffix(
                    this.GetSerializedTypeParts(rectangular.ElementType),
                    "[" + String(',', Math.Max(rectangular.Rank - 1, 0)) + "]"
                )
            }
            case ImportedTypeSymbol{OpenDefinition: {} openDefinition} imported when !imported
                .TypeArguments
                .IsDefaultOrEmpty {
                return (
                    (openDefinition.FullName ?? openDefinition.Name) + this.BuildArgumentList(imported.TypeArguments),
                    openDefinition
                        .Assembly
                        .FullName ??
                        openDefinition
                        .Assembly
                        .GetName()
                        .Name ??
                        this.CompilationAssemblyName()
                )
            }
            case StructSymbol{ClrType: nil} structType when !structType
                .EnclosingTypeArguments
                .IsDefaultOrEmpty ||
                !structType
                .TypeArguments
                .IsDefaultOrEmpty {
                return (
                    GetMetadataTypeName(structType.Definition!!) + this.BuildArgumentList(
                        Flatten(structType.EnclosingTypeArguments, structType.TypeArguments)
                    ),
                    this.CompilationAssemblyName()
                )
            }
            case InterfaceSymbol{ClrType: nil} interfaceType when !interfaceType.TypeArguments.IsDefaultOrEmpty {
                return (
                    GetMetadataTypeName(interfaceType.Definition!!) + this.BuildArgumentList(
                        interfaceType.TypeArguments
                    ),
                    this.CompilationAssemblyName()
                )
            }
            case DelegateTypeSymbol{ClrType: nil} delegateType when !delegateType.TypeArguments.IsDefaultOrEmpty {
                return (
                    GetMetadataTypeName(delegateType.Definition ?? delegateType) + this.BuildArgumentList(
                        delegateType.TypeArguments
                    ),
                    this.CompilationAssemblyName()
                )
            }
            case EnumSymbol{ClrType: nil} enumType when !enumType.EnclosingTypeArguments.IsDefaultOrEmpty {
                return (
                    GetMetadataTypeName(enumType.Definition ?? enumType) + this.BuildArgumentList(
                        enumType.EnclosingTypeArguments
                    ),
                    this.CompilationAssemblyName()
                )
            }
            case structSymbol is StructSymbol when structSymbol.ClrType == nil {
                return (GetMetadataTypeName(type), this.CompilationAssemblyName())
            }
            case interfaceSymbol is InterfaceSymbol when interfaceSymbol.ClrType == nil {
                return (GetMetadataTypeName(type), this.CompilationAssemblyName())
            }
            case enumSymbol is EnumSymbol when enumSymbol.ClrType == nil {
                return (GetMetadataTypeName(type), this.CompilationAssemblyName())
            }
            case delegateTypeSymbol is DelegateTypeSymbol when delegateTypeSymbol.ClrType == nil {
                return (GetMetadataTypeName(type), this.CompilationAssemblyName())
            }
        }
        if type.ClrType is {} clrType {
            return (
                clrType.FullName ?? clrType.Name,
                clrType.Assembly.FullName ?? clrType.Assembly.GetName().Name ?? this.CompilationAssemblyName()
            )
        }
        return (GetMetadataTypeName(type), this.CompilationAssemblyName())
    }

    /// Builds the `[[arg],[arg]]` instantiation suffix, qualifying each
    /// argument with its OWN assembly — the whole point of the recursion, since
    /// an imported definition is routinely closed over a same-compilation
    /// argument.
    /// @param typeArguments The symbolic type arguments.
    /// @returns The bracketed argument list.
    private func BuildArgumentList(typeArguments ImmutableArray[TypeSymbol]) string {
        let parts = typeArguments.Select(
            (argument TypeSymbol) -> {
                let (name, assembly) = this.GetSerializedTypeParts(argument)
                return "[" + name + ", " + assembly + "]"
            }
        )
        return "[" + string.Join(",", parts) + "]"
    }

    /// Builds the `System.Nullable`1` instantiation over
    /// [`underlying`](paramref), resolving the open definition through the
    /// compilation's reference set rather than the emitting host's, so the
    /// assembly it names is the one the emitted assembly actually references.
    /// @param underlying The value-type underlying type.
    /// @returns The name and assembly parts of the nullable instantiation.
    private func BuildNullableParts(underlying TypeSymbol)(Name string, Assembly string) {
        let (innerName, innerAssembly) = this.GetSerializedTypeParts(underlying)
        let suffix = "[[" + innerName + ", " + innerAssembly + "]]"
        if this
            .emitCtx
            .References
            .TryResolveType("System.Nullable`1", requireExternalVisibility: false, out var nullableOpen) &&
            nullableOpen != nil {
            return (
                (nullableOpen.FullName ?? "System.Nullable`1") + suffix,
                (nullableOpen.Assembly.FullName ?? nullableOpen.Assembly.GetName().Name ?? innerAssembly)
            )
        }
        // Defensive: every reference set that can compile a nilable value type
        // carries the core library, so this is unreachable in practice.
        return ("System.Nullable`1" + suffix, innerAssembly)
    }

    /// Issue #4098: serialises a G# STRUCTURAL type — `map`, tuple,
    /// `func`, `chan`, `sequence` — as the BCL type it projects
    /// onto, closed over its components SYMBOLICALLY.
    /// @remarks <b>What was wrong.</b> Each structural symbol computes its own
    /// `ClrType` by closing an open BCL definition over its components. A
    /// same-compilation component has none while binding, so the structural
    /// symbol's `ClrType` came out null and the switch fell through to
    /// `GetMetadataTypeName`'s `default:` arm — bare
    /// `type.Name`, which for these kinds is the G# DISPLAY spelling
    /// (`map[string,Status]`, `(Status) -> bool`, `chan`),
    /// qualified to the compilation's own assembly. Nothing can decode
    /// that.
    ///
    /// <b>Why there is no <c>{ ClrType: null }</c> guard.</b> The obvious
    /// spelling of these arms — gate on a null `ClrType`, the way the
    /// `StructSymbol`/`InterfaceSymbol` arms do — would leave a
    /// quieter half of the same defect in place.
    /// `map[string, List[Status]]` has a component whose `ClrType` is
    /// NON-null: `List<object>`, closed over the erasure surrogate.
    /// So `MapTypeSymbol.MakeClrType` succeeds, and the `ClrType`
    /// fallback below wrote
    /// `Dictionary`2[[String],[List`1[[System.Int32]]]]` — a name that
    /// RESOLVES, to the wrong type. Measured, not reasoned. The sibling
    /// wrapper arms (slice, array, rectangular, nullable) already recurse
    /// symbolically without such a guard for exactly this reason; these follow
    /// them.
    ///
    /// <b>Where the projection decisions come from.</b> Each is taken
    /// from the symbol that already owns it rather than restated here:
    /// (cref:ChannelTypeSymbol.OpenClrDefinition) for the channel
    /// direction and
    /// (cref:SequenceTypeSymbol.TryGetEnumerableInterfaceShape) for the
    /// sync/async sequence split. The open definition is then resolved through
    /// the COMPILATION's reference set, not the emitting host's, so the
    /// assembly named is the one the emitted assembly actually references —
    /// the same shape as (cref:BuildNullableParts).
    ///
    /// <b>What it declines.</b> A `func` above the shipped
    /// `Func`/`Action` arities has no spelling at all, and neither
    /// does a zero-element tuple. Those return `false` and fall
    /// through to the pre-existing behaviour rather than inventing a name;
    /// their `ClrType` is null for the same reason, so they are already
    /// emit-limited everywhere else.
    /// @param type The structural type symbol.
    /// @param parts The serialised name and assembly parts.
    /// @returns Whether a BCL projection exists for this shape.
    private func TryGetStructuralTypeParts(type TypeSymbol, out parts(Name string, Assembly string)) bool {
        switch type {
            case map_ is MapTypeSymbol {
                return this.TryCloseOpenDefinition(
                    "System.Collections.Generic.Dictionary`2",
                    [](Name string, Assembly string){
                        this.GetSerializedTypeParts(map_.KeyType),
                        this.GetSerializedTypeParts(map_.ValueType)
                    },
                    out parts
                )
            }
            case channel is ChannelTypeSymbol {
                return this.TryCloseOpenDefinition(
                    if ChannelTypeSymbol.OpenClrDefinition(channel.Direction) is {FullName: {} channelName} {
                        channelName
                    } else {
                        "System.Threading.Channels.Channel`1"
                    },
                    [](Name string, Assembly string){this.GetSerializedTypeParts(channel.ElementType)},
                    out parts
                )
            }
            case _ is SequenceTypeSymbol or
                _ is AsyncSequenceTypeSymbol when SequenceTypeSymbol.TryGetEnumerableInterfaceShape(
                type,
                out var openSequence,
                out var element
            ) &&
                openSequence is {FullName: {} sequenceName} {
                return this.TryCloseOpenDefinition(
                    sequenceName,
                    [](Name string, Assembly string){this.GetSerializedTypeParts(element)},
                    out parts
                )
            }
            case tuple is TupleTypeSymbol {
                return this.TryGetTupleParts(tuple.ElementTypes, out parts)
            }
            case function is FunctionTypeSymbol {
                return this.TryGetFunctionParts(function, out parts)
            }
        }
        parts = default((Name string, Assembly string))
        return false
    }

    /// Serialises a tuple as the `System.ValueTuple`N` family, nesting the
    /// tail into `TRest` above arity 7 exactly as
    /// `TupleTypeSymbol`'s CLR builder does.
    /// @param elements The element types.
    /// @param parts The serialised name and assembly parts.
    /// @returns Whether the tuple has a `ValueTuple` spelling.
    private func TryGetTupleParts(elements ImmutableArray[TypeSymbol], out parts(Name string, Assembly string)) bool {
        if elements.IsDefaultOrEmpty {
            parts = default((Name string, Assembly string))
            return false
        }
        if elements.Length <= 7 {
            return this.TryCloseOpenDefinition(
                "System.ValueTuple`" + elements.Length.ToString(CultureInfo.InvariantCulture),
                elements.Select(this.GetSerializedTypeParts).ToArray(),
                out parts
            )
        }
        if !this.TryGetTupleParts(ImmutableArray.CreateRange(elements.Skip(7)), out var rest) {
            parts = default((Name string, Assembly string))
            return false
        }
        let arguments = elements.Take(7).Select(this.GetSerializedTypeParts).Append(rest).ToArray()
        return this.TryCloseOpenDefinition("System.ValueTuple`8", arguments, out parts)
    }

    /// Serialises a `func` type as `System.Action`N` (void return) or
    /// `System.Func`N+1`, using the same void rule
    /// `FunctionTypeSymbol`'s CLR builder applies.
    /// @param function The function type.
    /// @param parts The serialised name and assembly parts.
    /// @returns Whether a shipped delegate shape exists for this arity.
    private func TryGetFunctionParts(function FunctionTypeSymbol, out parts(Name string, Assembly string)) bool {
        const MaxDelegateArity = 16
        let parameterCount = function.ParameterTypes.Length
        if parameterCount > MaxDelegateArity {
            parts = default((Name string, Assembly string))
            return false
        }
        let arguments = function.ParameterTypes.Select(this.GetSerializedTypeParts).ToList()
        if FunctionTypeSymbol.IsVoidReturn(function.ReturnType) {
            // `System.Action` is not generic, so it takes no argument list.
            return if parameterCount == 0 {
                this.TryCloseOpenDefinition("System.Action", Array.Empty[(string, string)](), out parts)
            } else {
                this.TryCloseOpenDefinition(
                    "System.Action`" + parameterCount.ToString(CultureInfo.InvariantCulture),
                    arguments,
                    out parts
                )
            }
        }
        arguments.Add(this.GetSerializedTypeParts(function.ReturnType))
        return this.TryCloseOpenDefinition(
            "System.Func`" + arguments.Count.ToString(CultureInfo.InvariantCulture),
            arguments,
            out parts
        )
    }

    /// Resolves an open BCL definition through the COMPILATION's reference set
    /// and closes it over already-serialised argument parts.
    /// @remarks The host's own `typeof(Dictionary<,>)` is deliberately not
    /// used: the name written into the blob must be the one the emitted
    /// assembly references. Never `MakeGenericType` — a same-compilation
    /// argument has no CLR type to close over, which is the whole reason this
    /// serialiser exists.
    /// @param openDefinitionName The open definition's full metadata name.
    /// @param argumentParts The serialised arguments, empty for a non-generic definition.
    /// @param parts The serialised name and assembly parts.
    /// @returns Whether the reference set declares the definition.
    private func TryCloseOpenDefinition(
        openDefinitionName string,
        argumentParts IReadOnlyCollection[(Name string, Assembly string)],
        out parts(Name string, Assembly string)
    ) bool {
        if !this
            .emitCtx
            .References
            .TryResolveType(openDefinitionName, requireExternalVisibility: false, out var open_) ||
            open_ == nil {
            parts = default((Name string, Assembly string))
            return false
        }
        let suffix = if argumentParts.Count == 0 {
            string.Empty
        } else {
            "[" + string.Join(
                ",",
                argumentParts.Select(
                    (part(Name string, Assembly string)) -> "[" + part.Name + ", " + part.Assembly + "]"
                )
            ) +
                "]"
        }
        parts = (
            (open_.FullName ?? openDefinitionName) + suffix,
            open_.Assembly.FullName ?? open_.Assembly.GetName().Name ?? this.CompilationAssemblyName()
        )
        return true
    }

    /// Gets the identity of the assembly being emitted.
    /// @returns The assembly's simple name.
    private func CompilationAssemblyName() string -> this
        .emitCtx
        .AssemblyNameOverride ??
        this
        .emitCtx
        .Program
        .PackageName ??
        "Default"

    private func WriteCustomAttributeNamedArg(bb BlobBuilder, attributeType Type, arg BoundAttributeArgument) {
        if !TryResolveNamedMember(attributeType, arg, out var member, out var name) {
            throw InvalidOperationException("Named attribute members must be validated before encoding.")
        }
        var memberType Type
        var kindTag uint8
        if member is PropertyInfo prop {
            kindTag = uint8(0x54)
            memberType = prop.PropertyType
        } else {
            let field = cast[FieldInfo](member)
            kindTag = uint8(0x53)
            memberType = field.FieldType
        }
        bb.WriteByte(kindTag)
        WriteCustomAttributeFieldOrPropertyType(bb, memberType)
        bb.WriteSerializedString(name)
        WriteCustomAttributeFixedArg(bb, memberType, arg)
    }

    shared {
        /// Issue #1354: returns `true` when a per-position
        /// `[NullableAttribute]` must be emitted for a field/property — i.e. the
        /// flags array is non-empty AND contains at least one byte that is not
        /// (cref:NullableFlagsBuilder.NotAnnotated) (a `2` nullable
        /// position or a `0` oblivious position). When every position is
        /// non-null the type-level `NullableContextAttribute(1)` covers it.
        /// @param flags The DFS pre-order nullability byte array.
        /// @returns `true` when the attribute must be emitted.
        internal func ShouldEmitPerPositionNullable(
            flags ImmutableArray[uint8]
        ) bool -> MethodNullabilityPlan.NeedsAttribute(flags, NullableFlagsBuilder.NotAnnotated)

        private func TryMapUserAttributeConstructorArgumentSlots(
            parameters ImmutableArray[ParameterSymbol],
            attribute BoundAttribute,
            @NotNullWhen(true) out slots[]?object?,
            out usedDefault bool,
            out positionalConflict BoundAttributeArgument?
        ) bool {
            slots = nil
            usedDefault = false
            positionalConflict = nil
            if attribute.PositionalArguments.Length > parameters.Length {
                return false
            }
            let mappedSlots = [parameters.Length]object?
            let filled = [parameters.Length]bool
            var sawOutOfPositionName = false
            for var sourceIndex = 0; sourceIndex < attribute.PositionalArguments.Length; sourceIndex++ {
                let argument = attribute.PositionalArguments[sourceIndex]
                var index = sourceIndex
                if argument.Name is {} name {
                    index = -1
                    for var i = 0; i < parameters.Length; i++ {
                        if parameters[i].Name == name {
                            index = i
                            break
                        }
                    }
                    sawOutOfPositionName |= index != sourceIndex
                } else if sawOutOfPositionName {
                    return false
                }
                if index < 0 {
                    return false
                }
                if (filled[index]) {
                    positionalConflict = argument
                    return false
                }
                mappedSlots[index] = argument
                filled[index] = true
            }
            for var i = 0; i < parameters.Length; i++ {
                if !filled[i] {
                    if !parameters[i].HasExplicitDefaultValue {
                        return false
                    }
                    usedDefault = true
                    mappedSlots[i] = parameters[i].ExplicitDefaultValue
                    continue
                }
            }
            slots = mappedSlots
            return true
        }

        private func TryBuildUserAttributeConstructorArguments(
            slots[]object?,
            parameterTypes[]Type,
            @NotNullWhen(true) out effectiveArguments[]?object?
        ) bool {
            effectiveArguments = nil
            for var i = 0; i < slots.Length; i++ {
                if slots[i] is not BoundAttributeArgument supplied {
                    continue
                }
                if !ArgAssignable(supplied.Value, parameterTypes[i], supplied.Type) {
                    return false
                }
            }
            effectiveArguments = slots
            return true
        }

        /// Projects a same-compilation constructor's parameter types onto CLR
        /// types, naming the first parameter that has none.
        /// @param parameters The constructor's parameters.
        /// @param clrTypes The projected types, when every parameter has one.
        /// @param unsupported Issue #4097: the first parameter whose type has no `ClrType` — a
        /// same-compilation type, whose TypeDef only exists at emit. The caller
        /// needs to know WHICH parameter so it can say so instead of reporting the
        /// unrelated "no constructor accepts these arguments".
        /// @returns Whether every parameter projected.
        private func TryGetClrParameterTypes(
            parameters ImmutableArray[ParameterSymbol],
            @NotNullWhen(true) out clrTypes[]?Type,
            out unsupported ParameterSymbol?
        ) bool {
            clrTypes = [parameters.Length]Type
            unsupported = nil
            for var i = 0; i < parameters.Length; i++ {
                if !TryGetAttributeParameterWriteType(parameters[i].Type, out var clr) {
                    clrTypes = nil
                    unsupported = parameters[i]
                    return false
                }
                clrTypes!![i] = clr
            }
            return true
        }

        /// The CLR type the fixed-argument writer should encode one same-compilation
        /// constructor parameter AS.
        /// @remarks Issue #4097, found in the Oahu corpus: a user attribute whose
        /// constructor parameter is a same-compilation ENUM —
        /// `@OahuCapability(CapabilityClass.Safe)` — has no `ClrType`
        /// while the blob is built, because the enum's TypeDef only exists at emit.
        /// The whole attribute used to be dropped in silence, and a first pass at
        /// this issue reported it as unsupported. Both are wrong: the program is
        /// legal, and ECMA-335 II.23.3 writes an enum-typed fixed argument as its
        /// UNDERLYING primitive, which is available here.
        ///
        /// Three facts make this a substitution rather than a feature. The
        /// underlying type of a G# enum is always `int32`; the bound argument
        /// value is already that underlying constant, not a symbol (the binder's
        /// enum-literal arm stores `lit.Value`); and the constructor's own
        /// token and signature come from the emitted `MethodDef` via the
        /// injected resolvers, so nothing on this path has to encode the enum type
        /// itself. Only the value's WIDTH was ever missing.
        /// @param type The declared parameter type.
        /// @param writeType The CLR type to encode the argument as.
        /// @returns Whether the parameter can be encoded at all.
        private func TryGetAttributeParameterWriteType(type TypeSymbol?, @NotNullWhen(true) out writeType Type?) bool {
            if type?.ClrType is {} declared {
                writeType = declared
                return true
            }
            if type is EnumSymbol sourceEnum && sourceEnum.UnderlyingType.ClrType is {} underlying {
                writeType = underlying
                return true
            }
            // Issue #4144: the array sibling of the case above — a same-
            // compilation enum ARRAY parameter (`Kinds []Status`) — has no
            // `ClrType` on the ARRAY type either, for the same reason (the
            // element enum's TypeDef only exists at emit). The binder
            // (`DeclarationBinder.TryBindAttributeArrayArgument`) already builds
            // the constant CONTAINER as `int32[]` for exactly this shape, so the
            // signature must match: encode the parameter as `int32[]`.
            let arrayElementType TypeSymbol? = switch type {
                case slice is SliceTypeSymbol: slice.ElementType
                case array is ArrayTypeSymbol: array.ElementType
                default: default(TypeSymbol?)
            }
            if arrayElementType is EnumSymbol arrayEnum && arrayEnum.UnderlyingType.ClrType is {} arrayUnderlying {
                writeType = arrayUnderlying.MakeArrayType()
                return true
            }
            writeType = nil
            return false
        }

        /// Describes the supplied positional arguments by their SOURCE types, for
        /// the GS0583 message — the same information C# puts in CS1503.
        /// @param positional The bound positional arguments.
        /// @returns A comma-separated list of type names, empty for no arguments.
        private func DescribeArgumentList(positional ImmutableArray[BoundAttributeArgument]) string -> string.Join(
            ", ",
            positional.Select(
                (argument BoundAttributeArgument) -> argument
                    .Type
                    ?.Name ??
                    (
                    if argument.Value is {} value {
                        value.GetType().Name
                    } else {
                        "nil"
                    }
                )
            )
        )

        private func ResolveAttributeConstructor(
            attributeType Type,
            attribute BoundAttribute,
            out effectiveArguments[]object?,
            out memberArguments ImmutableArray[BoundAttributeArgument]
        ) ConstructorInfo? {
            effectiveArguments = Array.Empty[object?]()
            memberArguments = ImmutableArray[BoundAttributeArgument].Empty
            ValidateUniqueNamedConstructorArguments(attribute)
            ValidateNamedAttributeMembers(attributeType, attribute)
            let constructor ConstructorInfo? = TryResolveImportedAttributeConstructor(
                attributeType,
                attribute,
                out effectiveArguments,
                out var duplicateNamedArgument,
                out var positionalConflict
            )
            if constructor != nil {
                memberArguments = attribute.NamedArguments
                return constructor
            }
            if duplicateNamedArgument != nil {
                EmitDiagnosticException.ThrowDiagnostic(
                    duplicateNamedArgument.Syntax ?? attribute.Syntax,
                    DiagnosticDescriptors.DuplicateNamedArgument,
                    duplicateNamedArgument.Name
                )
            }
            if positionalConflict != nil {
                EmitDiagnosticException.ThrowDiagnostic(
                    positionalConflict.Syntax ?? attribute.Syntax,
                    DiagnosticDescriptors.NamedArgumentAlsoSpecifiedPositionally,
                    positionalConflict.Name,
                    positionalConflict.Name
                )
            }
            return nil
        }

        private func ValidateNamedAttributeMembers(attributeType Type, attribute BoundAttribute) {
            let seenMemberNames = HashSet[string](StringComparer.Ordinal)
            for memberArgument in attribute.NamedArguments {
                let memberName = Invariant.Required(
                    memberArgument.Name,
                    "a named attribute member argument has a name",
                    expression: "memberArgument.Name"
                )
                if !TryResolveNamedMember(attributeType, memberArgument, out var member, out var metadataName) {
                    EmitDiagnosticException.ThrowDiagnostic(
                        memberArgument.Syntax ?? attribute.Syntax,
                        DiagnosticDescriptors.AttributeNamedArgumentNotFound,
                        memberArgument.Name,
                        attributeType.Name
                    )
                }
                if !seenMemberNames.Add(metadataName!!) {
                    EmitDiagnosticException.ThrowDiagnostic(
                        memberArgument.Syntax ?? attribute.Syntax,
                        DiagnosticDescriptors.DuplicateNamedArgument,
                        memberName
                    )
                }
                let memberType = if member is PropertyInfo property {
                    property.PropertyType
                } else {
                    (cast[FieldInfo](member!!)).FieldType
                }
                if !IsValidAttributeMemberType(memberType) {
                    EmitDiagnosticException.ThrowDiagnostic(
                        memberArgument.Syntax ?? attribute.Syntax,
                        DiagnosticDescriptors.AttributeNamedMemberInvalidType,
                        memberArgument.Name,
                        memberType.Name
                    )
                }
                if !ArgAssignable(memberArgument.Value, memberType, memberArgument.Type) {
                    EmitDiagnosticException.ThrowDiagnostic(
                        memberArgument.Syntax ?? attribute.Syntax,
                        DiagnosticDescriptors.AttributeNamedArgumentTypeMismatch,
                        memberArgument.Name,
                        memberArgument.Type.Name,
                        memberType.Name
                    )
                }
            }
        }

        internal func TryResolveImportedAttributeConstructor(
            attributeType Type,
            attribute BoundAttribute,
            out effectiveArguments[]object?,
            out duplicateNamedArgument BoundAttributeArgument?,
            out positionalConflict BoundAttributeArgument?
        ) ConstructorInfo? {
            effectiveArguments = Array.Empty[object?]()
            duplicateNamedArgument = nil
            positionalConflict = nil
            let constructors = attributeType.GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            // Keep the existing precedence: normal form, omitted optionals, then
            // params expansion. Named constructor arguments only change which
            // parameter slot receives each supplied value.
            for desiredForm in Enum.GetValues[AttributeConstructorArgumentForm]() {
                for constructor in constructors {
                    if !TryMapAttributeConstructorArguments(
                        constructor.GetParameters(),
                        attribute.PositionalArguments,
                        desiredForm,
                        out var candidateArguments,
                        out var duplicate,
                        out var conflict
                    ) {
                        duplicateNamedArgument ??= duplicate
                        positionalConflict ??= conflict
                        continue
                    }
                    effectiveArguments = candidateArguments
                    return constructor
                }
            }
            return nil
        }

        private func ValidateUniqueNamedConstructorArguments(attribute BoundAttribute) {
            let seenNames = HashSet[string](StringComparer.Ordinal)
            for argument in attribute.PositionalArguments {
                if argument.Name is not{} name {
                    continue
                }
                if !seenNames.Add(name) {
                    EmitDiagnosticException.ThrowDiagnostic(
                        argument.Syntax ?? attribute.Syntax,
                        DiagnosticDescriptors.DuplicateNamedArgument,
                        name
                    )
                }
            }
        }

        private func TryMapAttributeConstructorArguments(
            parameters[]ParameterInfo,
            arguments ImmutableArray[BoundAttributeArgument],
            desiredForm AttributeConstructorArgumentForm,
            out effective[]object?,
            out duplicateNamedArgument BoundAttributeArgument?,
            out positionalConflict BoundAttributeArgument?
        ) bool {
            effective = Array.Empty[object?]()
            duplicateNamedArgument = nil
            positionalConflict = nil
            let expanded = desiredForm == AttributeConstructorArgumentForm.ParamsExpanded
            let hasParams = parameters.Length > 0 && IsParamsArray(parameters[parameters.Length - 1])
            let fixedCount = if expanded && hasParams {
                parameters.Length - 1
            } else {
                parameters.Length
            }
            if (expanded && !hasParams) || (!expanded && arguments.Length > parameters.Length) {
                return false
            }
            let slots = [parameters.Length]object?
            let filled = [parameters.Length]bool
            let expandedTail = List[BoundAttributeArgument]()
            let parameterNames = parameters.Select((parameter ParameterInfo) -> parameter.Name ?? string.Empty)
                .ToArray()
            let parameterIndexes = Dictionary[string, int32](StringComparer.Ordinal)
            for var i = 0; i < parameters.Length; i++ {
                parameterIndexes[parameters[i].Name ?? string.Empty] = i
            }
            for var i = 0; i < parameters.Length; i++ {
                parameterIndexes.TryAdd(
                    SyntaxFacts.GetEmittedIdentifier(
                        parameters[i].Name ?? string.Empty,
                        IdentifierNameContext.Parameter,
                        parameterNames
                    ),
                    i
                )
            }
            var sawOutOfPositionName = false
            for var sourceIndex = 0; sourceIndex < arguments.Length; sourceIndex++ {
                let argument = arguments[sourceIndex]
                var parameterIndex = sourceIndex
                if argument.Name is {} sourceName {
                    parameterIndex = if parameterIndexes.TryGetValue(sourceName, out var matchedIndex) {
                        matchedIndex
                    } else {
                        -1
                    }
                    sawOutOfPositionName |= parameterIndex != sourceIndex
                } else {
                    if sawOutOfPositionName {
                        return false
                    }
                    if expanded && sourceIndex >= fixedCount {
                        expandedTail.Add(argument)
                        continue
                    }
                }
                if parameterIndex < 0 || (expanded && parameterIndex == parameters.Length - 1) {
                    return false
                }
                if parameterIndex >= parameters.Length {
                    positionalConflict = argument
                    return false
                }
                if (filled[parameterIndex]) {
                    if argument.Name != nil && (slots[parameterIndex] is BoundAttributeArgument and {Name: not nil}) {
                        duplicateNamedArgument = argument
                    } else {
                        positionalConflict = argument
                    }
                    return false
                }
                slots[parameterIndex] = argument
                filled[parameterIndex] = true
            }
            var usedDefault = false
            for var i = 0; i < fixedCount; i++ {
                if !filled[i] {
                    if !TryGetOptionalDefault(parameters[i], out var fallback) {
                        return false
                    }
                    usedDefault = true
                    slots[i] = fallback
                    filled[i] = true
                    continue
                }
                if slots[i] is not BoundAttributeArgument supplied {
                    return false
                }
                if !ArgAssignable(supplied.Value, parameters[i].ParameterType, supplied.Type) {
                    return false
                }
            }
            if !expanded {
                for var i = fixedCount; i < parameters.Length; i++ {
                    if !filled[i] {
                        return false
                    }
                }
                if (desiredForm == AttributeConstructorArgumentForm.Normal && usedDefault) ||
                    (desiredForm == AttributeConstructorArgumentForm.Defaulted && !usedDefault) {
                    return false
                }
                effective = slots
                return true
            }
            let elementType Type? = parameters[parameters.Length - 1].ParameterType.GetElementType()
            if elementType == nil {
                return false
            }
            let tail = [expandedTail.Count]object?
            for var i = 0; i < expandedTail.Count; i++ {
                let argument = expandedTail[i]
                if !ArgAssignable(argument.Value, elementType, argument.Type) {
                    return false
                }
                tail[i] = argument
            }
            let result = [parameters.Length]object?
            for var i = 0; i < fixedCount; i++ {
                result[i] = slots[i]
            }
            result[parameters.Length - 1] = tail
            effective = result
            return true
        }

        /// Reads an omitted parameter's default. Uses `RawDefaultValue` rather
        /// than `DefaultValue` because a third-party attribute is routinely
        /// resolved through a (cref:MetadataLoadContext), where the latter
        /// is not available.
        /// @param parameter The omitted parameter.
        /// @param value The value to encode for it.
        /// @returns Whether a writable default exists.
        private func TryGetOptionalDefault(parameter ParameterInfo, out value object?) bool {
            value = nil
            if !parameter.IsOptional {
                return false
            }
            var raw object?
            try {
                raw = parameter.RawDefaultValue
            } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                // A metadata-loaded parameter whose Constant row cannot be decoded.
                return false
            }
            if (raw is DBNull or Missing) {
                // `[Optional]` with no Constant row. A reference slot takes nil; a
                // value slot has no answer this encoder may invent.
                return !parameter.ParameterType.IsValueType
            }
            value = raw
            return true
        }

        /// Marks that a layout-applicable constructor projected, and returns true.
        /// @param seen The flag to set.
        /// @returns Always `true`, so it can chain into a condition.
        private func SawProjectable(ref seen bool) bool {
            seen = true
            return true
        }

        /// Whether a parameter is a genuine `params` array — asked of
        /// `ParamArrayAttribute`, which is the authority, rather than inferred
        /// from the parameter being a one-dimensional array.
        /// @remarks Read through (cref:ParameterInfo.CustomAttributes) and compared by
        /// full name because a third-party attribute is routinely resolved through
        /// a (cref:MetadataLoadContext), where the loaded
        /// `ParamArrayAttribute` is not the executing runtime's and
        /// `GetCustomAttributes(Type, bool)` would not match it.
        /// @param parameter The candidate trailing parameter.
        /// @returns Whether the parameter may absorb trailing arguments.
        private func IsParamsArray(parameter ParameterInfo) bool {
            if !parameter.ParameterType.IsArray || parameter.ParameterType.GetArrayRank() != 1 {
                return false
            }
            try {
                for attribute in parameter.CustomAttributes {
                    if attribute.AttributeType.FullName == "System.ParamArrayAttribute" {
                        return true
                    }
                }
            } catch (ex Exception) when !(ex is OutOfMemoryException) && !(ex is StackOverflowException) {
                // A metadata-loaded parameter whose custom attributes cannot be
                // decoded: treat it as an ordinary array rather than guessing.
                return false
            }
            return false
        }

        /// Decides whether one bound attribute argument may be encoded into one
        /// constructor parameter — the applicability rule that drives constructor
        /// SELECTION, so anything this admits is a call the emitter is willing to
        /// write.
        /// @param supplied The bound constant value.
        /// @param paramType The constructor parameter's CLR type.
        /// @param suppliedType The argument's SOURCE type, when the caller has the
        /// (cref:BoundAttributeArgument) in hand. Only the widened-array arm
        /// consults it; a recursive element check passes `null` because an
        /// element carries no separate bound type.
        /// @returns Whether the value may be encoded into that parameter.
        private func ArgAssignable(supplied object?, paramType Type, suppliedType TypeSymbol? = nil) bool {
            var paramType = paramType
            // Third-party attributes are commonly resolved through a
            // MetadataLoadContext. Normalize framework types before using CLR
            // assignability so, for example, its System.String matches a runtime
            // string constant.
            paramType = NormalizeWellKnownType(paramType)!!
            // Everything is assignable to System.Object. Compared by name so the
            // check holds for attribute types resolved through a MetadataLoadContext.
            if paramType.FullName == "System.Object" {
                return true
            }
            if supplied == nil {
                return !(paramType.IsValueType && Nullable.GetUnderlyingType(paramType) == nil)
            }
            if paramType.IsInstanceOfType(supplied) {
                return true
            }
            if supplied is TypeSymbol && paramType.FullName == "System.Type" {
                return true
            }
            // Issue #4073: `[]Type{typeof(SourceType)}` is carried as an `object[]`,
            // because #3684 had to widen the constant CONTAINER to hold the
            // `TypeSymbol` placeholder a same-compilation `typeof` produces (a
            // `Type[]` cannot). Without this arm the widened container matched no
            // `Type[]` constructor parameter, so the WHOLE attribute was dropped from
            // the assembly with no diagnostic — the array's own elements were never
            // even reached. The blob is written from the SIGNATURE's element type,
            // so the container's element type never leaves the compiler.
            //
            // Review feedback on PR #4087: the container is widened, the SOURCE's
            // array type is not — so the widening is undone by asking
            // `BoundAttributeArgument.Type` what the author actually wrote, and the
            // arm fires only when that element type IS the parameter's. Matching on
            // the container alone made every `object[]` covariant by its current
            // VALUES: `@Names([]object{"x"})` satisfied a `string[]` constructor and
            // the emitter encoded a call the source could not have written. Compared
            // by name rather than by identity because a `/r:` compile resolves the
            // attribute through a `MetadataLoadContext`, so its `System.Type[]` is
            // not the runtime's.
            //
            // The normalized element is bound to a PATTERN LOCAL rather than read
            // inline as a member of the call result. cs2gs migrates this file, and
            // its nullable flow does not honour `[NotNullIfNotNull]`, so the inline
            // form translated to an asserted parenthesized receiver and tripped the
            // redundant-assertion inventory ratchet in
            // `Issue3422RedundantNullForgivenessTranslationTests` — eight permitted,
            // this made nine. The local is the same value: the argument is non-null
            // here, so the helper's `[NotNullIfNotNull]` guarantees a non-null
            // result and the pattern always matches. (Spelled without the token the
            // ratchet counts: that inventory strips comment lines, but a comment
            // quoting the pattern is the #3469 trap and makes every grep-based
            // reading of the migrated tree lie.)
            if paramType.IsArray && paramType.GetArrayRank() == 1 &&
                paramType.GetElementType() is {} parameterElementType &&
                supplied is []object? widenedElements &&
                suppliedType?.ClrType is {IsArray: true} declaredArrayType &&
                declaredArrayType.GetArrayRank() == 1 && declaredArrayType.GetElementType() is {} declaredElementType &&
                NormalizeWellKnownType(declaredElementType) is {} normalizedElementType &&
                string
                .Equals(normalizedElementType.FullName, parameterElementType.FullName, StringComparison.Ordinal) {
                for element in widenedElements {
                    if !ArgAssignable(element, parameterElementType) {
                        return false
                    }
                }
                return true
            }
            return IsTriviallyConvertible(supplied.GetType(), paramType)
        }

        /// Returns the executing runtime's (cref:Type) for well-known
        /// core-library types (primitives, string, object, Type, and single-rank
        /// arrays thereof) so that the reference-equality dispatch in
        /// (cref:WriteCustomAttributeFixedArg) works even when the attribute
        /// was resolved through a (cref:MetadataLoadContext). Unknown types
        /// are returned unchanged.
        @return: NotNullIfNotNull("t")
        private func NormalizeWellKnownType(t Type?) Type? {
            if t == nil {
                return nil
            }
            if t.IsArray && t.GetArrayRank() == 1 {
                let element = NormalizeWellKnownType(t.GetElementType()!!)
                return element!!.MakeArrayType()
            }
            let byName Type? = Type.GetType(t.FullName ?? string.Empty)
            return byName ?? t
        }

        private func IsTriviallyConvertible(from Type, to Type) bool {
            if from == to {
                return true
            }
            if to.IsEnum {
                return from == GetEnumUnderlyingTypeSafe(to)
            }
            if from.IsArray && to.IsArray && from.GetArrayRank() == 1 && to.GetArrayRank() == 1 {
                return IsTriviallyConvertible(from.GetElementType()!!, to.GetElementType()!!)
            }
            return false
        }

        private func GetSerializedTypeName(t Type) string {
            // ECMA-335 II.23.3 + I.8.5.2: the canonical serialised form is the
            // assembly-qualified name; types from mscorlib / System.Private.CoreLib
            // may omit the assembly portion. We always emit the assembly-qualified
            // form so the consumer can unambiguously rebind the type.
            return t.AssemblyQualifiedName ?? t.FullName ?? t.Name
        }

        private func AppendNameSuffix(parts(Name string, Assembly string), suffix string)(
            Name string,
            Assembly string
        ) -> (parts.Name + suffix, parts.Assembly)

        /// Issue #4095: joins a nested type's enclosing vector to its own, in the
        /// order the emitted GenericParam rows declare them, tolerating either side
        /// being an uninitialized (cref:ImmutableArray{T}).
        /// @param enclosing Arguments supplied by the containing types.
        /// @param own Arguments declared by the nested type itself.
        /// @returns The flattened instantiation vector.
        private func Flatten(enclosing ImmutableArray[TypeSymbol], own ImmutableArray[TypeSymbol]) ImmutableArray[
            TypeSymbol
        ] {
            let head = if enclosing.IsDefault {
                ImmutableArray[TypeSymbol].Empty
            } else {
                enclosing
            }
            return if own.IsDefaultOrEmpty {
                head
            } else {
                head.AddRange(own)
            }
        }

        internal func GetMetadataTypeName(type TypeSymbol) string {
            var packageName string
            var containingType TypeSymbol?
            var arity int32
            switch type {
                case structType is StructSymbol {
                    packageName = structType.PackageName
                    containingType = structType.ContainingType
                    // ADR-0087 §3 R1 / issue #2916: a nested TypeDef's backtick
                    // suffix counts only the parameters DECLARED at that level,
                    // while its GenericParam rows carry the flattened
                    // enclosing-plus-own vector that `TypeParameters` holds. Issue
                    // #4095: reading the flattened length here named
                    // `Outer[Status].Inner` as `P.Outer`1+Inner`1`, which the
                    // emitted metadata does not declare, so the attribute could no
                    // longer be decoded at all. This is the same expression
                    // `TypeDefEmitter.EmitStructTypeDefinition` uses to choose the
                    // name, so the two cannot drift again.
                    arity = if structType.Declaration == nil {
                        structType.TypeParameters.Length
                    } else {
                        structType.Declaration!!.TypeParameterList?.Parameters.Count ?? 0
                    }
                }
                case interfaceType is InterfaceSymbol {
                    packageName = interfaceType.PackageName
                    containingType = interfaceType.ContainingType
                    arity = interfaceType.TypeParameters.Length
                }
                case enumType is EnumSymbol {
                    packageName = enumType.PackageName
                    containingType = enumType.ContainingType
                    arity = 0
                }
                case delegateType is DelegateTypeSymbol {
                    packageName = delegateType.PackageName
                    containingType = nil
                    arity = delegateType.TypeParameters.Length
                }
                default {
                    return type.Name
                }
            }
            let name = if arity == 0 {
                type.Name
            } else {
                type.Name + "`" + arity.ToString()
            }
            if containingType != nil {
                return GetMetadataTypeName(containingType) + "+" + name
            }
            return if string.IsNullOrEmpty(packageName) {
                name
            } else {
                packageName + "." + name
            }
        }

        /// Returns the underlying primitive type of an enum in a way that works for
        /// types loaded through a (cref:MetadataLoadContext). The BCL helper
        /// (cref:Enum.GetUnderlyingType(Type)) requires a runtime
        /// (cref:Type) and throws (cref:NotSupportedException) for
        /// metadata-loaded types (issue #418 / P1-8), which surfaces as an emit-time
        /// crash in the custom-attribute blob writer whenever an attribute argument
        /// is an enum defined in a referenced (non-BCL) package.
        /// @remarks Per ECMA-335 II.14.3 every enum is laid out as a class containing a
        /// single instance field named `value__` whose type is the underlying
        /// primitive (e.g. (cref:int)). Reading that field's type works
        /// uniformly for runtime and metadata-loaded types. The result is then
        /// normalized to the executing runtime's (cref:Type) so that the
        /// reference-equality dispatch in the blob writers matches.
        private func GetEnumUnderlyingTypeSafe(enumType Type) Type {
            let valueField = enumType.GetField(
                "value__",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic
            )
            let fieldType Type? = valueField?.FieldType
            if fieldType == nil {
                // Defensive fallback: a malformed enum without value__ would be
                // invalid metadata, but treating it as int32 keeps the writer
                // robust rather than crashing during emit.
                return typeof(int32)
            }
            return NormalizeWellKnownType(fieldType)!!
        }

        private func TryResolveNamedMember(
            attributeType Type,
            argument BoundAttributeArgument,
            @NotNullWhen(true) out member MemberInfo?,
            @NotNullWhen(true) out metadataName string?
        ) bool {
            let emittedName = Invariant.Required(
                argument.Name,
                "a named attribute argument always has a member name",
                expression: "argument.Name"
            )
            let members = attributeType
                .GetMembers(BindingFlags.Public | BindingFlags.Instance)
                .Where(
                (candidate MemberInfo) -> (
                    candidate is PropertyInfo property &&
                        property
                        .SetMethod
                        ?.IsPublic == true &&
                        property
                        .GetIndexParameters().Length == 0
                ) ||
                    candidate is FieldInfo &&
                    candidate.IsInitOnly == false &&
                    candidate.IsLiteral == false
            )
                .ToArray()
            let memberNames = members
                .Select((candidate MemberInfo) -> candidate.Name)
                .Distinct(StringComparer.Ordinal)
                .ToArray()
            member = members.FirstOrDefault((candidate MemberInfo) -> candidate.Name == emittedName) ??
                members
                .FirstOrDefault(
                (candidate MemberInfo) -> SyntaxFacts.GetEmittedIdentifier(
                    candidate.Name,
                    IdentifierNameContext.General,
                    memberNames
                ) == emittedName
            )
            metadataName = member?.Name
            return member != nil
        }

        private func IsValidAttributeMemberType(type Type) bool {
            if type.IsArray {
                return type.GetArrayRank() == 1 && type.GetElementType() is {} elementType &&
                    IsValidAttributeMemberScalarType(elementType)
            }
            return IsValidAttributeMemberScalarType(type)
        }

        private func IsValidAttributeMemberScalarType(type Type) bool -> type.IsEnum ||
            (
            !type.IsSameAs(typeof(nint)) && !type.IsSameAs(typeof(nuint)) &&
                (
                type.IsPrimitive || type.IsSameAs(typeof(string)) || type.IsSameAs(typeof(Type)) || type.IsSameAs(
                    typeof(object)
                )
            )
        )

        private func WriteCustomAttributeFieldOrPropertyType(bb BlobBuilder, t Type) {
            // ECMA-335 II.23.3 — element-type byte for a FIELD/PROPERTY tag.
            if t.IsSameAs(typeof(bool)) {
                bb.WriteByte(0x02)
            } else if t.IsSameAs(typeof(char)) {
                bb.WriteByte(0x03)
            } else if t.IsSameAs(typeof(int8)) {
                bb.WriteByte(0x04)
            } else if t.IsSameAs(typeof(uint8)) {
                bb.WriteByte(0x05)
            } else if t.IsSameAs(typeof(int16)) {
                bb.WriteByte(0x06)
            } else if t.IsSameAs(typeof(uint16)) {
                bb.WriteByte(0x07)
            } else if t.IsSameAs(typeof(int32)) {
                bb.WriteByte(0x08)
            } else if t.IsSameAs(typeof(uint32)) {
                bb.WriteByte(0x09)
            } else if t.IsSameAs(typeof(int64)) {
                bb.WriteByte(0x0A)
            } else if t.IsSameAs(typeof(uint64)) {
                bb.WriteByte(0x0B)
            } else if t.IsSameAs(typeof(float32)) {
                bb.WriteByte(0x0C)
            } else if t.IsSameAs(typeof(float64)) {
                bb.WriteByte(0x0D)
            } else if t.IsSameAs(typeof(string)) {
                bb.WriteByte(0x0E)
            } else if t.IsSameAs(typeof(Type)) {
                // 0x50 — System.Type (no payload byte; the FixedArg holds the SerString).
                bb.WriteByte(0x50)
            } else if t.IsSameAs(typeof(object)) {
                // 0x51 — boxed object. The FixedArg writer prefixes the runtime
                // type tag and value when emitting the argument body.
                bb.WriteByte(0x51)
            } else if t.IsArray && t.GetArrayRank() == 1 {
                // 0x1D SZARRAY followed by the element type's FieldOrPropType byte.
                bb.WriteByte(0x1D)
                WriteCustomAttributeFieldOrPropertyType(bb, t.GetElementType()!!)
            } else if t.IsEnum {
                // 0x55 then serialised type name (assembly-qualified).
                bb.WriteByte(0x55)
                bb.WriteSerializedString(GetSerializedTypeName(t))
            } else {
                // Fallback to STRING.
                bb.WriteByte(0x0E)
            }
        }
    }
}
