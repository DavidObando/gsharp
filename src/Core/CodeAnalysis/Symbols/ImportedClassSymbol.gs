// <copyright file="ImportedClassSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis

/// Represents an imported class symbol in the language.
class ImportedClassSymbol : Symbol {
    /// Initializes a new instance of the (cref:ImportedClassSymbol) class.
    /// @param type The imported class type.
    /// @param declaration The imported class declaration.
    /// @param symbolicReceiver Issue #1330: when this imported class is the type-erased closed form of a
    /// generic type constructed over an in-scope generic type parameter — e.g.
    /// the `Comparer<object>` backing a `Comparer[TResult]`
    /// static-member receiver — the symbolic constructed view (open definition +
    /// symbolic type arguments) used to recover symbolic member/return types and
    /// to emit static member references parented at the constructed
    /// `Comparer<!TResult>` TypeSpec rather than the erased
    /// `Comparer<object>`. `null` for an ordinary imported class.
    /// @param references The active reference resolver for imported-assembly visibility checks.
    /// @param constructedReceiver The source-level constructed receiver, including ordinary CLR-backed
    /// type arguments whose nullability reflection erases.
    init(
        type Type,
        declaration ExpressionSyntax?,
        symbolicReceiver ImportedTypeSymbol? = nil,
        references ReferenceResolver? = nil,
        constructedReceiver ImportedTypeSymbol? = nil
    ) : base(type.FullName ?? type.Name) {
        ClassType = type
        Declaration = declaration
        SymbolicReceiver = symbolicReceiver
        References = references
        ConstructedReceiver = constructedReceiver ?? symbolicReceiver
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override prop Kind SymbolKind -> SymbolKind.ImportedClass

    /// Gets the imported class type.
    prop ClassType Type {
        get;
    }

    /// Gets the symbolic constructed view of this receiver (#1330) when it
    /// is a generic type closed over an in-scope generic type parameter (e.g.
    /// `Comparer[TResult]`), or `null` for an ordinary imported class.
    /// Carries the open CLR definition and the symbolic type arguments so static
    /// member access recovers symbolic member types and the emitter parents
    /// static member references at the constructed generic TypeSpec.
    prop SymbolicReceiver ImportedTypeSymbol? {
        get;
    }

    /// Gets the source-level constructed receiver, including nullability-only
    /// distinctions that do not require symbolic emission.
    prop ConstructedReceiver ImportedTypeSymbol? {
        get;
    }

    /// Gets the active reference resolver for the current compilation, when
    /// available. Used so imported-member lookup can honor friendship from
    /// `InternalsVisibleTo` on referenced assemblies.
    prop References ReferenceResolver? {
        get;
    }

    /// Gets the imported class declaration.
    prop Declaration ExpressionSyntax? {
        get;
    }

    /// Gets the CLR base type of the source class the lookup happens in, when
    /// that class derives from an imported type. Static member lookup then
    /// also admits `protected` and `protected internal` members
    /// declared on that base or one of its own bases, as C# does for a derived
    /// class (`Regex.ValidateMatchTimeout(...)` inside a class deriving
    /// from `Regex`). `null` outside such a class, so
    /// only public (and friend-internal) members are visible.
    prop FamilyAccessBase Type? {
        get;
        private init;
    }

    /// Returns this symbol with (cref:FamilyAccessBase) set to
    /// [`familyAccessBase`](paramref).
    /// @param familyAccessBase The CLR base type of the enclosing source class, or `null`.
    /// @returns This symbol when nothing changes; otherwise a copy carrying the family-access base.
    func WithFamilyAccessBase(familyAccessBase Type?) ImportedClassSymbol {
        if object.ReferenceEquals(familyAccessBase, FamilyAccessBase) {
            return this
        }
        return ImportedClassSymbol(ClassType, Declaration, SymbolicReceiver, References, ConstructedReceiver){
            FamilyAccessBase = familyAccessBase
        }
    }

    /// Tries to get a static member (field or property) from this imported
    /// class symbol. Static methods continue to flow through
    /// (cref:TryLookupFunction(string, CallExpressionSyntax, ImmutableArray{BoundExpression}, out
    /// ImportedFunctionSymbol)).
    /// @param text The name of the member.
    /// @param ne The name expression (currently unused; reserved for diagnostics).
    /// @param member The resulting member when found.
    /// @returns Whether we found a matching public static field or property.
    func TryLookupMember(text string, ne NameExpressionSyntax?, @NotNullWhen(true) out member MemberInfo?) bool {
        let level = FindNearestNamedMemberLevel(text)
        var property PropertyInfo? = nil
        for candidate in level.Properties {
            if candidate.GetIndexParameters()
                .Length == 0 &&
                IsStatic(candidate) &&
                IsVisibleToCurrentCompilation(candidate) {
                property = candidate
                break
            }
        }
        if property != nil {
            member = property
            return true
        }
        var field FieldInfo? = nil
        for candidate in level.Fields {
            if candidate.IsStatic && IsVisibleToCurrentCompilation(candidate) {
                field = candidate
                break
            }
        }
        if field != nil {
            member = field
            return true
        }
        member = nil
        return false
    }

    /// Tries to get a function from this imported class symbol.
    /// @param text The name of the function.
    /// @param callExpression The call expression.
    /// @param arguments The bound arguments.
    /// @param function The resulting function, if one is found.
    /// @param parameterMapping Issue #343: on success, the per-source-argument → parameter-position map
    /// when the call site used named arguments; default when source order already
    /// matches parameter order (the common path).
    /// @param isAmbiguous Set to true when two or more candidates tied under "better function member"
    /// rules.
    /// @param explicitTypeArgs Issue #311: resolved CLR type arguments from an explicit `[T1, T2]`
    /// list at the call site (e.g. `Array.Empty[string]()`), already
    /// projected onto the reference load context; `null` when the call has
    /// no explicit type arguments.
    /// @param typeArgSymbols Issue #320: explicit type-argument symbols in source order (carrying
    /// user-defined types that were closed with a placeholder CLR type), or default.
    /// @param projectTypeArgument Issue #321: projects an inferred type argument onto the reference load
    /// context so a generic method (e.g. `JsonSerializer.Serialize<T>`)
    /// can be closed via `MakeGenericMethod`. `null` disables projection.
    /// @param argumentNames Issue #343: per-source-argument names parallel to [`arguments`](paramref);
    /// `null` entries denote positional arguments. The default
    /// array indicates an all-positional call site (the common path).
    /// @returns Whether we found a matching function or not.
    func TryLookupFunction(
        text string,
        callExpression CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        @NotNullWhen(true) out function ImportedFunctionSymbol?,
        out parameterMapping ImmutableArray[int32],
        out isAmbiguous bool,
        explicitTypeArgs[]?Type = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        projectTypeArgument((Type) -> Type)? = nil,
        argumentNames IReadOnlyList[string]? = nil
    ) bool -> TryLookupFunction(
        text,
        callExpression,
        arguments,
        out function,
        out parameterMapping,
        out isAmbiguous,
        out _,
        out _,
        explicitTypeArgs,
        typeArgSymbols,
        projectTypeArgument,
        argumentNames
    )

    /// Issue #506: backwards-compatible overload retaining the issue #505
    /// signature without the `isExpanded` flag. Discards the expanded
    /// flag.
    /// @param text The name of the function.
    /// @param callExpression The call expression.
    /// @param arguments The bound arguments.
    /// @param function The resulting function, if one is found.
    /// @param parameterMapping Per-source-argument → parameter-position map (issue #343); default when
    /// none.
    /// @param isAmbiguous Set to `true` when two or more candidates tied under "better function member"
    /// rules.
    /// @param ambiguousMethods When [`isAmbiguous`](paramref) is set, the tied candidates in
    /// source-encounter order; otherwise the empty array.
    /// @param explicitTypeArgs Resolved CLR type arguments from an explicit type-argument list.
    /// @param typeArgSymbols Explicit type-argument symbols in source order, or default.
    /// @param projectTypeArgument Projects an inferred type argument onto the reference load context, or
    /// `null`.
    /// @param argumentNames Per-source-argument names parallel to [`arguments`](paramref).
    /// @returns Whether we found a matching function or not.
    func TryLookupFunction(
        text string,
        callExpression CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        @NotNullWhen(true) out function ImportedFunctionSymbol?,
        out parameterMapping ImmutableArray[int32],
        out isAmbiguous bool,
        out ambiguousMethods ImmutableArray[MethodInfo],
        explicitTypeArgs[]?Type = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        projectTypeArgument((Type) -> Type)? = nil,
        argumentNames IReadOnlyList[string]? = nil
    ) bool -> TryLookupFunction(
        text,
        callExpression,
        arguments,
        out function,
        out parameterMapping,
        out isAmbiguous,
        out ambiguousMethods,
        out _,
        explicitTypeArgs,
        typeArgSymbols,
        projectTypeArgument,
        argumentNames
    )

    /// Issues #505 + #506: extended overload that, on ambiguity, returns the
    /// applicable candidate set (so the caller can surface competing
    /// signatures in the GS0160 diagnostic) and also reports whether the
    /// selected candidate was resolved in `params T[]` expanded form.
    /// @param text The name of the function.
    /// @param callExpression The call expression.
    /// @param arguments The bound arguments.
    /// @param function The resulting function, if one is found.
    /// @param parameterMapping Per-source-argument → parameter-position map (issue #343); default when
    /// none.
    /// @param isAmbiguous Set to `true` when two or more candidates tied under "better function member"
    /// rules.
    /// @param ambiguousMethods When [`isAmbiguous`](paramref) is set, the tied candidates in
    /// source-encounter order; otherwise the empty array.
    /// @param isExpanded Issue #506: set to `true` when overload resolution selected the candidate in
    /// `params T[]` expanded form, signalling the caller to pack the trailing positional arguments into a
    /// synthesised array before emit.
    /// @param explicitTypeArgs Resolved CLR type arguments from an explicit type-argument list.
    /// @param typeArgSymbols Explicit type-argument symbols in source order, or default.
    /// @param projectTypeArgument Projects an inferred type argument onto the reference load context, or
    /// `null`.
    /// @param argumentNames Per-source-argument names parallel to [`arguments`](paramref).
    /// @param refineSymbolicMethodGroupArgs Issue #3712: given the selected method, expanded-form flag, and
    /// pre-resolution symbolic argument vector, returns the vector with each
    /// user method-group slot replaced by the symbolic function type the
    /// winning overload's delegate parameter selects, alongside a parallel
    /// flags array marking which slots were so replaced. `null`
    /// leaves the vector unrefined.
    ///
    /// Issue #4133 (hot-core translation guard finding): the flags array is
    /// forwarded into `MemberLookup.BuildSymbolicMethodTypeArgs` so a
    /// method group's own PARAMETER-type contribution demotes to a
    /// same-slot fallback bound instead of outranking a real one — see
    /// `SymbolicInferenceBoundKind.MethodGroupUpper`. C# never makes an
    /// input inference from a method group (§12.6.3.7); only its return
    /// type is a legitimate output-inference source.
    /// @returns Whether we found a matching function or not.
    func TryLookupFunction(
        text string,
        callExpression CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        @NotNullWhen(true) out function ImportedFunctionSymbol?,
        out parameterMapping ImmutableArray[int32],
        out isAmbiguous bool,
        out ambiguousMethods ImmutableArray[MethodInfo],
        out isExpanded bool,
        explicitTypeArgs[]?Type = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        projectTypeArgument((Type) -> Type)? = nil,
        argumentNames IReadOnlyList[string]? = nil,
        refineSymbolicMethodGroupArgs(
            (MethodInfo, bool, ImmutableArray[TypeSymbol]) -> (
                RefinedArgs ImmutableArray[TypeSymbol],
                MethodGroupSlots ImmutableArray[bool]
            )
        )? = nil
    ) bool -> TryLookupNativeFunction(
        text,
        callExpression,
        arguments,
        out function,
        out parameterMapping,
        out isAmbiguous,
        out ambiguousMethods,
        out isExpanded,
        explicitTypeArgs,
        typeArgSymbols,
        projectTypeArgument,
        argumentNames,
        refineSymbolicMethodGroupArgs
    )

    internal func TryLookupNativeFunction(
        text string,
        callExpression CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        @NotNullWhen(true) out function ImportedFunctionSymbol?,
        out parameterMapping ImmutableArray[int32],
        out isAmbiguous bool,
        out ambiguousMethods ImmutableArray[MethodInfo],
        out isExpanded bool,
        explicitTypeArgs[]?Type = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        projectTypeArgument((Type) -> Type)? = nil,
        argumentNames IReadOnlyList[string]? = nil,
        refineSymbolicMethodGroupArgs(
            (MethodInfo, bool, ImmutableArray[TypeSymbol]) -> (
                RefinedArgs ImmutableArray[TypeSymbol],
                MethodGroupSlots ImmutableArray[bool]
            )
        )? = nil,
        nativeConversions ConversionClassifier? = nil
    ) bool {
        function = nil
        parameterMapping = default(ImmutableArray[int32])
        isAmbiguous = false
        ambiguousMethods = ImmutableArray[MethodInfo].Empty
        isExpanded = false
        let nameMatches = List[MethodInfo]()
        for method in FindNearestNamedMemberLevel(text).Methods {
            if method.IsStatic && IsVisibleToCurrentCompilation(method) {
                nameMatches.Add(method)
            }
        }
        if nameMatches.Count == 0 {
            return false
        }
        let argTypes = [arguments.Length]Type?
        let CheckUserClassInterface = func (source Type, target Type) bool {
            return IsUserClassAssignableToInterface(arguments, argTypes, source, target)
        }
        var hasUserClassArg = false
        // Issue #3907: slots carrying the SymbolicByRefArgumentType sentinel.
        // The sentinel is not a real argument type, so it must be withheld from
        // CLR type inference; the type argument comes from the symbolic vector
        // instead (see the `deferredInferenceArgs` hand-off to Resolve below).
        var symbolicByRefArgs[]?bool = nil
        var deferredInferenceArgs[]?bool = nil
        for var i = 0; i < arguments.Length; i++ {
            if TypeSymbol.ContainsNullLiteralType(arguments[i].Type) {
                deferredInferenceArgs ??= [arguments.Length]bool
                deferredInferenceArgs!![i] = true
            }
            // Issue #1391: the untyped `default` literal (bound as a
            // BoundDefaultExpression whose type is the Error sentinel until a
            // target type is known) is convertible to any parameter type. Pass
            // the dedicated overload-resolution sentinel so it stays applicable
            // against an imported generic method closed over an explicit type
            // argument; the concrete-typed default is materialized downstream by
            // BindClrParameterConversions against the resolved parameter type.
            if arguments[i] is BoundDefaultExpression{Type: var defType} && defType == TypeSymbol.Error {
                argTypes[i] = ClrOverloadResolution.DefaultLiteralArgumentType
                continue
            }
            // Issue #1538: an inline `out var`/`out let`/`out _` argument whose
            // type is omitted was bound in the eager first pass to a placeholder
            // address-of over an Error operand (no local declared yet, because
            // the out-parameter type was not known). Feed the dedicated sentinel
            // so overload resolution treats it as matching any by-ref parameter;
            // the caller re-binds the placeholder to the chosen overload's
            // out-parameter (pointee) type via RebindInlineOutVarArguments. This
            // mirrors the imported-instance path (ExpressionBinder.Calls.cs) so a
            // static/overloaded imported call (`int32.TryParse(s, out var n)`)
            // resolves instead of collapsing to GS0159 and poisoning the body.
            if arguments[i] is BoundAddressOfExpression{Operand: {Type: var outVarPointee}} &&
                outVarPointee == TypeSymbol.Error {
                argTypes[i] = ClrOverloadResolution.InlineOutVarArgumentType
                continue
            }
            // Issue #1599: a pre-declared `out r` (or `ref`) whose pointee is a
            // same-compilation user value type (a user enum or non-class struct)
            // has no reference-context CLR type, so its by-ref erasure cannot
            // match a value-type-constrained generic by-ref parameter such as the
            // `out TEnum` of `Enum.TryParse[Color](string, out r)` (the parameter
            // is closed over an `object`/placeholder erasure). Feed the same
            // "matches any by-ref parameter" sentinel used for inline `out var`
            // so the value-type-constrained generic overload stays applicable;
            // the recovered explicit type-argument symbols drive the constraint
            // check and emit. Without this the call collapses to GS0159.
            // Issue #1601: the same holds when the pointee is a value-type
            // (`struct`) constrained generic type parameter (e.g. a `TEnum`
            // forwarded from an enclosing `[TEnum Enum struct]`), which is also
            // erased to the placeholder and has no reference-context CLR type.
            if arguments[i] is BoundAddressOfExpression{Operand: {Type: var byRefPointee}} &&
                (
                (byRefPointee is EnumSymbol or StructSymbol and {IsClass: false}) ||
                    byRefPointee is TypeParameterSymbol &&
                    byRefPointee.HasValueTypeConstraint == true
            ) &&
                byRefPointee.ClrType == nil {
                argTypes[i] = ClrOverloadResolution.InlineOutVarArgumentType
                continue
            }
            // Issue #3907: the REFERENCE-type counterpart of #1599 above. A
            // pre-declared `ref`/`out` whose pointee is a same-compilation user
            // class/interface/named delegate also has no CLR type while
            // binding, and issue #658's `object` ride-through — correct for a
            // by-VALUE argument, since a class instance really is an `object` —
            // is wrong by REFERENCE: C# requires a `ref` argument to match its
            // parameter exactly, so `ref Node` is not a `ref object`. Left
            // erased, `Interlocked.Exchange(&nodeField, nil)` made the
            // non-generic `Exchange(ref object?, object?)` an exact IDENTITY
            // match, so it beat `Exchange[T](ref T, T) where T : class` and the
            // call's type silently became `object` (GS0156 at the use site, or
            // worse, no diagnostic at all where the result is discarded).
            // The dedicated sentinel keeps the argument neutral during
            // betterness ranking; `ExcludeNonGenericByRefCandidates` below
            // drops the overloads it cannot legally reach, and the type
            // argument is recovered from `symbolicArgVector`.
            if arguments[i] is BoundAddressOfExpression{Operand: {Type: {} refPointee}} &&
                IsSameCompilationUserReferencePointee(refPointee) {
                argTypes[i] = ClrOverloadResolution.SymbolicByRefArgumentType
                symbolicByRefArgs ??= [arguments.Length]bool
                symbolicByRefArgs!![i] = true
                deferredInferenceArgs ??= [arguments.Length]bool
                deferredInferenceArgs!![i] = true
                continue
            }
            // Issue #530: use effective CLR type so nullable value types
            // (e.g. int32?) are matched as Nullable<T> in overload resolution.
            // Issue #533: allow null (nil literal) through; overload resolution
            // now classifies null source as compatible with reference types and
            // Nullable<T>.
            // Issue #658: provide surrogate type for user-defined G# classes.
            var t Type? = NullableTypeSymbol.GetEffectiveClrType(arguments[i].Type)
            if t == nil && arguments[i].Type != TypeSymbol.Null {
                if ClrOverloadResolution.IsUnresolvedMethodGroupArgument(arguments[i]) {
                    argTypes[i] = nil
                    continue
                }
                if arguments[i].Type is StructSymbol{IsClass: true} ss {
                    t = TypeMemberModel.GetNearestImportedBase(ss)?.ClrType ?? typeof(object)
                    hasUserClassArg = true
                } else if arguments[i].Type is InterfaceSymbol || arguments[i].Type is DelegateTypeSymbol {
                    // Issue #1421 / ADR-0087 §3 R5: a user-defined G# interface or
                    // named delegate argument carries no ClrType during binding
                    // (its TypeDef only exists in the assembly being emitted), so
                    // GetEffectiveClrType returned null above. It rides through the
                    // same `object` boundary as a user struct — an interface value
                    // is reference-convertible to `object` — so overload resolution
                    // can pick an `object`(?) parameter (e.g.
                    // `ArgumentNullException.ThrowIfNull(object?)`). Mirrors
                    // ExpressionBinder.GetEffectiveArgumentClrTypeForOverloadResolution.
                    t = typeof(object)
                } else if arguments[i].Type is EnumSymbol {
                    // Issue #661: user-defined G# enum — backed by int32 at CLR level.
                    t = typeof(int32)
                } else if (arguments[i].Type is NullableTypeSymbol and {UnderlyingType: EnumSymbol}) {
                    // Issue #661: Nullable<UserEnum> — map to Nullable<int>.
                    t = typeof(int32?)
                } else if MemberLookup.TryProjectErasedClrType(arguments[i].Type, out var erased) {
                    // Issue #833: argument carries an open method/type
                    // parameter (e.g. `T`, `[]T`, `IEnumerable[T]`). The
                    // overload-resolution layer needs *some* CLR type to
                    // unify against the candidate's open generic parameter,
                    // so project the TP positions to `object` (and slices
                    // to `object[]`). Symbolic recovery for the return
                    // type and MethodSpec args happens via
                    // BuildSymbolicMethodTypeArgs +
                    // ResolveCallReturnTypeFromSymbolicTypeArgs below.
                    t = erased
                } else {
                    return false
                }
            }
            argTypes[i] = t
        }
        // Issue #658 / #1634: supplementary interface check for user-class args,
        // threaded as a call-local parameter into Resolve instead of a shared
        // static so nested/concurrent binds can't clobber it.
        var supplementaryInterfaceCheck((Type, Type) -> bool)? = nil
        if hasUserClassArg {
            supplementaryInterfaceCheck = CheckUserClassInterface
        }
        // Issue #1325: recover the symbolic type-argument vector per candidate
        // so the generic-constraint check can see through the `object`
        // erasure of same-compilation user value types (a user struct must
        // satisfy `where T : struct`, e.g. MemoryMarshal.Cast/AsBytes).
        let symbolicArgVector = MemberLookup.BuildSymbolicArgTypeVector(
            receiverType: nil,
            ImmutableArray.CreateRange(arguments.Select((a BoundExpression) -> a.Type))
        )
        let filteredNameMatches = List[MethodInfo]()
        for method in MemberLookup.ExcludeNonGenericByRefCandidates(
            MemberLookup.ExcludeErasureOnlyEnumCandidates(
                nameMatches,
                symbolicArgVector,
                argumentNames,
                SymbolicReceiver
            ),
            symbolicByRefArgs,
            argumentNames
        ) {
            filteredNameMatches.Add(method)
        }
        // Issue #3501: `structuralProjectionArgumentCheck` (the ADR-0148
        // symbol-aware applicability fallback) was wired on the
        // instance/extension call paths but not here — a `[T ImportedBase]`-
        // typed argument erases to `object`, so a static imported call like
        // `ImmutableArray.Create[Base](T())` found no applicable candidate
        // even though `T -> Base` is a constraint-proven implicit conversion.
        let result = ClrOverloadResolution.Resolve[MethodInfo](
            filteredNameMatches,
            argTypes,
            explicitTypeArgs,
            projectTypeArgument,
            ComputeInterpolatedStringArgFlags(callExpression, arguments.Length),
            argumentNames,
            (closed MethodInfo, isExpanded bool) -> {
                let refined = refineSymbolicMethodGroupArgs?(closed, isExpanded, symbolicArgVector)
                return MemberLookup.BuildSymbolicMethodTypeArgs(
                    closed,
                    typeArgSymbols,
                    refined?.Item1 ?? symbolicArgVector,
                    isExpanded,
                    argumentNames,
                    refined?.Item2 ?? default(ImmutableArray[bool])
                )
            },
            supplementaryInterfaceCheck: supplementaryInterfaceCheck,
            constantNarrowingArgumentCheck: ExpressionBinder.MakeConstantNarrowingArgumentCheck(arguments),
            structuralProjectionArgumentCheck: ExpressionBinder.MakeStructuralProjectionArgumentCheck(
                arguments,
                nativeConversions: nativeConversions
            ),
            erasedArgumentMismatchCheck: ExpressionBinder.MakeErasedArgumentMismatchCheck(arguments),
            explicitTypeArgIsGenuine: ClrOverloadResolution.BuildGenuineExplicitTypeArgFlags(typeArgSymbols),
            explicitTypeArgumentMismatchCheck: ExpressionBinder.MakeExplicitTypeArgumentMismatchCheck(
                arguments,
                typeArgSymbols
            ),
            delegateRefKindArgumentCheck: ExpressionBinder.MakeDelegateRefKindArgumentCheck(arguments),
            methodGroupInference: ExpressionBinder.MakeMethodGroupInference(
                arguments,
                func (type TypeSymbol) Type? {
                    return Invariant.Required(
                        ProjectMethodGroupType(type),
                        "an imported method-group type must be projectable",
                        expression: "ProjectMethodGroupType(type)"
                    )
                }
            ),
            methodGroupArgumentCheck: ExpressionBinder.MakeMethodGroupArgumentCheck(arguments),
            deferredInferenceArgs: deferredInferenceArgs,
            openLiteralArgumentCheck: ExpressionBinder.MakeOpenLiteralArgumentCheck(arguments),
            symbolicArgTypes: symbolicArgVector,
            symbolicArgumentConversionClassifier: ExpressionBinder.MakeSymbolicArgumentConversionClassifier(
                arguments,
                nativeConversions: nativeConversions
            )
        )
        switch result.Outcome {
            case ClrOverloadResolution.ResolutionOutcome.Resolved {
                // Issue #320: when an imported generic method returns exactly one
                // of its method type parameters and was closed over a user-defined
                // type argument (placeholder CLR type), recover the real return
                // type from the explicit type-argument symbol.
                var returnOverride TypeSymbol? = nil
                let bestMethod = Invariant.Required(
                    result.Best,
                    "a resolved overload has a selected method",
                    expression: "result.Best"
                )
                if !typeArgSymbols.IsDefaultOrEmpty && ClrOverloadResolution.TryGetGenericMethodParameterReturnPosition(
                    bestMethod,
                    out var position
                ) &&
                    position >= 0 &&
                    position < typeArgSymbols
                    .Length {
                    // #4451: the explicit-argument rule, as in
                    // BuildSymbolicMethodTypeArgs (an oblivious slot gives T!).
                    returnOverride = MemberLookup.ApplyExplicitMethodTypeArgument(
                        bestMethod,
                        position,
                        typeArgSymbols[position]
                    )
                }
                // Issue #833: when the open return type *contains* (but is not
                // exactly) a method type parameter that aligns with an in-scope
                // G# type parameter (e.g. `Enumerable.Empty[T]() IEnumerable[T]`),
                // recover the symbolic projection so the call site doesn't keep
                // the type-erased `IEnumerable<object>`.
                if returnOverride == nil {
                    // Issue #3712: a user method group has no natural type
                    // before the target delegate is known, so its slot in
                    // `symbolicArgVector` is the Error sentinel. Refine it
                    // against the winning candidate, or a group whose return
                    // type is a same-compilation user class leaves the call
                    // closed over that type's `object` erasure.
                    let refinedForReturn = refineSymbolicMethodGroupArgs?(
                        bestMethod,
                        result.IsExpanded,
                        symbolicArgVector
                    )
                    let symbolicMethodTypeArgs = MemberLookup.BuildSymbolicMethodTypeArgs(
                        bestMethod,
                        typeArgSymbols,
                        refinedForReturn?.Item1 ?? symbolicArgVector,
                        result.IsExpanded,
                        argumentNames,
                        refinedForReturn?.Item2 ?? default(ImmutableArray[bool])
                    )
                    returnOverride = MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(
                        bestMethod,
                        symbolicMethodTypeArgs,
                        receiverType: nil
                    )
                }
                function = ImportedFunctionSymbol(text, this, bestMethod, callExpression, returnOverride)
                parameterMapping = result.ParameterMapping
                isExpanded = result.IsExpanded
                return true
            }
            case ClrOverloadResolution.ResolutionOutcome.Ambiguous {
                isAmbiguous = true
                ambiguousMethods = result.Ambiguous
                return false
            }
            default {
                return false
            }
        }
    }

    /// Backwards-compatible overload retaining the original signature
    /// (without parameter-mapping output). Calls the named-argument-aware
    /// overload with a default mapping.
    /// @param text The name of the function.
    /// @param callExpression The call expression.
    /// @param arguments The bound arguments.
    /// @param function The resulting function, if one is found.
    /// @param isAmbiguous Set to true when two or more candidates tied under "better function member"
    /// rules.
    /// @param explicitTypeArgs Resolved CLR type arguments from an explicit type-argument list.
    /// @param typeArgSymbols Explicit type-argument symbols in source order, or default.
    /// @param projectTypeArgument Projects an inferred type argument onto the reference load context, or
    /// `null`.
    /// @returns Whether we found a matching function or not.
    func TryLookupFunction(
        text string,
        callExpression CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        @NotNullWhen(true) out function ImportedFunctionSymbol?,
        out isAmbiguous bool,
        explicitTypeArgs[]?Type = nil,
        typeArgSymbols ImmutableArray[TypeSymbol] = default(ImmutableArray[TypeSymbol]),
        projectTypeArgument((Type) -> Type)? = nil
    ) bool -> TryLookupFunction(
        text,
        callExpression,
        arguments,
        out function,
        out _,
        out isAmbiguous,
        explicitTypeArgs,
        typeArgSymbols,
        projectTypeArgument
    )

    /// Backwards-compatible overload that drops the ambiguity flag.
    /// @param text The name of the function.
    /// @param callExpression The call expression.
    /// @param arguments The bound arguments.
    /// @param function The resulting function, if one is found.
    /// @returns Whether we found a matching function or not.
    func TryLookupFunction(
        text string,
        callExpression CallExpressionSyntax,
        arguments ImmutableArray[BoundExpression],
        @NotNullWhen(true) out function ImportedFunctionSymbol?
    ) bool -> TryLookupFunction(text, callExpression, arguments, out function, out _)

    /// Gets the visible static methods from the nearest declaration level that
    /// contains [`text`](paramref). A declaration on a derived type hides
    /// every same-named base member when it is accessible, including when it is
    /// not a static method.
    /// @param text The method-group name.
    /// @returns The visible, non-special static methods at the winning level.
    internal func GetStaticMethodGroup(text string) ImmutableArray[MethodInfo] {
        let methods = ImmutableArray.CreateBuilder[MethodInfo]()
        for method in FindNearestNamedMemberLevel(text).Methods {
            if method.IsStatic &&
                !method.IsGenericMethodDefinition &&
                !method.IsSpecialName &&
                IsVisibleToCurrentCompilation(method) {
                methods.Add(method)
            }
        }
        return methods.ToImmutable()
    }

    /// Whether the nearest declaration level named [`text`](paramref)
    /// holds a static method visible from the lookup site, including a
    /// generic one. An unqualified call inside a derived class uses this to
    /// decide whether an inherited imported static method is in scope before
    /// committing to bind it.
    /// @param text The method name.
    /// @returns `true` when a visible static method of that name is inherited.
    internal func HasVisibleStaticMethod(text string) bool {
        for method in FindNearestNamedMemberLevel(text).Methods {
            if method.IsStatic {
                return true
            }
        }
        return false
    }

    /// Whether a `protected` member declared on
    /// [`declaringType`](paramref) is reachable from the lookup site: the
    /// declaring type is the (cref:FamilyAccessBase) or one of its
    /// bases. C# lets a derived class reach an inherited protected static
    /// member through any type name, so the lookup's own
    /// (cref:ClassType) does not matter, only where the member is
    /// declared.
    /// @param declaringType The member's declaring type.
    /// @returns `true` when the lookup site derives from the declaring type.
    internal func IsFamilyAccessible(declaringType Type?) bool {
        if FamilyAccessBase == nil || declaringType == nil {
            return false
        }
        let familyAccessBase = FamilyAccessBase!!
        let declaringDefinition = if declaringType.IsGenericType {
            declaringType.GetGenericTypeDefinition()
        } else {
            declaringType
        }
        for var current Type? = familyAccessBase; current != nil; current = GetBaseTypeSafe(current!!) {
            let currentDefinition = if current.IsGenericType {
                current.GetGenericTypeDefinition()
            } else {
                current
            }
            if current.IsSameAs(declaringType) || currentDefinition.IsSameAs(declaringDefinition) {
                return true
            }
        }
        return false
    }

    private func FindNearestNamedMemberLevel(name string) NamedMemberLevel {
        const Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly
        for var current Type? = ClassType; current != nil; current = GetBaseTypeSafe(current!!) {
            let methodBuilder = ImmutableArray.CreateBuilder[MethodInfo]()
            for method in ClrTypeUtilities.SafeGetMethods(current, Flags) {
                if string.Equals(method.Name, name, StringComparison.Ordinal) && IsVisibleToCurrentCompilation(method) {
                    methodBuilder.Add(method)
                }
            }
            let methods = methodBuilder.ToImmutable()
            let propertyBuilder = ImmutableArray.CreateBuilder[PropertyInfo]()
            for property in ClrTypeUtilities.SafeGetProperties(current, Flags) {
                if string.Equals(property.Name, name, StringComparison.Ordinal) &&
                    IsVisibleToCurrentCompilation(property) {
                    propertyBuilder.Add(property)
                }
            }
            let properties = propertyBuilder.ToImmutable()
            let fieldBuilder = ImmutableArray.CreateBuilder[FieldInfo]()
            for field in ClrTypeUtilities.SafeGetFields(current, Flags) {
                if string.Equals(field.Name, name, StringComparison.Ordinal) && IsVisibleToCurrentCompilation(field) {
                    fieldBuilder.Add(field)
                }
            }
            let fields = fieldBuilder.ToImmutable()
            var declaresEvent = false
            for eventInfo in ClrTypeUtilities.SafeGetEvents(current, Flags) {
                if string.Equals(eventInfo.Name, name, StringComparison.Ordinal) &&
                    IsVisibleToCurrentCompilation(eventInfo) {
                    declaresEvent = true
                    break
                }
            }
            if !methods.IsEmpty ||
                !properties.IsEmpty ||
                !fields.IsEmpty ||
                declaresEvent ||
                DeclaresVisibleNestedType(current, name) {
                return NamedMemberLevel(methods, properties, fields)
            }
        }
        return NamedMemberLevel.Empty
    }

    private func DeclaresVisibleNestedType(type Type, name string) bool {
        try {
            let nested Type? = type.GetNestedType(name, BindingFlags.Public | BindingFlags.NonPublic)
            return nested != nil &&
                (
                nested.IsNestedPublic ||
                    (nested.IsNestedAssembly && References?.CanAccessInternalMembers(nested.Assembly) == true)
            )
        } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
            return false
        }
    }

    private func IsVisibleToCurrentCompilation(method MethodBase) bool -> method.IsPublic ||
        (method.IsAssembly && References?.CanAccessInternalMembers(method.DeclaringType?.Assembly) == true) ||
        ((method.IsFamily || method.IsFamilyOrAssembly) && IsFamilyAccessible(method.DeclaringType))

    private func IsVisibleToCurrentCompilation(field FieldInfo) bool -> field.IsPublic ||
        (field.IsAssembly && References?.CanAccessInternalMembers(field.DeclaringType?.Assembly) == true) ||
        ((field.IsFamily || field.IsFamilyOrAssembly) && IsFamilyAccessible(field.DeclaringType))

    private func IsVisibleToCurrentCompilation(property PropertyInfo) bool {
        let getter MethodInfo? = property.GetMethod
        let setter MethodInfo? = property.SetMethod
        return (getter != nil && IsVisibleToCurrentCompilation(getter)) ||
            (setter != nil && IsVisibleToCurrentCompilation(setter))
    }

    private func IsVisibleToCurrentCompilation(eventInfo EventInfo) bool {
        let add MethodInfo? = eventInfo.AddMethod
        let remove MethodInfo? = eventInfo.RemoveMethod
        return (add != nil && IsVisibleToCurrentCompilation(add)) ||
            (remove != nil && IsVisibleToCurrentCompilation(remove))
    }

    private data struct NamedMemberLevel(
        Methods ImmutableArray[MethodInfo],
        Properties ImmutableArray[PropertyInfo],
        Fields ImmutableArray[FieldInfo]
    ) : IEquatable[NamedMemberLevel] {
        shared {
            private let _empty NamedMemberLevel = NamedMemberLevel(
                ImmutableArray[MethodInfo].Empty,
                ImmutableArray[PropertyInfo].Empty,
                ImmutableArray[FieldInfo].Empty
            )

            prop Empty NamedMemberLevel {
                get {
                    return _empty
                }
            }
        }
    }

    shared {
        private func ProjectMethodGroupType(type TypeSymbol) Type? {
            let clrType Type? = NullableTypeSymbol.GetEffectiveClrType(type)
            if clrType != nil {
                return clrType
            }
            if type is StructSymbol{IsClass: true} userClass {
                return TypeMemberModel.GetNearestImportedBase(userClass)?.ClrType ?? typeof(object)
            }
            if type is EnumSymbol {
                return typeof(int32)
            }
            return if MemberLookup.TryProjectErasedClrType(type, out var erased) {
                erased
            } else {
                default(Type?)
            }
        }

        /// ADR-0055 Tier 4 (#369): produces the per-argument flags marking which
        /// positional call arguments are interpolated-string literals, so overload
        /// resolution can treat them as convertible to
        /// `IFormattable`/`FormattableString` parameters. Returns
        /// `null` when no argument qualifies (the common path).
        private func ComputeInterpolatedStringArgFlags(callExpression CallExpressionSyntax?, count int32) IReadOnlyList[
            bool
        ]? {
            if callExpression == nil {
                return nil
            }
            var flags[]?bool = nil
            let argumentSyntax = callExpression.Arguments
            let limit = Math.Min(count, argumentSyntax.Count)
            for var i = 0; i < limit; i++ {
                // Issue #377 sub-item 5: an interpolated string passed as a named
                // argument (`M(arg: $"…")`) is wrapped by NamedArgumentExpressionSyntax.
                // Unwrap before classifying so Tier-4 target typing flows through
                // named arguments as well as positional ones.
                let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argumentSyntax[i])
                if argSyntax is InterpolatedStringExpressionSyntax {
                    flags ??= [count]bool
                    flags!![i] = true
                }
            }
            return flags
        }

        private func GetBaseTypeSafe(type Type) Type? {
            try {
                return type.BaseType
            } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
                return nil
            }
        }

        private func IsStatic(property PropertyInfo) bool -> property
            .GetMethod
            ?.IsStatic == true ||
            property
            .SetMethod
            ?.IsStatic == true

        /// Issue #3907: whether a by-ref argument's pointee is a same-compilation
        /// user REFERENCE type — a G# `class`, interface or named delegate
        /// whose CLR (cref:Type) does not exist yet — optionally behind a
        /// reference-nullable `?`, which is a pure annotation and does not
        /// change the pointee's runtime representation.
        /// @remarks A same-compilation user VALUE type is deliberately excluded: it is
        /// already handled by the #1599/#1601 branch above, whose sentinel has the
        /// wider "matches any by-ref parameter" meaning those cases need.
        /// @param pointee The by-ref argument's pointee type.
        /// @returns `true` when the sentinel applies.
        private func IsSameCompilationUserReferencePointee(pointee TypeSymbol) bool {
            var pointee = pointee
            while pointee is NullableTypeSymbol nullable && !NullableLifting.IsAnyValueTypeNullable(nullable) &&
                nullable.UnderlyingType != nil {
                pointee = nullable.UnderlyingType
            }
            return pointee.ClrType == nil &&
                (
                pointee is StructSymbol &&
                    pointee.IsClass == true ||
                    pointee is InterfaceSymbol ||
                    pointee is DelegateTypeSymbol
            )
        }

        /// Issue #658: checks whether a user-defined G# class argument implements
        /// the specified CLR target interface.
        private func IsUserClassAssignableToInterface(
            boundArguments ImmutableArray[BoundExpression],
            argTypes[]Type?,
            source Type,
            target Type
        ) bool {
            for var i = 0; i < boundArguments.Length; i++ {
                if !ClrTypeUtilities.AreSame(argTypes[i], source) {
                    continue
                }
                if boundArguments[i].Type is StructSymbol{IsClass: true} ss {
                    for current in ss.GetHierarchy() {
                        for iface in current.ImplementedClrInterfaces {
                            if iface.ClrType != nil &&
                                (
                                ClrTypeUtilities.AreSame(iface.ClrType, target) ||
                                    ClrTypeUtilities.ImplementsInterfaceByName(iface.ClrType, target)
                            ) {
                                return true
                            }
                        }
                    }
                    if ss.ImportedBaseType?.ClrType != nil && ClrTypeUtilities.ImplementsInterfaceByName(
                        ss.ImportedBaseType!!.ClrType,
                        target
                    ) {
                        return true
                    }
                }
            }
            return false
        }
    }
}
