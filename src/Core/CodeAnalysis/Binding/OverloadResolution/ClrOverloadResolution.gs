// <copyright file="ClrOverloadResolution.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding.OverloadResolution

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import System.Text

/// Shared C#-style "better function member" overload resolution used by the
/// binder for CLR constructor calls, static method calls on imported classes,
/// and instance method calls on imported CLR receivers. The resolver is a pure
/// function: it consumes a candidate list of (cref:MethodBase) values
/// and the CLR types of the bound arguments, and returns a single best match,
/// an ambiguity, or "no applicable candidate".
/// @remarks Implements a deliberately scoped subset of the C# §7.5.3 algorithm. User-
/// defined implicit conversions (Stream E) are wired in through the
/// (cref:UserDefinedImplicitConversionLookup) callback so this file can
/// land before the conversion work.
internal shared class ClrOverloadResolution {
    /// Classification of an implicit conversion from one CLR type to another.
    /// Lower ordinal values are "better" conversions and win in tie-breaking.
    enum ImplicitConversionKind {
        None,
        Identity,
        NumericWidening,
        Reference,
        Boxing,
        NullableWrap,
        UserDefinedImplicit,
        InterpolatedStringHandler,
        InterpolatedStringToFormattable,
        LambdaToVoidDelegate,
        DelegateReturnCovariance,
        DelegateStructuralMatch,
        DelegateReturnNumericWidening,
        ConstantNarrowing,
        StructuralProjection,
        DelegateRefKindMismatch
    }

    /// Outcome of an overload-resolution attempt.
    enum ResolutionOutcome {
        NoneApplicable,
        Resolved,
        Ambiguous
    }

    /// Issue #2172: the shape of an OPEN generic delegate parameter's return
    /// type, used to prefer `Func<Task<TResult>>` over
    /// `Func<TResult>` for a task-returning lambda argument.
    private enum TaskLambdaDelegateShape {
        Other,
        BareTypeParameter,
        TaskShaped
    }

    /// Result of resolving a candidate set.
    /// @typeparam T Candidate kind ((cref:MethodInfo) or (cref:ConstructorInfo)).
    struct Result[T MethodBase] {
        private init(
            outcome ResolutionOutcome,
            best T?,
            ambiguous ImmutableArray[T],
            parameterMapping ImmutableArray[int32],
            isExpanded bool
        ) {
            Outcome = outcome
            Best = best
            Ambiguous = ambiguous
            ParameterMapping = parameterMapping
            IsExpanded = isExpanded
        }

        /// Gets the resolution outcome.
        prop Outcome ResolutionOutcome {
            get;
        }

        /// Gets the unique best candidate when (cref:Outcome) is (cref:ResolutionOutcome.Resolved); otherwise
        /// `null`.
        prop Best T? {
            get;
        }

        /// Gets the candidates participating in an ambiguity, in source-encounter order.
        prop Ambiguous ImmutableArray[T] {
            get;
        }

        /// Gets the per-source-argument → parameter-position mapping (issue
        /// #343) when the call site supplied named arguments.
        /// (cref:ImmutableArray{Int32}.IsDefault) is `true`
        /// when no reordering took place (positional-only call), in which case
        /// the identity mapping is implied.
        prop ParameterMapping ImmutableArray[int32] {
            get;
        }

        /// Gets a value indicating whether issue #506: the resolved candidate
        /// was selected in <em>expanded</em> form, i.e. the trailing
        /// `params T[]` parameter packs zero or more positional arguments
        /// from the call site into a synthesised `T[]`. Callers must
        /// repack the trailing arguments into a slice/array creation before
        /// emit. Always `false` when (cref:Outcome) is
        /// not (cref:ResolutionOutcome.Resolved).
        prop IsExpanded bool {
            get;
        }

        shared {
            internal func NoneApplicable() Result[T] -> Result[T](
                ResolutionOutcome.NoneApplicable,
                default(T?),
                ImmutableArray[T].Empty,
                default(ImmutableArray[int32]),
                false
            )

            internal func Single(best T) Result[T] -> Result[T](
                ResolutionOutcome.Resolved,
                best,
                ImmutableArray[T].Empty,
                default(ImmutableArray[int32]),
                false
            )

            internal func Single(best T, parameterMapping ImmutableArray[int32]) Result[T] -> Result[T](
                ResolutionOutcome.Resolved,
                best,
                ImmutableArray[T].Empty,
                parameterMapping,
                false
            )

            internal func Single(best T, parameterMapping ImmutableArray[int32], isExpanded bool) Result[T] -> Result[
                T
            ](ResolutionOutcome.Resolved, best, ImmutableArray[T].Empty, parameterMapping, isExpanded)

            internal func AmbiguousResult(tied ImmutableArray[T]) Result[T] -> Result[T](
                ResolutionOutcome.Ambiguous,
                default(T?),
                tied,
                default(ImmutableArray[int32]),
                false
            )
        }
    }

    /// Issue #1325: a value-type stand-in used to close a generic method over a
    /// same-compilation user value type under live reflection. The user value
    /// type has no reference-context CLR type during binding (it is erased to
    /// `System.Object`), and the live-reflection
    /// (cref:MethodInfo.MakeGenericMethod(Type[])) rejects `object`
    /// against a `where T : struct` parameter. Closing over this
    /// placeholder yields a valid (cref:MethodInfo); the placeholder is
    /// then rewritten back to `object` in the candidate's parameter types
    /// (see (cref:SubstituteClrType)) so applicability still matches the
    /// `object`-erased argument types, and emit uses the recovered symbolic
    /// type arguments rather than this placeholder.
    private struct UserValueTypeConstraintPlaceholder { }

    /// Issue #977: private marker type whose (cref:Type) identity is used as
    /// the (cref:InlineOutVarArgumentType) sentinel for inline `out var`
    /// arguments during overload resolution. Never instantiated.
    private class InlineOutVarArgumentMarker { }

    /// Issue #1391: private marker type whose (cref:Type) identity is used
    /// as the (cref:DefaultLiteralArgumentType) sentinel for an untyped
    /// `default` literal argument during overload resolution. Never instantiated.
    private class DefaultLiteralArgumentMarker { }

    /// Issue #3907: private marker type whose (cref:Type) identity is used
    /// as the (cref:SymbolicByRefArgumentType) sentinel for a by-ref
    /// argument over a same-compilation user reference type. Never instantiated.
    private class SymbolicByRefArgumentMarker { }

    /// Issue #4037: the depth bound on a walk of forwarded class constraints
    /// (`[T U]` whose `U` is itself constrained). No real declaration
    /// nests bounds this deep; the bound exists so a cyclic chain terminates.
    private const ForwardedBoundChainLimit int32 = 32

    /// Issue #4041: the shape and the symbol agree.
    private const DependentShapeMatches int32 = 1

    /// Issue #4041: the shape and the symbol demonstrably disagree.
    private const DependentShapeDiffers int32 = 0

    /// Issue #4041: the symbols cannot settle it; use the CLR comparison.
    private const DependentShapeIndeterminate int32 = -1

    // C# §7.5.3.4 "Better conversion target" — signed integral T1 beats unsigned
    // integral T2 in this map. Used only as a secondary signed/unsigned tie-break
    // when the implicit-conversion direction between T1 and T2 does not resolve
    // the ordering (e.g. int vs. uint: neither implicitly converts to the other).
    private let SignedBeatsUnsigned Dictionary[string, HashSet[string]] = Dictionary[string, HashSet[string]](
        StringComparer.Ordinal
    ){
        ["System.SByte"] = HashSet[string](StringComparer.Ordinal){
            "System.Byte",
            "System.UInt16",
            "System.UInt32",
            "System.UInt64"
        },
        ["System.Int16"] = HashSet[string](StringComparer.Ordinal){"System.UInt16", "System.UInt32", "System.UInt64"},
        ["System.Int32"] = HashSet[string](StringComparer.Ordinal){"System.UInt32", "System.UInt64"},
        ["System.Int64"] = HashSet[string](StringComparer.Ordinal){"System.UInt64"}
    }

    /// Gets or sets the optional hook invoked when no built-in implicit
    /// conversion exists. Returns `true` when the caller has
    /// a user-defined `op_Implicit` method that converts the source type
    /// to the target type. Stream E supplies the implementation; until then
    /// this stays `null` and the classifier returns
    /// (cref:ImplicitConversionKind.None).
    prop UserDefinedImplicitConversionLookup((Type, Type) -> bool)?

    /// ADR-0060 / issue #977: sentinel argument type representing an inline
    /// `out var`/`out let`/`out _` declaration whose local type is
    /// not yet known. Such an argument is applicable to — and only to — a by-ref
    /// (`ref`/`out`/`in`) parameter; its declared local type is
    /// inferred from the chosen overload's parameter after resolution succeeds.
    /// Using a dedicated marker keeps the out-var neutral during betterness
    /// ranking (it always classifies as an identity conversion against a by-ref
    /// parameter) while still rejecting non-by-ref candidates.
    let InlineOutVarArgumentType Type = typeof(InlineOutVarArgumentMarker)

    /// Issue #1391: sentinel argument type representing the untyped `default`
    /// literal whose concrete type is supplied by the chosen parameter. The bare
    /// `default` is implicitly convertible to <em>any</em> type (its value is
    /// the zero/null of whatever parameter type it lands on), so during overload
    /// resolution against an imported (CLR) method it must classify as applicable
    /// to every (non-by-ref) parameter — mirroring the user-defined generic method
    /// path, which already accepts `default`. Using a dedicated marker keeps
    /// the literal neutral during betterness ranking (always an identity
    /// conversion) while the concrete-typed default is materialized by
    /// `BindClrParameterConversions` against the resolved parameter type.
    let DefaultLiteralArgumentType Type = typeof(DefaultLiteralArgumentMarker)

    /// Issue #3907: sentinel argument type representing a by-ref
    /// (`ref`/`out`/`in`) argument whose pointee is a
    /// same-compilation user REFERENCE type — a G# `class`, interface or
    /// named delegate the current compilation is still emitting, and which
    /// therefore has no CLR (cref:Type) to match against.
    /// @remarks By VALUE such an argument rides through the `object`
    /// boundary harmlessly (issue #658) — a class instance really is an
    /// `object`. By REFERENCE it does not: C# requires a `ref`
    /// argument to match its parameter EXACTLY, so `ref Node` is not a
    /// `ref object`. Erasing it made the non-generic
    /// `Interlocked.Exchange(ref object, object)` an exact IDENTITY match
    /// for `Interlocked.Exchange(&nodeField, nil)`, so it beat the
    /// `Exchange<T>(ref T, T) where T : class` the author meant and
    /// the call's type silently became `object`. csc never considers that
    /// overload at all.
    ///
    /// Like the inline `out var` sentinel, this one classifies as an
    /// identity conversion against any by-ref parameter and as inapplicable
    /// against everything else, so it stays neutral during betterness ranking.
    /// The <em>candidate</em> restriction — only a by-ref parameter that is
    /// GENERIC in the open definition can accept it, because no imported
    /// signature can name a type this compilation has not emitted yet — is
    /// applied before resolution by
    /// `MemberLookup.ExcludeNonGenericByRefCandidates`, since a candidate
    /// closed over the erasure no longer remembers which of its by-ref
    /// parameters were generic. The type argument is then recovered
    /// symbolically (`MemberLookup.BuildSymbolicMethodTypeArgs` →
    /// `TryRecoverErasedTypeArguments`), which is what makes the
    /// resulting call's type the user's own class rather than
    /// `object`.
    let SymbolicByRefArgumentType Type = typeof(SymbolicByRefArgumentMarker)

    /// Issue #2126: reports whether [`argType`](paramref) is a resolution
    /// sentinel — the inline `out var` placeholder
    /// ((cref:InlineOutVarArgumentType)) or the untyped `default`
    /// literal ((cref:DefaultLiteralArgumentType)). These are synthetic
    /// marker types defined in `GSharp.Core` that stand in for an argument
    /// whose real type is not yet known (an inline `out var`) or is supplied
    /// by the chosen parameter (a bare `default`). A sentinel must never be
    /// projected into a reference set's (cref:MetadataLoadContext) — it has
    /// no name there — and must never leak into emitted IL; it is normalised to
    /// its erased (cref:object) form before a generic candidate is closed
    /// (see the projection loop in `EvaluateCandidate`).
    /// @param argType The candidate argument/type-argument CLR type.
    /// @returns `true` when the type is a resolution sentinel.
    func IsResolutionSentinel(argType Type) bool -> object.ReferenceEquals(argType, InlineOutVarArgumentType) ||
        object.ReferenceEquals(argType, DefaultLiteralArgumentType) || object.ReferenceEquals(
        argType,
        SymbolicByRefArgumentType
    )

    // Issue #658 / #1311 / #1634: the supplementary-interface and constant-
    // narrowing checks used to live here as mutable (later [ThreadStatic])
    // fields, set immediately before and nulled immediately after each
    // `Resolve<T>` call. That "install/clear around the call" pattern is not
    // reentrant: nested resolution performed *inside* the hook window (e.g.
    // `RebindInlineOutVarArguments`, lambda re-binding, or any other bind that
    // itself resolves an overload before the outer `finally` runs) clears the
    // outer call's hook out from under it, and — because binding also runs
    // concurrently across language-server request threads via `Task.Run` —
    // a `[ThreadStatic]` field only protects against *cross-thread* races, not
    // this same-thread reentrancy hazard. Both checks are now threaded through
    // `Resolve<T>` as ordinary parameters instead, so each call carries its own
    // context and there is no shared mutable state to race or clobber.
    /// Classifies the implicit conversion from [`source`](paramref) to
    /// [`target`](paramref). Designed to work across reflection contexts
    /// (MetadataLoadContext vs. live runtime) by falling back to FullName
    /// equality.
    /// @param target The target parameter type.
    /// @param source The argument type.
    /// @param supplementaryInterfaceCheck Issue #658 / #1634: optional per-call callback recognising a
    /// user-
    /// defined G# class → CLR-interface implicit reference conversion that the
    /// built-in checks below cannot see (the class's CLR type is a surrogate at
    /// bind time). Passed down from the (cref:Resolve{T}) call that is
    /// evaluating this argument; `null` when the call has no
    /// user-class arguments.
    /// @returns The conversion classification.
    func ClassifyImplicit(
        target Type?,
        source Type?,
        supplementaryInterfaceCheck((Type, Type) -> bool)? = nil
    ) ImplicitConversionKind {
        var target = target
        var source = source
        if target == nil {
            return ImplicitConversionKind.None
        }
        // Issue #977: an inline `out var`/`out let`/`out _` argument has no known
        // type until an overload is chosen; it matches exactly the by-ref
        // parameters (out/ref/in) and nothing else.
        if object.ReferenceEquals(source, InlineOutVarArgumentType) {
            return if target.IsByRef {
                ImplicitConversionKind.Identity
            } else {
                ImplicitConversionKind.None
            }
        }
        // Issue #1391: the untyped `default` literal is implicitly convertible to
        // any (non-by-ref) parameter type — its value is the zero/null of whatever
        // type it lands on. Classify it as an identity conversion so an imported
        // generic method invoked with an explicit type argument (e.g.
        // `Task.FromResult[int32](default)`) stays applicable; the concrete-typed
        // default is materialized against the resolved parameter after selection.
        // Issue #4400: an `in` slot accepts it too, but only the candidate loops
        // can tell `in` from `ref`/`out` (ClassifyArgumentAtParameter).
        if object.ReferenceEquals(source, DefaultLiteralArgumentType) {
            return if target.IsByRef {
                ImplicitConversionKind.None
            } else {
                ImplicitConversionKind.Identity
            }
        }
        // Issue #3907: a by-ref argument over a same-compilation user reference
        // type matches a by-ref parameter whose element type is a generic
        // parameter, and nothing else — see SymbolicByRefArgumentType. In
        // particular it must NOT match `ref object`, which is what erasure
        // used to make it do.
        if object.ReferenceEquals(source, SymbolicByRefArgumentType) {
            return if target.IsByRef {
                ImplicitConversionKind.Identity
            } else {
                ImplicitConversionKind.None
            }
        }
        // Issue #533: a null source represents the `nil` literal in G#.
        // `nil` is implicitly assignable to any reference type and to
        // `Nullable<T>` (value-type nullable), mirroring C#'s null literal
        // compatibility rules.
        if source == nil {
            // Peel by-ref for the target (ref/out/in parameter).
            let t = if target.IsByRef {
                target.GetElementType()!!
            } else {
                target
            }
            // Nullable<T> (value-type nullable)
            if NullableLifting.IsValueTypeNullableClr(t) {
                return ImplicitConversionKind.NullableWrap
            }
            // Any reference type (class, interface, array, delegate, string)
            if !t.IsValueType {
                return ImplicitConversionKind.Reference
            }
            return ImplicitConversionKind.None
        }
        // ADR-0039: peel by-ref from target (ref/out/in parameter) for matching.
        // If the user passes &x (source is T&), peel both sides.
        // If the user passes x (source is T), peel only the target.
        let byRefStorage = target.IsByRef && source.IsByRef
        if target.IsByRef {
            target = target.GetElementType()!!
        }
        if source.IsByRef {
            source = source.GetElementType()!!
        }
        if ClrTypeUtilities.AreSame(target, source) {
            return ImplicitConversionKind.Identity
        }
        // Issue #4422: an address passes the storage itself, so a value-type
        // `Nullable<V>` on either side must match exactly: `int?` storage is
        // not an `int` location, nor the reverse, and wrapping it would emit
        // unverifiable IL.
        if byRefStorage &&
            (NullableLifting.IsValueTypeNullableClr(target) || NullableLifting.IsValueTypeNullableClr(source)) {
            return ImplicitConversionKind.None
        }
        if target!!.IsPointer && source!!.IsPointer && string.Equals(
            target!!.GetElementType()?.FullName,
            "System.Void",
            StringComparison.Ordinal
        ) {
            return ImplicitConversionKind.Reference
        }
        if IsNumericWidening(source!!, target!!) {
            return ImplicitConversionKind.NumericWidening
        }
        if string.Equals(target!!.FullName, "System.Object", StringComparison.Ordinal) {
            return if source!!.IsValueType {
                ImplicitConversionKind.Boxing
            } else {
                ImplicitConversionKind.Reference
            }
        }
        if IsNullableWrap(source!!, target!!) {
            return ImplicitConversionKind.NullableWrap
        }
        // Issue #322: any delegate type (Func<...>/Action<...> or a named
        // delegate) is implicitly convertible to System.Delegate /
        // System.MulticastDelegate, mirroring C#'s natural-delegate-type
        // conversion. This must work across reflection contexts: a lambda
        // literal in argument position carries a *live runtime* Func<> type,
        // while the target Delegate parameter (e.g. ASP.NET Core MapGet) is
        // loaded through a MetadataLoadContext, so the comparison is by name.
        if (
            string.Equals(target!!.FullName, "System.Delegate", StringComparison.Ordinal) || string.Equals(
                target!!.FullName,
                "System.MulticastDelegate",
                StringComparison.Ordinal
            )
        ) &&
            ClrTypeUtilities.IsDelegateType(source) {
            return ImplicitConversionKind.Reference
        }
        // Issue #908: delegate return-type covariance. A delegate value whose
        // return type is a derived / implementing reference type is applicable
        // to a delegate parameter with the same parameter signature but a
        // base / interface return type (e.g. Func<MemoryStream> → Func<Stream>,
        // () -> NullLoggerFactory → Func<ILoggerFactory>), mirroring C#/CLR
        // reference-preserving delegate covariance. Checked here — before the
        // assignability / base-type-walk blocks below — because a func/arrow
        // literal's natural delegate type is a host-runtime Func<> closed over
        // MetadataLoadContext type arguments, on which those reflection probes
        // throw. Ranked last so an exact (identity) delegate match always wins.
        if IsDelegateReturnCovariant(target!!, source!!) {
            return ImplicitConversionKind.DelegateReturnCovariance
        }
        // Issue #1150: delegate return-type numeric widening. A delegate value
        // whose parameter signature matches the target's but whose numeric
        // return type implicitly, losslessly widens to the target's return type
        // (e.g. Func<Item,uint32> → Func<Item,int64>) is applicable, mirroring
        // C#'s implicit numeric conversion of a lambda body to an expected
        // delegate return type. Checked here — alongside the reference
        // covariance case — before the assignability / base-type-walk blocks
        // below. Ranked last so an exact (identity) delegate match always wins.
        if IsDelegateReturnNumericWidening(target!!, source!!) {
            return ImplicitConversionKind.DelegateReturnNumericWidening
        }
        if object.ReferenceEquals(target!!.Assembly, source!!.Assembly) || target!!.GetType() == source!!.GetType() {
            try {
                if target!!.IsAssignableFrom(source) {
                    // Issue #2516: CLR array assignability is broader than G#.
                    // Distinct arrays remain invariant. Generic array
                    // interfaces accept a distinct element only through their
                    // own declared `out` variance and an implicit reference
                    // conversion; IList/ICollection therefore stay exact-only.
                    if source.IsArray && target!!.IsArray {
                        // Distinct array identity was ruled out above.

                    } else if source.IsArray &&
                        target!!.IsInterface &&
                        target!!.IsGenericType &&
                        !ClrTypeUtilities
                        .ImplementsInterfaceByName(source, target) {
                        if IsSafeArrayInterfaceVariance(target!!, source) {
                            return ImplicitConversionKind.Reference
                        }
                    } else {
                        return ImplicitConversionKind.Reference
                    }
                }
            } catch (InvalidOperationException) {
                // MLC cross-context paths throw; fall through to user-defined lookup.

            }
        }
        // Issue #570/#610: cross-context reference upcast fallback. When the
        // same-context fast path above cannot fire (live-runtime ↔ MLC boundary),
        // walk the source's interface set and base-type chain by name.
        if target!!.IsInterface &&
            (
            ClrTypeUtilities.ImplementsInterfaceByName(source, target) ||
                IsSafeArrayInterfaceVariance(target!!, source!!)
        ) {
            return ImplicitConversionKind.Reference
        }
        // Issue #3501: declaration-site generic-interface variance for a
        // non-array reference source. `ImplementsInterfaceByName` above
        // requires the closed generic arguments to match exactly, so a
        // variance-compatible instantiation (e.g. Roslyn's
        // `SymbolEqualityComparer : IEqualityComparer<ISymbol>` passed to a
        // `HashSet<IMethodSymbol>` constructor's contravariant
        // `IEqualityComparer<IMethodSymbol>` slot) fell through and failed
        // GS0267 even though C#/the CLR accept it. Mirrors
        // `IsSafeArrayInterfaceVariance` for the general interface case.
        if target!!.IsInterface && IsVariantGenericInterfaceConversion(target!!, source!!) {
            return ImplicitConversionKind.Reference
        }
        // Cross-context base-class walk (#610): covers inheritance across
        // reflection contexts (e.g. an MLC-loaded subclass passed to a
        // parameter typed as its live-runtime base class or vice versa).
        if !source!!.IsValueType && !target!!.IsValueType && !target!!.IsInterface {
            for var baseType Type? = source!!.BaseType; baseType != nil; baseType = baseType!!.BaseType {
                if ClrTypeUtilities.AreSame(baseType, target) {
                    return ImplicitConversionKind.Reference
                }
            }
        }
        // Issue #658: supplementary interface check for user-defined G# classes.
        // When the binder is resolving a call that includes a user-class argument
        // whose CLR type is a surrogate (e.g. System.Object), the built-in checks
        // above won't recognise that the user class implements the target interface.
        // This callback lets the binder inject that knowledge.
        if supplementaryInterfaceCheck != nil &&
            target!!.IsInterface &&
            supplementaryInterfaceCheck(source!!, target!!) {
            return ImplicitConversionKind.Reference
        }
        let udi Func[Type, Type, bool]? = UserDefinedImplicitConversionLookup
        if udi != nil && udi(source!!, target!!) {
            return ImplicitConversionKind.UserDefinedImplicit
        }
        // Issue #889: a value-returning func/arrow literal (whose natural CLR
        // type is a Func<...>) is applicable to a void-returning delegate
        // parameter (System.Action / Action<...> / a named void delegate) by
        // discarding the trailing value. Ranked lowest so a value-preserving
        // Func<...> overload always wins when both are applicable. The binder's
        // void-izing rebind (RebindFunctionLiteralDelegateArguments) materializes
        // the actual discard for the selected literal argument.
        if IsValueReturningDelegateToVoidDelegate(target!!, source!!) {
            return ImplicitConversionKind.LambdaToVoidDelegate
        }
        // Issue #932: a func/arrow literal whose natural delegate type is a
        // Func<...>/Action<...> is applicable to a structurally identical but
        // differently-named delegate parameter (same parameter types and same
        // return type), e.g. `func(i Item) bool { ... }` → System.Predicate<Item>
        // for `Assert.DoesNotContain(items, predicate)`. Ranked lowest so an
        // exact (identity) delegate match always wins when both apply. Checked
        // last because the covariance / void-discard cases above already cover
        // the differing-return-type shapes; this only handles the exact-shape
        // delegate-kind mismatch.
        if IsStructurallyCompatibleDelegate(target!!, source!!) {
            return ImplicitConversionKind.DelegateStructuralMatch
        }
        // Issue #2142: a lambda/arrow literal (natural CLR type Func<…>/Action<…>)
        // converts to an expression-tree parameter Expression<TDelegate> when its
        // TDelegate is structurally compatible with the source delegate. The
        // conversion is ranked identically to the underlying delegate conversion
        // (so a competing plain-delegate overload is decided purely on parameter
        // specificity, as in C#: e.g. Queryable.Where over Enumerable.Where for an
        // IQueryable receiver).
        if TryClassifyLambdaToExpressionTree(target, source, supplementaryInterfaceCheck, out var expressionTreeKind) {
            return expressionTreeKind
        }
        return ImplicitConversionKind.None
    }

    /// ADR-0055 Tier 4 (#369): determines whether [`parameterType`](paramref)
    /// is one of the contextual targets to which an interpolated string converts —
    /// `System.IFormattable` or `System.FormattableString`. Compared by
    /// (cref:Type.FullName) so it is robust across reflection contexts
    /// (MetadataLoadContext vs. live runtime). By-ref parameters are peeled first.
    /// @param parameterType The candidate parameter type.
    /// @returns `true` when the parameter is a Tier-4 target.
    func IsFormattableStringTarget(parameterType Type?) bool {
        var parameterType = parameterType
        if parameterType == nil {
            return false
        }
        if parameterType.IsByRef {
            let elementType Type? = parameterType.GetElementType()
            if elementType == nil {
                return false
            }
            parameterType = elementType
        }
        let fullName = parameterType?.FullName
        return string.Equals(fullName, "System.FormattableString", StringComparison.Ordinal) || string.Equals(
            fullName,
            "System.IFormattable",
            StringComparison.Ordinal
        )
    }

    /// Resolves a method-overload set against the supplied argument types and
    /// returns the unique best applicable candidate, or an ambiguity / no-
    /// match result.
    /// @typeparam T Candidate kind ((cref:MethodInfo) or (cref:ConstructorInfo)).
    /// @param candidates All candidate methods/ctors to consider.
    /// @param argTypes CLR types of the bound arguments in source order.
    /// @param explicitTypeArgs Issue #311: when non-`null`, the call site supplied an
    /// explicit type-argument list (e.g. `Array.Empty[string]()`). Only
    /// open generic method definitions whose arity matches are considered, and
    /// they are closed with these exact type arguments instead of inference.
    /// Non-generic and mismatched-arity candidates are dropped (matches C#'s
    /// rule that explicit type arguments require a matching generic method).
    /// @param projectTypeArgument Issue #321: projects an inferred type argument (a live host-runtime
    /// (cref:Type) taken from a bound argument) onto the reference load
    /// context that loaded the candidate methods, so
    /// (cref:MethodInfo.MakeGenericMethod) accepts it. Without this
    /// projection, closing a generic method such as
    /// `JsonSerializer.Serialize<TValue>` with an inferred
    /// `System.String` throws "was not loaded by the MetadataLoadContext".
    /// When `null` the inferred arguments are used as-is.
    /// Explicit type arguments are assumed to be pre-projected by the caller.
    /// @param interpolatedStringArgs ADR-0055 Tier 4 (#369): optional per-argument flags marking which
    /// arguments are interpolated-string expressions. A flagged argument may, in
    /// addition to its natural `string` type, convert to an
    /// `IFormattable`/`FormattableString` parameter. `null`
    /// (the default) disables the relaxation, preserving prior behaviour for all
    /// other call sites.
    /// @param argumentNames Issue #343: optional per-argument names supplied at the call site. Entries
    /// are `null` for positional arguments and the parameter name
    /// for named arguments (e.g. `F(1, x: 2)` → `[null, "x"]`). Named
    /// arguments must follow all positional arguments in source order; the binder
    /// pre-validates this layout. When non-`null`, each candidate's
    /// applicability check additionally requires that every named argument maps to
    /// a distinct parameter on that candidate, no positional slot is overwritten
    /// by a named slot, and every unfilled non-trailing slot is optional. The
    /// returned (cref:Result{T}.ParameterMapping) records, for each source
    /// argument index, the resolved parameter position so binding can preserve
    /// source evaluation order while presenting values in parameter order.
    /// @returns The resolution result.
    /// @param recoverTypeArgSymbols Issue #1325: optional callback that, given the closed candidate method,
    /// returns its recovered symbolic type-argument vector (open-arity order).
    /// Used so the generic value-type/struct constraint check can see through
    /// the `object` erasure of same-compilation user value types. When
    /// `null`, the constraint check relies solely on the CLR
    /// type arguments (prior behaviour).
    /// @param supplementaryInterfaceCheck Issue #658 / #1634: optional per-call user-class → CLR-interface
    /// applicability hook forwarded to (cref:ClassifyImplicit) while
    /// evaluating this call's candidates. Threaded as a parameter (rather than
    /// a shared mutable static) so concurrent and nested resolutions never
    /// observe another call's hook.
    /// @param constantNarrowingArgumentCheck Issue #1311 / #1634: optional per-call constant-narrowing
    /// applicability
    /// hook forwarded to (cref:EvaluateCandidate{T}) while evaluating
    /// this call's candidates. Threaded as a parameter for the same reentrancy/
    /// concurrency reason as [`supplementaryInterfaceCheck`](paramref).
    /// @param structuralProjectionArgumentCheck Optional binder callback that recognizes an argument's
    /// symbolic object
    /// shape as projectable to a candidate CLR parameter type.
    /// @param delegateRefKindArgumentCheck Optional binder callback comparing delegate argument and
    /// parameter
    /// ref/out/in metadata for applicability ranking.
    /// @param methodGroupInference Optional callback that resolves a deferred method group from the input
    /// types of the candidate's delegate parameter for generic inference.
    /// @param methodGroupArgumentCheck Optional callback identifying which source arguments are deferred
    /// method
    /// groups, distinguishing them from other naturally untyped arguments.
    /// @param deferredInferenceArgs Argument slots whose CLR delegate shape contains symbolic types and
    /// therefore must not contribute erased evidence to generic inference.
    /// Their original CLR types still participate in applicability and ranking.
    /// @param functionLiteralArgumentCheck Optional callback identifying function-literal arguments whose
    /// body
    /// return may be implicitly converted to the candidate delegate return.
    /// @param erasedArgumentMismatchCheck Issue #3989: optional binder callback reporting that an argument
    /// matched
    /// this parameter only through its own CLR ERASURE, with no conversion
    /// between the real types. Consulted only at a slot that could not have
    /// acquired its `object` by erasure — see
    /// (cref:IsErasedGenericParameterSlot) — so an inferred generic slot
    /// is never second-guessed.
    /// @param explicitTypeArgIsGenuine Issue #4026: one flag per position of
    /// [`explicitTypeArgs`](paramref),
    /// true where the call site's explicit type argument names a type with a CLR
    /// identity of its own rather than an erasure SURROGATE standing in for a
    /// same-compilation type or an in-scope type parameter. A slot whose open
    /// declaration mentions only genuinely-pinned method type parameters did not
    /// acquire its closed shape by erasure, so it is not exempt from the #3989 /
    /// #4006 erased-argument checks — see
    /// (cref:IsErasedGenericParameterSlot). Null (the default) keeps every
    /// generic slot "possibly erased", which is the pre-#4026 behaviour.
    /// @param explicitTypeArgumentMismatchCheck Issue #4026 (review): the precise form of the same
    /// question, for a call
    /// that supplied explicit type arguments. Given an argument index and the
    /// raw candidate, reports that the argument's REAL type has no conversion
    /// to the parameter the emitted MethodSpec will actually have — the open
    /// parameter with the call's own type-argument SYMBOLS substituted in. It
    /// catches what a per-slot flag cannot: a call that pins one type parameter
    /// genuinely beside one it does not, where the whole slot is exempted and
    /// the genuine position's mismatch goes unchecked. Declines (returns false)
    /// wherever it cannot see the whole picture — see
    /// `ExpressionBinder.MakeExplicitTypeArgumentMismatchCheck`.
    /// @param openLiteralArgumentCheck Tests a deferred open literal against the parameter inferred from
    /// other
    /// arguments, such as a tuple containing `nil`.
    /// @param symbolicArgTypes Issue #4086: optional source-level argument types, aligned with
    /// [`argTypes`](paramref). They distinguish an inferred method
    /// type-parameter slot from a genuine (cref:object) parameter after
    /// both have erased to (cref:object) for reflection.
    /// @param symbolicArgumentConversionClassifier Issue #4054: optional binder callback that preserves a
    /// same-compilation
    /// argument's symbolic identity long enough to classify a user-defined
    /// implicit conversion to the candidate parameter. Imported arguments keep
    /// using the CLR classifier unchanged.
    /// @param trailingParameterCountToIgnore Optional per-candidate count of trailing ABI-only parameters
    /// excluded
    /// from applicability and ranking.
    func Resolve[T MethodBase](
        candidates IEnumerable[T],
        argTypes IReadOnlyList[Type?],
        explicitTypeArgs IReadOnlyList[Type]? = nil,
        projectTypeArgument((Type) -> Type)? = nil,
        interpolatedStringArgs IReadOnlyList[bool]? = nil,
        argumentNames IReadOnlyList[string?]? = nil,
        recoverTypeArgSymbols((MethodInfo, bool) -> ImmutableArray[TypeSymbol?])? = nil,
        supplementaryInterfaceCheck((Type, Type) -> bool)? = nil,
        constantNarrowingArgumentCheck((int32, Type) -> bool)? = nil,
        structuralProjectionArgumentCheck((int32, Type) -> bool)? = nil,
        delegateRefKindArgumentCheck((int32, Type) -> bool?)? = nil,
        methodGroupInference((int32, IReadOnlyList[Type]) -> (Parameters[]Type, Return Type)?)? = nil,
        methodGroupArgumentCheck((int32) -> bool)? = nil,
        deferredInferenceArgs IReadOnlyList[bool]? = nil,
        functionLiteralArgumentCheck((int32) -> bool)? = nil,
        erasedArgumentMismatchCheck((int32, Type) -> bool)? = nil,
        explicitTypeArgIsGenuine IReadOnlyList[bool]? = nil,
        explicitTypeArgumentMismatchCheck((int32, MethodBase) -> bool)? = nil,
        openLiteralArgumentCheck((int32, Type) -> bool)? = nil,
        symbolicArgTypes IReadOnlyList[TypeSymbol]? = nil,
        symbolicArgumentConversionClassifier((int32, Type, ParameterInfo) -> ImplicitConversionKind?)? = nil,
        trailingParameterCountToIgnore((MethodBase) -> int32)? = nil
    ) Result[T] {
        let applicable = List[
            (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
        ]()
        // Materialize the candidate set so we can run both the normal-form pass
        // and (if necessary) a second params-expansion pass without re-querying
        // the underlying enumerable.
        let candidateList = candidates as IReadOnlyCollection[T] ?? candidates.ToList()
        for rawCandidate in candidateList {
            if object.ReferenceEquals(rawCandidate, nil) {
                continue
            }
            // Issue #321: an overload's signature may reference types that cannot
            // be loaded or projected under the MetadataLoadContext used for
            // reference assemblies (e.g. the ref-struct Utf8JsonWriter, or types
            // living in transitive assemblies that were not supplied via /r:).
            // Reflecting over such a parameter (GetParameters / ParameterType)
            // throws a load exception. A single unloadable overload must not sink
            // the entire candidate set, otherwise an otherwise-resolvable method
            // such as JsonSerializer.Serialize(string) appears "not found". Treat
            // these candidates as simply not applicable and keep evaluating the
            // rest.
            try {
                EvaluateCandidate(
                    rawCandidate,
                    argTypes,
                    explicitTypeArgs,
                    projectTypeArgument,
                    applicable,
                    interpolatedStringArgs,
                    argumentNames,
                    recoverTypeArgSymbols,
                    supplementaryInterfaceCheck,
                    constantNarrowingArgumentCheck,
                    structuralProjectionArgumentCheck,
                    delegateRefKindArgumentCheck,
                    methodGroupInference,
                    methodGroupArgumentCheck,
                    deferredInferenceArgs,
                    functionLiteralArgumentCheck,
                    erasedArgumentMismatchCheck,
                    explicitTypeArgIsGenuine,
                    explicitTypeArgumentMismatchCheck,
                    openLiteralArgumentCheck,
                    symbolicArgTypes,
                    symbolicArgumentConversionClassifier,
                    trailingParameterCountToIgnore
                )
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                continue
            }
        }
        // Issue #506: when no candidate applies in its normal (non-expanded)
        // form, attempt C#-style `params T[]` expansion. The expanded form is
        // only ever considered as a fallback so that a normal-form candidate
        // always beats an expanded-form one (C# §7.5.3.2 better-function-member
        // rule).
        if applicable.Count == 0 {
            for rawCandidate in candidateList {
                if object.ReferenceEquals(rawCandidate, nil) {
                    continue
                }
                try {
                    EvaluateExpandedParamsCandidate(
                        rawCandidate,
                        argTypes,
                        explicitTypeArgs,
                        projectTypeArgument,
                        applicable,
                        interpolatedStringArgs,
                        argumentNames,
                        recoverTypeArgSymbols,
                        supplementaryInterfaceCheck,
                        constantNarrowingArgumentCheck,
                        structuralProjectionArgumentCheck,
                        delegateRefKindArgumentCheck,
                        methodGroupInference,
                        methodGroupArgumentCheck,
                        erasedArgumentMismatchCheck,
                        explicitTypeArgIsGenuine,
                        explicitTypeArgumentMismatchCheck,
                        deferredInferenceArgs,
                        openLiteralArgumentCheck,
                        symbolicArgTypes,
                        symbolicArgumentConversionClassifier,
                        trailingParameterCountToIgnore
                    )
                } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                    continue
                }
            }
        }
        if applicable.Count == 0 {
            return Result[T].NoneApplicable()
        }
        if applicable.Count == 1 {
            let only = applicable[0]
            return Result[T].Single(only.Method, BuildMappingArray(only.Mapping, argumentNames), only.IsExpanded)
        }
        return RankApplicable(applicable, argTypes, argumentNames, trailingParameterCountToIgnore)
    }

    /// Issue #2347: returns `true` when [`argument`](paramref)
    /// is a method-group reference (either a same-compilation user-function
    /// group or an imported/CLR one) that has not yet been resolved to a single
    /// concrete method — i.e. its shape depends entirely on the eventual target
    /// delegate signature, which is not known until overload resolution (and any
    /// generic type-argument inference) has picked a candidate. Such an argument
    /// carries (cref:TypeSymbol.Error) as its natural type. Recognising
    /// this shape lets every CLR call-binding path (constructors, static/instance
    /// methods, extension methods, constrained interface/object-member calls)
    /// defer it the same way an untyped arrow lambda is deferred — contributing
    /// no CLR type to the argument-type vector fed to (cref:Resolve{T})
    /// (so generic inference and applicability fall back to the other
    /// arguments) — and then resolving it against the winning candidate's actual
    /// parameter type afterwards via `ConversionClassifier.BindConversion`.
    /// This is what makes a bare method group (e.g. `Char.IsAsciiHexDigit`)
    /// behave like the equivalent lambda when passed to an imported generic
    /// extension method (e.g. `Enumerable.All<TSource>`), instead of
    /// only working for same-compilation generic functions.
    /// @param argument The bound argument expression to inspect.
    /// @returns `true` when the argument is an unresolved method group.
    func IsUnresolvedMethodGroupArgument(argument BoundExpression) bool -> argument is BoundMethodGroupExpression &&
        argument.FunctionType == nil ||
        argument is BoundClrMethodGroupExpression &&
        argument.ResolvedMethod == nil

    /// Issue #3501 A5: whether [`argument`](paramref) is ANY method-group
    /// argument — resolved single-candidate groups included. Method groups
    /// contribute only output-type inference, so even a group with a natural
    /// function type must route through the method-group inference callback
    /// instead of hard-unifying its natural type against the delegate slots.
    /// @param argument The bound argument to inspect.
    /// @returns Whether the argument is a method group.
    func IsMethodGroupArgument(argument BoundExpression) bool -> argument is BoundMethodGroupExpression ||
        argument is BoundClrMethodGroupExpression

    /// Issue #506: returns `true` when [`parameter`](paramref)
    /// is the trailing `params T[]` parameter — i.e. carries the
    /// (cref:ParamArrayAttribute) marker and is a single-dimensional
    /// array. Detected via (cref:CustomAttributeData) so the check works
    /// even when the candidate is reflected through a MetadataLoadContext.
    /// @param parameter The parameter to inspect.
    /// @returns Whether the parameter is a `params` array.
    func IsParamsArrayParameter(parameter ParameterInfo?) bool {
        if parameter == nil {
            return false
        }
        let paramType Type? = parameter.ParameterType
        if paramType == nil || !paramType.IsArray || paramType.GetArrayRank() != 1 {
            return false
        }
        var attrs IList[CustomAttributeData]?
        try {
            attrs = parameter.GetCustomAttributesData()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
        if attrs == nil {
            return false
        }
        for var i = 0; i < attrs.Count; i++ {
            let name = attrs[i]?.AttributeType?.FullName
            if string.Equals(name, "System.ParamArrayAttribute", StringComparison.Ordinal) {
                return true
            }
        }
        return false
    }

    /// Issue #506: returns the position of the trailing `params T[]`
    /// parameter on [`method`](paramref), or -1 when there is none.
    /// @param method The method to inspect.
    /// @returns The params parameter position, or -1.
    func GetParamsParameterIndex(method MethodBase?) int32 {
        if method == nil {
            return -1
        }
        var parameters[]ParameterInfo
        try {
            parameters = method.GetParameters()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return -1
        }
        if parameters.Length == 0 {
            return -1
        }
        let lastIndex = parameters.Length - 1
        return if IsParamsArrayParameter(parameters[lastIndex]) {
            lastIndex
        } else {
            -1
        }
    }

    /// Issue #320: determines whether a closed generic method's open definition
    /// returns exactly one of its own method type parameters (e.g.
    /// `T GetService<T>()`, `T GetRequiredService<T>()`,
    /// `T CreateInstance<T>()`). When it does, the caller can recover the
    /// real return type from the explicit type-argument symbol at the reported
    /// position, which is necessary when the method was closed with a placeholder
    /// CLR type because the type argument is a user-defined type with no
    /// reference-context CLR type.
    /// @param closed The closed generic method.
    /// @param position The method type-parameter position of the return type, when matched.
    /// @returns `true` when the return type is a bare method type parameter.
    func TryGetGenericMethodParameterReturnPosition(closed MethodInfo?, out position int32) bool {
        position = -1
        if closed == nil || !closed.IsGenericMethod {
            return false
        }
        let open_ = if closed.IsGenericMethodDefinition {
            closed
        } else {
            closed.GetGenericMethodDefinition()
        }
        let ret Type? = open_.ReturnType
        if ret != nil && ret.IsGenericParameter && ret.DeclaringMethod != nil {
            position = ret.GenericParameterPosition
            return true
        }
        return false
    }

    /// Issue #1599: determines whether the parameter at [`parameterIndex`](paramref)
    /// of a closed generic method's open definition is typed by exactly one of the
    /// method's own type parameters — including through a by-ref (`out`/`ref`)
    /// wrapper, e.g. the `out TEnum` parameter of
    /// `bool TryParse<TEnum>(string, out TEnum)`. When it does, the caller can
    /// recover the real parameter (pointee) type from the explicit type-argument symbol
    /// at the reported position, which is necessary when the method was closed over a
    /// value-type placeholder (or an (cref:object) erasure) because the type
    /// argument is a same-compilation user value type with no reference-context CLR type.
    /// This is the parameter analogue of
    /// (cref:TryGetGenericMethodParameterReturnPosition(MethodInfo, out int)) and
    /// is what lets an inline `out var` declaration recover the correct pointee type
    /// instead of leaking the placeholder.
    /// @param closed The closed generic method.
    /// @param parameterIndex The zero-based parameter position to inspect.
    /// @param position The method type-parameter position of the parameter, when matched.
    /// @returns `true` when the parameter (pointee) is a bare method type parameter.
    func TryGetGenericMethodParameterPosition(closed MethodInfo?, parameterIndex int32, out position int32) bool {
        position = -1
        if closed == nil || !closed.IsGenericMethod || parameterIndex < 0 {
            return false
        }
        let open_ = if closed.IsGenericMethodDefinition {
            closed
        } else {
            closed.GetGenericMethodDefinition()
        }
        let parameters = open_.GetParameters()
        if parameterIndex >= parameters.Length {
            return false
        }
        let paramType Type? = parameters[parameterIndex].ParameterType
        let pointee Type? = if paramType != nil && paramType.IsByRef {
            paramType.GetElementType()
        } else {
            paramType
        }
        if pointee != nil && pointee.IsGenericParameter && pointee.DeclaringMethod != nil {
            position = pointee.GenericParameterPosition
            return true
        }
        return false
    }

    /// Issue #2146: implements the C# §7.5.3.4 "better conversion target" rule
    /// for reference-type targets, mirroring (cref:CompareNumericTargets).
    /// Returns a negative value when [`t1`](paramref) is the better
    /// (more-derived) target, positive when [`t2`](paramref) is, and 0 when
    /// the two targets are unrelated (neither implicitly converts to the other),
    /// preserving genuine ambiguity. Convertibility is probed one-directionally
    /// via (cref:ClassifyImplicit) so user classes, interfaces, and
    /// imported/BCL reference types are handled uniformly.
    /// @param t1 The first candidate target type.
    /// @param t2 The second candidate target type.
    /// @returns -1, 0, or +1 per the description above.
    func CompareReferenceTargets(t1 Type?, t2 Type?) int32 {
        if t1 == nil || t2 == nil || ClrTypeUtilities.AreSame(t1, t2) {
            return 0
        }
        // T1 is a better target than T2 when an implicit conversion T1->T2
        // exists (T1 is more derived) and none exists T2->T1.
        let t1ToT2 = (
            ClassifyImplicit(t2, t1) is not ImplicitConversionKind.None and not ImplicitConversionKind.Identity
        )
        let t2ToT1 = (
            ClassifyImplicit(t1, t2) is not ImplicitConversionKind.None and not ImplicitConversionKind.Identity
        )
        if t1ToT2 && !t2ToT1 {
            return -1
        }
        if t2ToT1 && !t1ToT2 {
            return 1
        }
        return 0
    }

    /// Compares nullable numeric targets before conversion mechanism costs.
    /// @param paramA The first applicable target.
    /// @param paramB The second applicable target.
    /// @param source The numeric source type.
    /// @returns A negative value prefers the first target; zero leaves other ranking rules unchanged.
    func CompareNullableNumericTargets(paramA Type?, paramB Type?, source Type?) int32 {
        if !NumericWideningLattice.IsNumericPrimitive(source?.FullName) {
            return 0
        }
        let targetA = if paramA is {IsByRef: true} byRefA {
            byRefA.GetElementType()
        } else {
            paramA
        }
        let targetB = if paramB is {IsByRef: true} byRefB {
            byRefB.GetElementType()
        } else {
            paramB
        }
        let underlyingA = NullableLifting.GetValueTypeNullableUnderlyingClr(targetA)
        let underlyingB = NullableLifting.GetValueTypeNullableUnderlyingClr(targetB)
        let numericA = NumericWideningLattice.IsNumericPrimitive(underlyingA?.FullName)
        let numericB = NumericWideningLattice.IsNumericPrimitive(underlyingB?.FullName)
        if numericA && numericB {
            return CompareNumericTargets(underlyingA, underlyingB, source)
        }
        // A nullable value boxes as its underlying value or null, including conversions to implemented interfaces.
        if numericA && targetB?.IsValueType == false {
            return CompareReferenceTargets(underlyingA, targetB)
        }
        if numericB && targetA?.IsValueType == false {
            return CompareReferenceTargets(targetA, underlyingB)
        }
        return 0
    }

    /// Compares two candidate conversion targets for the same source type per
    /// C# §7.5.3.4 "Better conversion target". Returns a negative value when
    /// [`t1`](paramref) is the better target, a positive value when
    /// [`t2`](paramref) is better, or zero when neither dominates.
    /// @param t1 The first candidate target type.
    /// @param t2 The second candidate target type.
    /// @param source The source argument type.
    /// @returns -1, 0, or +1 per the description above.
    func CompareNumericTargets(t1 Type?, t2 Type?, source Type?) int32 {
        if t1 == nil || t2 == nil || source == nil {
            return 0
        }
        if ClrTypeUtilities.AreSame(t1, t2) {
            return 0
        }
        // Identity always wins over widening — caller handles that via the
        // conversion-kind comparison; here we only break ties between two
        // widenings, so identity to either target is not in scope.
        let t1ToT2 = ClassifyImplicit(t2, t1) != ImplicitConversionKind.None
        let t2ToT1 = ClassifyImplicit(t1, t2) != ImplicitConversionKind.None
        // T1 is a better target than T2 if an implicit conversion T1→T2 exists
        // and none exists T2→T1 (T1 is the "smaller"/closer numeric type).
        if t1ToT2 && !t2ToT1 {
            return -1
        }
        if t2ToT1 && !t1ToT2 {
            return 1
        }
        // Signed integral T1 beats unsigned integral T2 (and vice versa) per
        // the signed-vs-unsigned subclause when neither dominates by the
        // conversion-direction rule above (e.g. int vs. uint).
        if t1.FullName is {} t1Name && t2.FullName is {} t2Name {
            if SignedBeatsUnsigned.TryGetValue(t1Name, out var t1Beats) && t1Beats.Contains(t2Name) {
                return -1
            }
            if SignedBeatsUnsigned.TryGetValue(t2Name, out var t2Beats) && t2Beats.Contains(t1Name) {
                return 1
            }
        }
        return 0
    }

    /// Formats a CLR method/constructor signature into a short human-readable
    /// form suitable for a diagnostic: `Name[T1, T2](P1, P2, …)`. Used by
    /// the ambiguous-overload diagnostic (issue #505) to list the competing
    /// candidates so the caller can choose how to disambiguate (typically by
    /// supplying an explicit type-argument list).
    /// @param method The CLR method or constructor.
    /// @returns The formatted signature.
    func FormatMethodSignature(method MethodBase?) string {
        if method == nil {
            return "<null>"
        }
        let sb = StringBuilder()
        sb.Append(method.Name)
        if method is MethodInfo mi && mi.IsGenericMethod {
            sb.Append('[')
            let typeArgs = mi.GetGenericArguments()
            for var i = 0; i < typeArgs.Length; i++ {
                if i > 0 {
                    sb.Append(", ")
                }
                sb.Append(FormatTypeName(typeArgs[i]))
            }
            sb.Append(']')
        }
        sb.Append('(')
        let parameters = method.GetParameters()
        for var i = 0; i < parameters.Length; i++ {
            if i > 0 {
                sb.Append(", ")
            }
            sb.Append(FormatTypeName(parameters[i].ParameterType))
        }
        sb.Append(')')
        return sb.ToString()
    }

    /// Attempts to infer the type arguments of an open generic method
    /// definition from the supplied argument types. Implements a deliberately
    /// scoped subset of C# §7.5.2 "Type inference": only the input-type
    /// inference phase against argument CLR types, plus exact unification on
    /// recursive generic / array shapes. Deferred lambdas are not considered;
    /// a deferred method group can contribute output inference through
    /// [`methodGroupInference`](paramref) after its delegate input types
    /// are inferred from the other arguments. Returns `true` with
    /// [`typeArgs`](paramref) populated when every method type parameter
    /// receives a single consistent bound; `false` otherwise.
    /// @param openMethod An open generic method definition (i.e.
    /// (cref:MethodBase.IsGenericMethodDefinition) is `true`).
    /// @param argTypes CLR types of the supplied arguments.
    /// @param typeArgs On success, the inferred type arguments in declaration order.
    /// @param methodGroupInference Optional deferred method-group signature resolver.
    /// @param trailingParameterCountToIgnore Trailing ABI-only parameters excluded from inference.
    /// @returns Whether inference succeeded.
    func TryInferTypeArguments(
        openMethod MethodInfo?,
        argTypes IReadOnlyList[Type?],
        @NotNullWhen(true) out typeArgs[]?Type,
        methodGroupInference((int32, IReadOnlyList[Type]) -> (Parameters[]Type, Return Type)?)? = nil,
        trailingParameterCountToIgnore int32 = 0
    ) bool {
        typeArgs = nil
        if openMethod == nil || !openMethod.IsGenericMethodDefinition {
            return false
        }
        var parameters = openMethod.GetParameters()
        if trailingParameterCountToIgnore > 0 {
            parameters = parameters[.. ^trailingParameterCountToIgnore]
        }
        // Issue #327/#321: allow the call to omit trailing optional parameters.
        // We infer type arguments from the supplied positional arguments only;
        // any omitted optional parameter must therefore not introduce a method
        // type parameter that is otherwise un-inferable (the loop below still
        // requires every type parameter to receive a bound).
        if parameters.Length < argTypes.Count {
            return false
        }
        for var i = argTypes.Count; i < parameters.Length; i++ {
            if !IsOptionalParameter(parameters[i]) {
                return false
            }
        }
        let typeParams = openMethod.GetGenericArguments()
        let bounds = Dictionary[string, Type](StringComparer.Ordinal)
        for var i = 0; i < argTypes.Count; i++ {
            let arg Type? = argTypes[i]
            if arg == nil {
                continue
            }
            // Unify the parameter against the argument; soft-fail (skip this
            // arg) when shapes don't line up, hard-fail only on a true
            // bound-conflict for a method type parameter.
            if !UnifyForInference(parameters[i].ParameterType, arg, bounds) {
                return false
            }
        }
        if methodGroupInference != nil {
            for var i = 0; i < argTypes.Count; i++ {
                if argTypes[i] == nil {
                    if !TryInferSingleCandidateMethodGroupArgument(
                        parameters[i].ParameterType,
                        i,
                        bounds,
                        methodGroupInference
                    ) {
                        TryInferMethodGroupArgument(parameters[i].ParameterType, i, bounds, methodGroupInference)
                    }
                }
            }
        }
        let result = [typeParams.Length]Type
        for var i = 0; i < typeParams.Length; i++ {
            if !bounds.TryGetValue(typeParams[i].Name, out var bound) {
                return false
            }
            result[i] = bound
        }
        typeArgs = result
        return true
    }

    /// Tests only an extension receiver, without binding its arguments.
    /// Shares final resolution's inference, constraints and CLR conversions;
    /// unknown symbolic receivers or argument-dependent bounds stay possible.
    internal func MayAcceptExtensionReceiver(
        method MethodInfo,
        receiver TypeSymbol,
        argumentCount int32?,
        argumentNames IReadOnlyList[string?]?
    ) bool {
        let receiverClr = receiver.ClrType
        if receiverClr == nil || receiverClr.ContainsGenericParameters || TypeSymbol.ContainsSameCompilationUserType(
            receiver
        ) {
            return true
        }
        let parameters = method.GetParameters()
        if parameters.Length == 0 {
            return false
        }
        let receiverRefKind = RefCapabilities.GetParameterRefKind(parameters[0])
        let requiresIdentity = receiverRefKind is RefKind.Ref or RefKind.Out
        var parameterType = parameters[0].ParameterType
        if parameterType.IsByRef {
            parameterType = parameterType.GetElementType() ?? parameterType
        }
        if !parameterType.ContainsGenericParameters {
            if requiresIdentity {
                return ClrTypeUtilities.AreSame(parameterType, receiverClr)
            }
            return ClassifyImplicit(parameterType, receiverClr) != ImplicitConversionKind.None ||
                Conversion
                .ClassifyNonStructural(receiver, ClrNullability.GetParameterTypeSymbol(parameters[0])).IsImplicit
        }
        let bounds = Dictionary[string, Type](StringComparer.Ordinal)
        var receiverMatches bool
        if requiresIdentity {
            let exact = Dictionary[Type, Type]()
            receiverMatches = InferExactExtensionReceiverTypeArguments(parameterType, receiverClr, exact)
            for entry in exact {
                bounds[entry.Key.Name] = entry.Value
            }
        } else {
            receiverMatches = UnifyForInference(parameterType, receiverClr, bounds)
        }
        if !receiverMatches {
            return false
        }
        let typeParameters = method.GetGenericArguments()
        var remainingParameters = parameters.Skip(1).Take(argumentCount ?? int32.MaxValue).ToArray()
        if argumentNames != nil {
            if !TryBuildNamedArgumentReordering(method, argumentNames.Count, argumentNames, out var mapping) &&
                !TryBuildNamedArgumentReordering(
                method,
                argumentNames.Count,
                argumentNames,
                isExpanded: true,
                out mapping
            ) {
                remainingParameters = Array.Empty[ParameterInfo]()
            } else if mapping != nil {
                remainingParameters = mapping.Skip(1).Select((index int32) -> parameters[index]).ToArray()
            }
        }
        let argumentDependent = typeParameters
            .Where(
            (typeParameter Type) -> remainingParameters.Any(
                (parameter ParameterInfo) -> MentionsGenericParameter(parameter.ParameterType, typeParameter)
            )
        )
            .Select((typeParameter Type) -> typeParameter.Name)
            .ToHashSet(StringComparer.Ordinal)
        if typeParameters.Any(
            (typeParameter Type) -> !bounds.ContainsKey(typeParameter.Name) && !argumentDependent.Contains(
                typeParameter.Name
            )
        ) {
            return false
        }
        if requiresIdentity {
            let independent = typeParameters
                .Where(
                (parameter Type) -> argumentDependent.Contains(parameter.Name) &&
                    !MentionsGenericParameter(parameterType, parameter)
            )
                .Select((parameter Type) -> parameter.Name)
                .ToHashSet(StringComparer.Ordinal)
            return ExtensionReceiverBoundsMayApply(method, receiver, parameterType, bounds, independent)
        }
        let operators = List[MethodInfo]()
        ClrOperatorResolution.CollectOperators(receiverClr, "op_Implicit", operators)
        ClrOperatorResolution.CollectOperators(
            NullableLifting.GetValueTypeNullableUnderlyingClr(parameterType) ?? parameterType,
            "op_Implicit",
            operators
        )
        if !OpenExtensionReceiverStandardShapeMayApply(receiverClr, parameterType) && !operators.Any(
            (conversion MethodInfo) -> {
                let inputs = conversion.GetParameters()
                return inputs.Length == 1 &&
                    (
                    if inputs[0].ParameterType.ContainsGenericParameters {
                        OpenExtensionReceiverStandardShapeMayApply(receiverClr, inputs[0].ParameterType)
                    } else {
                        IsInferenceBoundPromotion(inputs[0].ParameterType, receiverClr) ||
                            Conversion
                            .ClassifyNonStructural(receiver, ClrNullability.GetParameterTypeSymbol(inputs[0]))
                            .IsImplicit
                    }
                ) &&
                    OpenExtensionReceiverStandardShapeMayApply(conversion.ReturnType, parameterType)
            }
        ) {
            return false
        }
        for conversion in operators {
            let conversionParameters = conversion.GetParameters()
            let convertedBounds = Dictionary[string, Type](bounds, StringComparer.Ordinal)
            if conversionParameters.Length == 1 &&
                UnifyForInference(conversionParameters[0].ParameterType, receiverClr, convertedBounds) &&
                IndependentExtensionReceiverOutputMayApply(
                method,
                receiver,
                convertedBounds,
                argumentDependent,
                conversionParameters[0].ParameterType
            ) {
                return true
            }
        }
        if OpenExtensionReceiverStandardShapeMayApply(receiverClr, parameterType) {
            for carrier in GetReceiverInferenceCarriers(receiverClr) {
                if ExtensionReceiverCarrierMayApply(
                    method,
                    receiver,
                    parameterType,
                    carrier,
                    bounds,
                    argumentDependent
                ) {
                    return true
                }
            }
        }
        for conversion in operators {
            let conversionParameters = conversion.GetParameters()
            let convertedBounds = Dictionary[string, Type](bounds, StringComparer.Ordinal)
            if conversionParameters.Length != 1 ||
                !UnifyForInference(conversionParameters[0].ParameterType, receiverClr, convertedBounds) {
                continue
            }
            if ExtensionReceiverBoundsMayApply(
                method,
                receiver,
                parameterType,
                convertedBounds,
                argumentDependent,
                receiverTerms: List[(Type, Type)](){(receiverClr, conversionParameters[0].ParameterType)}
            ) {
                return true
            }
            for carrier in GetReceiverInferenceCarriers(conversion.ReturnType) {
                if ExtensionReceiverCarrierMayApply(
                    method,
                    receiver,
                    parameterType,
                    carrier,
                    convertedBounds,
                    argumentDependent,
                    conversionInputType: conversionParameters[0].ParameterType
                ) {
                    return true
                }
            }
        }
        return false
    }

    private func OpenExtensionReceiverStandardShapeMayApply(
        source Type,
        target Type,
        tupleElementConversions bool = true
    ) bool {
        if source.IsGenericParameter || target.IsGenericParameter {
            return true
        }
        let underlying = NullableLifting.GetValueTypeNullableUnderlyingClr(target)
        if underlying != nil {
            return OpenExtensionReceiverStandardShapeMayApply(
                NullableLifting.GetValueTypeNullableUnderlyingClr(source) ?? source,
                underlying,
                tupleElementConversions
            )
        }
        if target.IsArray {
            let sourceElement = source.GetElementType()
            let targetElement = target.GetElementType()
            if !source.IsArray || source.GetArrayRank() != target.GetArrayRank() ||
                source.IsSZArray != target.IsSZArray ||
                sourceElement == nil ||
                targetElement == nil {
                return false
            }
            if tupleElementConversions || sourceElement.IsValueType || targetElement.IsValueType {
                let exact = Dictionary[Type, Type]()
                return if sourceElement.ContainsGenericParameters && !targetElement.ContainsGenericParameters {
                    InferExactExtensionReceiverTypeArguments(sourceElement, targetElement, exact)
                } else {
                    InferExactExtensionReceiverTypeArguments(targetElement, sourceElement, exact)
                }
            }
            return OpenExtensionReceiverStandardShapeMayApply(
                sourceElement,
                targetElement,
                tupleElementConversions: false
            )
        }
        if !target.IsGenericType {
            let kind = ClassifyImplicit(target, source)
            return kind is not(
                ImplicitConversionKind.None or
                    ImplicitConversionKind.UserDefinedImplicit or
                    ImplicitConversionKind.DelegateRefKindMismatch
            )
        }
        let definition = target.GetGenericTypeDefinition()
        let matched = FindClosedGeneric(source, definition)
        if matched == nil {
            for alternative in GetExtensionReceiverGenericShapes(source, definition) {
                if OpenExtensionReceiverStandardShapeMayApply(alternative, target, tupleElementConversions) {
                    return true
                }
            }
            return IsStructurallyInferrableDelegate(target, source) ||
                TryGetChannelViewElement(definition, source, out _)
        }
        let sources = matched.GetGenericArguments()
        let targets = target.GetGenericArguments()
        if sources.Length != targets.Length {
            return false
        }
        let slots = definition.GetGenericArguments()
        let tupleElements = tupleElementConversions && definition.FullName?.StartsWith(
            "System.ValueTuple`",
            StringComparison.Ordinal
        ) == true
        let exact = Dictionary[Type, Type]()
        for var i = 0; i < sources.Length; i++ {
            let variance = if tupleElements {
                GenericParameterAttributes.Covariant
            } else if sources[i].IsValueType || targets[i].IsValueType {
                GenericParameterAttributes.None
            } else {
                slots[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
            }
            let compatible = switch variance {
                case GenericParameterAttributes.Covariant: OpenExtensionReceiverStandardShapeMayApply(
                    sources[i],
                    targets[i],
                    tupleElementConversions: tupleElements
                )
                case GenericParameterAttributes.Contravariant: OpenExtensionReceiverStandardShapeMayApply(
                    targets[i],
                    sources[i],
                    tupleElementConversions: false
                )
                default: if sources[i].ContainsGenericParameters && !targets[i].ContainsGenericParameters {
                    InferExactExtensionReceiverTypeArguments(sources[i], targets[i], exact)
                } else {
                    InferExactExtensionReceiverTypeArguments(targets[i], sources[i], exact)
                }
            }
            if !compatible {
                return tupleElementConversions && IsStructurallyInferrableDelegate(target, source)
            }
        }
        return true
    }

    private func GetExtensionReceiverGenericShapes(source Type, definition Type) List[Type] {
        let shapes = List[Type]()
        for carrier in GetReceiverInferenceCarriers(source) {
            if carrier.IsGenericType && ClrTypeUtilities.AreSame(carrier.GetGenericTypeDefinition(), definition) &&
                !shapes.Any((shape Type) -> ClrTypeUtilities.AreSame(shape, carrier)) {
                shapes.Add(carrier)
            }
        }
        return shapes
    }

    private func IndependentExtensionReceiverOutputMayApply(
        method MethodInfo,
        receiver TypeSymbol,
        bounds IReadOnlyDictionary[string, Type],
        argumentDependent HashSet[string],
        conversionInputType Type? = nil
    ) bool {
        let receiverClr = receiver.ClrType
        if receiverClr == nil {
            return true
        }
        let parameters = method.GetGenericArguments()
        var contextObject = parameters[0]
        while contextObject.BaseType is {} baseType {
            contextObject = baseType
        }
        let arguments = parameters.Select(
            (parameter Type) -> if bounds.TryGetValue(parameter.Name, out var bound) &&
                !bound.ContainsGenericParameters {
                ClrTypeUtilities.RemapHostCoreTypeToContext(bound, contextObject) ?? bound
            } else {
                parameter
            }
        )
            .ToArray()
        let freeBounds = Dictionary[string, Type](StringComparer.Ordinal)
        for var i = 0; i < parameters.Length; i++ {
            if arguments[i].ContainsGenericParameters {
                freeBounds[parameters[i].Name] = parameters[i]
            }
        }
        var partiallyClosedMethod MethodInfo
        try {
            partiallyClosedMethod = method.MakeGenericMethod(arguments)
        } catch (ex ArgumentException) {
            return false
        }
        let receiverType = partiallyClosedMethod.GetParameters()[0].ParameterType
        let underlyingReceiver = NullableLifting.GetValueTypeNullableUnderlyingClr(receiverType)
        let operators = List[MethodInfo]()
        ClrOperatorResolution.CollectOperators(underlyingReceiver ?? receiverType, "op_Implicit", operators)
        for conversion in operators {
            let inputs = conversion.GetParameters()
            if inputs.Length == 1 &&
                (conversion.ReturnType == receiverType || conversion.ReturnType == underlyingReceiver) &&
                (
                if inputs[0].ParameterType.ContainsGenericParameters {
                    OpenExtensionReceiverStandardShapeMayApply(receiverClr, inputs[0].ParameterType)
                } else {
                    IsInferenceBoundPromotion(inputs[0].ParameterType, receiverClr) || Conversion.ClassifyNonStructural(
                        receiver,
                        ClrNullability.GetParameterTypeSymbol(inputs[0])
                    )
                        .IsImplicit
                }
            ) {
                if ArgumentDependentBoundsMaySatisfyConstraints(
                    parameters,
                    arguments,
                    List[(Type, Type, bool)](){(receiverClr, conversionInputType ?? inputs[0].ParameterType, true)},
                    argumentDependent,
                    freeBounds
                ) {
                    return true
                }
            }
        }
        return false
    }

    private func ExtensionReceiverCarrierMayApply(
        method MethodInfo,
        receiver TypeSymbol,
        parameterType Type,
        carrier Type,
        bounds Dictionary[string, Type],
        argumentDependent HashSet[string],
        conversionInputType Type? = nil
    ) bool {
        if !OpenExtensionReceiverStandardShapeMayApply(carrier, parameterType) {
            return false
        }
        if parameterType.IsGenericType {
            let shapes = GetExtensionReceiverGenericShapes(carrier, parameterType.GetGenericTypeDefinition())
            if shapes.Count > 1 {
                return shapes.Any(
                    (shape Type) -> ExtensionReceiverCarrierMayApply(
                        method,
                        receiver,
                        parameterType,
                        shape,
                        bounds,
                        argumentDependent,
                        conversionInputType
                    )
                )
            }
        }
        let candidateBounds = Dictionary[string, Type](bounds, StringComparer.Ordinal)
        let receiverTerms = List[(Type, Type)](){(carrier, parameterType)}
        if conversionInputType != nil && receiver.ClrType is {} source {
            receiverTerms.Add((source, conversionInputType))
        }
        if UnifyForInference(parameterType, carrier, candidateBounds) {
            let freeBounds = Dictionary[string, Type](StringComparer.Ordinal)
            if conversionInputType != nil {
                for entry in candidateBounds {
                    if entry.Value.IsGenericParameter && argumentDependent.Contains(entry.Key) &&
                        !MentionsGenericParameter(conversionInputType, entry.Value) {
                        freeBounds[entry.Key] = entry.Value
                    }
                }
            }
            if ExtensionReceiverBoundsMayApply(
                method,
                receiver,
                parameterType,
                candidateBounds,
                argumentDependent,
                freeBounds,
                receiverTerms
            ) {
                return true
            }
        }
        let underlying = NullableLifting.GetValueTypeNullableUnderlyingClr(parameterType)
        if underlying == nil {
            return false
        }
        let wrappedBounds = Dictionary[string, Type](bounds, StringComparer.Ordinal)
        return UnifyForInference(underlying, carrier, wrappedBounds) &&
            ExtensionReceiverBoundsMayApply(
            method,
            receiver,
            parameterType,
            wrappedBounds,
            argumentDependent,
            receiverTerms: receiverTerms
        )
    }

    /// Validate receiver witnesses against closed signatures. Upper bounds
    /// retain compatible but unenumerable subtypes for later argument inference.
    private func ExtensionReceiverBoundsMayApply(
        method MethodInfo,
        receiver TypeSymbol,
        parameterType Type,
        bounds Dictionary[string, Type],
        argumentDependent HashSet[string],
        freeBounds IReadOnlyDictionary[string, Type]? = nil,
        receiverTerms IReadOnlyList[(Type, Type)]? = nil
    ) bool {
        let receiverClr = receiver.ClrType
        if receiverClr == nil {
            return true
        }
        let receiverBounds = Dictionary[string, Type](StringComparer.Ordinal)
        if !UnifyForInference(parameterType, receiverClr, receiverBounds) || receiverBounds.Any(
            (entry KeyValuePair[string, Type]) -> !argumentDependent.Contains(entry.Key) &&
                (!bounds.TryGetValue(entry.Key, out var argument) || !ClrTypeUtilities.AreSame(entry.Value, argument))
        ) {
            return false
        }
        let typeParameters = method.GetGenericArguments()
        var hasOpenReceiverBound = false
        for parameter in typeParameters {
            if !MentionsGenericParameter(parameterType, parameter) {
                continue
            }
            if bounds.TryGetValue(parameter.Name, out var bound) && !bound.ContainsGenericParameters {
                continue
            }
            if !argumentDependent.Contains(parameter.Name) {
                return false
            }
            hasOpenReceiverBound = true
        }
        if hasOpenReceiverBound &&
            IndependentExtensionReceiverOutputMayApply(method, receiver, bounds, argumentDependent) {
            return true
        }
        // Close metadata signatures with primitives from their own load context.
        var contextObject = typeParameters[0]
        while contextObject.BaseType is {} baseType {
            contextObject = baseType
        }
        let contextBounds = Dictionary[string, Type](StringComparer.Ordinal)
        for entry in bounds {
            contextBounds[entry.Key] = ClrTypeUtilities.RemapHostCoreTypeToContext(entry.Value, contextObject) ??
                entry.Value
        }
        let typeArguments = typeParameters.Select(
            (parameter Type) -> if contextBounds.TryGetValue(parameter.Name, out var argument) {
                argument
            } else {
                parameter
            }
        )
            .ToArray()
        if !ClosedExtensionReceiverConversionMayApply(method, receiver, typeArguments) {
            return false
        }
        let constraintsSatisfied = SatisfiesDeclaredConstraints(typeParameters, typeArguments, default, out _, out _)
        if typeArguments.Any((argument Type) -> argument.ContainsGenericParameters) || !constraintsSatisfied {
            return ArgumentDependentBoundsMaySatisfyConstraints(
                typeParameters,
                typeArguments,
                (receiverTerms ?? List[(Type, Type)](){(receiverClr, parameterType)}).Select(
                    (term(Type, Type)) -> (term.Item1, term.Item2, true)
                )
                    .ToList(),
                argumentDependent,
                freeBounds
            )
        }
        return true
    }

    private func ArgumentDependentBoundsMaySatisfyConstraints(
        parameters[]Type,
        arguments[]Type,
        receiverTerms IReadOnlyList[(Type, Type, bool)],
        argumentDependent HashSet[string],
        freeBounds IReadOnlyDictionary[string, Type]?,
        pinnedParameters HashSet[int32]? = nil,
        constraintAlternatives IReadOnlyDictionary[(Type, Type), Type]? = nil,
        validateAlternatives bool = true,
        refinements Dictionary[HashSet[(int32, Type, Type, Type, bool)], bool]? = nil,
        discoveredDomains Dictionary[(Type, Type), List[Type]]? = nil
    ) bool {
        let refinements = refinements ??
            Dictionary[HashSet[(int32, Type, Type, Type, bool)], bool](
            HashSet[(int32, Type, Type, Type, bool)].CreateSetComparer()
        )
        let arguments = NormalizeExtensionReceiverArguments(parameters, arguments)
        var possibleArguments = cast[[]Type](arguments.Clone())
        for var index = 0; index < parameters.Length; index++ {
            let parameter = parameters[index]
            if !arguments[index].ContainsGenericParameters && pinnedParameters?.Contains(index) != true &&
                argumentDependent.Contains(parameter.Name) &&
                (
                freeBounds?.ContainsKey(parameter.Name) == true || receiverTerms.Any(
                    (term(Type, Type, bool)) ->
                    MentionsGenericParameter(term.Item1, parameter) || MentionsGenericParameter(term.Item2, parameter)
                )
            ) {
                possibleArguments[index] = parameter
            }
        }
        possibleArguments = NormalizeExtensionReceiverArguments(parameters, possibleArguments)
        for var i = 0; i < parameters.Length; i++ {
            let attributes = ExtensionReceiverParameterAttributes(parameters, possibleArguments, i)
            if (attributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0 &&
                (attributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 {
                return false
            }
        }
        let choices = if constraintAlternatives != nil {
            Dictionary[(Type, Type), Type](constraintAlternatives)
        } else {
            Dictionary[(Type, Type), Type]()
        }
        let receiverTerms = ExpandExtensionReceiverConstraintTerms(
            parameters,
            possibleArguments,
            receiverTerms,
            choices
        )
        let refine = CreateExtensionReceiverRefinementQuery(
            parameters,
            possibleArguments,
            receiverTerms,
            choices,
            refinements
        )
        let domains = Dictionary[(Type, Type), List[Type]]()
        let constraintTerms = List[(Type, Type, bool)](receiverTerms)
        for var i = 0; i < parameters.Length; i++ {
            if possibleArguments[i].ContainsGenericParameters {
                continue
            }
            for rawConstraint in parameters[i].GetGenericParameterConstraints() {
                let constraint = SubstituteExtensionReceiverTerm(rawConstraint, parameters, possibleArguments)
                constraintTerms.Add((possibleArguments[i], constraint, false))
            }
        }
        let strictTerms = HashSet[(Type, Type)](
            constraintTerms.Where((term(Type, Type, bool)) -> !term.Item3).Select(
                (term(Type, Type, bool)) -> (
                    SubstituteExtensionReceiverTerm(term.Item1, parameters, possibleArguments),
                    SubstituteExtensionReceiverTerm(term.Item2, parameters, possibleArguments)
                )
            )
        )
        for term in constraintTerms {
            let source = SubstituteExtensionReceiverTerm(term.Item1, parameters, possibleArguments)
            let constraint = SubstituteExtensionReceiverTerm(term.Item2, parameters, possibleArguments)
            let key = (source, constraint)
            let numericDomain = constraint.IsGenericParameter && parameters.Contains(constraint) &&
                source.IsValueType &&
                NumericWideningLattice
                .WideningTargets(source.FullName).Any()
            if source.ContainsGenericParameters ||
                !constraint.ContainsGenericParameters ||
                (!constraint.IsGenericType && !numericDomain) ||
                choices.ContainsKey(key) {
                continue
            }
            let candidates = if numericDomain {
                if strictTerms.Contains(key) {
                    List[Type](){source}
                } else {
                    GetReceiverInferenceCarriers(source).Where(
                        (candidate Type) -> candidate.IsValueType ||
                            (
                            ExtensionReceiverParameterAttributes(
                                parameters,
                                possibleArguments,
                                Array.IndexOf(parameters, constraint)
                            ) &
                            GenericParameterAttributes.NotNullableValueTypeConstraint
                        ) == 0
                    )
                        .ToList()
                }
            } else {
                GetExtensionReceiverGenericShapes(source, constraint.GetGenericTypeDefinition())
            }
            let matches = candidates.Where(
                (candidate Type) -> OpenExtensionReceiverStandardShapeMayApply(
                    candidate,
                    constraint,
                    tupleElementConversions: false
                )
            )
                .ToList()
            if matches.Count == 0 {
                if !OpenExtensionReceiverStandardShapeMayApply(
                    source,
                    constraint,
                    tupleElementConversions: term.Item3
                ) {
                    return false
                }
                continue
            }
            if matches.Count == 1 {
                choices[key] = matches[0]
                continue
            }
            domains[key] = matches
            if discoveredDomains != nil {
                discoveredDomains[key] = matches
            }
        }
        if !ExtensionReceiverBoundDomainsMayApply(parameters, possibleArguments, choices, receiverTerms, refinements) {
            return false
        }
        if validateAlternatives {
            let discovered = Dictionary[(Type, Type), List[Type]]()
            let validate = func (selected IReadOnlyDictionary[(Type, Type), Type]) bool {
                discovered.Clear()
                return ArgumentDependentBoundsMaySatisfyConstraints(
                    parameters,
                    possibleArguments,
                    receiverTerms,
                    argumentDependent,
                    freeBounds,
                    pinnedParameters,
                    selected,
                    validateAlternatives: false,
                    refinements: refinements,
                    discoveredDomains: discovered
                )
            }
            if !ExtensionReceiverConstraintDomainsMayApply(
                parameters,
                possibleArguments,
                domains,
                choices,
                validate,
                discovered
            ) {
                return false
            }
        }
        for var index = 0; index < parameters.Length; index++ {
            if !ExtensionReceiverParameterIsOpen(parameters, possibleArguments, index) {
                continue
            }
            let parameter = parameters[index]
            let lowerBounds = List[Type]()
            let upperBounds = List[Type]()
            let referenceUpperBounds = List[Type]()
            CollectFixedExtensionReceiverConstraintBounds(
                parameters,
                possibleArguments,
                index,
                lowerBounds,
                upperBounds,
                choices,
                referenceUpperBounds
            )
            CollectExtensionReceiverTermBounds(
                parameters,
                possibleArguments,
                index,
                receiverTerms,
                lowerBounds,
                upperBounds,
                choices,
                referenceUpperBounds
            )
            let exactBounds = upperBounds.Where(
                (bound Type) -> !bound.ContainsGenericParameters && !InferenceBoundMayRefine(bound)
            )
                .ToList()
            let requiresValue = (
                ExtensionReceiverParameterAttributes(parameters, possibleArguments, index) &
                GenericParameterAttributes.NotNullableValueTypeConstraint
            ) != 0
            let openClassBounds = List[Type]()
            let pendingConstraints = Queue[Type](
                parameter.GetGenericParameterConstraints().Concat(
                    upperBounds.Where((bound Type) -> bound.IsGenericParameter)
                )
            )
            let visitedConstraints = HashSet[Type]()
            while pendingConstraints.Count > 0 {
                let rawConstraint = pendingConstraints.Dequeue()
                if !visitedConstraints.Add(rawConstraint) {
                    continue
                }
                if rawConstraint.IsGenericParameter {
                    for inherited in rawConstraint.GetGenericParameterConstraints() {
                        pendingConstraints.Enqueue(inherited)
                    }
                    EnqueueExtensionReceiverUpperBounds(
                        rawConstraint,
                        parameters,
                        possibleArguments,
                        choices,
                        receiverTerms,
                        pendingConstraints
                    )
                }
                let constraint = SubstituteExtensionReceiverTerm(rawConstraint, parameters, possibleArguments)
                if constraint.IsInterface {
                    upperBounds.Add(constraint)
                    continue
                }
                if constraint.ContainsGenericParameters {
                    if !constraint.IsGenericParameter {
                        openClassBounds.Add(constraint)
                    }
                    continue
                }
                if !InferenceBoundMayRefine(constraint) {
                    exactBounds.Add(constraint)
                } else if requiresValue &&
                    constraint.FullName != "System.Object" &&
                    constraint.FullName != "System.ValueType" &&
                    constraint.FullName != "System.Enum" {
                    return false
                } else {
                    upperBounds.Add(constraint)
                }
            }
            let inferred = Dictionary[Type, Type]()
            for upper in upperBounds {
                if lowerBounds.Any((lower Type) -> ClrTypeUtilities.AreSame(lower, upper)) {
                    exactBounds.Add(upper)
                }
            }
            for constraint in openClassBounds {
                for upper in upperBounds.Concat(exactBounds) {
                    if !upper.IsInterface && !InferCompatibleExtensionReceiverClassBounds(upper, constraint, inferred) {
                        return false
                    }
                }
            }
            for var i = 0; i < parameters.Length; i++ {
                if !ExtensionReceiverParameterIsOpen(parameters, possibleArguments, i) || !inferred.TryGetValue(
                    parameters[i],
                    out var candidate
                ) ||
                    candidate.ContainsGenericParameters {
                    continue
                }
                let candidateArguments = cast[[]Type](possibleArguments.Clone())
                candidateArguments[i] = candidate
                let pinned = if pinnedParameters != nil {
                    HashSet[int32](pinnedParameters)
                } else {
                    HashSet[int32]()
                }
                pinned.Add(i)
                return ArgumentDependentBoundsMaySatisfyConstraints(
                    parameters,
                    candidateArguments,
                    receiverTerms,
                    argumentDependent,
                    freeBounds,
                    pinned,
                    choices,
                    validateAlternatives,
                    refinements,
                    discoveredDomains
                )
            }
            if exactBounds.Count > 0 {
                let candidateArguments = cast[[]Type](possibleArguments.Clone())
                candidateArguments[index] = exactBounds[0]
                if !ExtensionReceiverBoundDomainsMayApply(
                    parameters,
                    candidateArguments,
                    choices,
                    receiverTerms,
                    refinements
                ) {
                    return false
                }
                let pinned = if pinnedParameters != nil {
                    HashSet[int32](pinnedParameters)
                } else {
                    HashSet[int32]()
                }
                pinned.Add(index)
                return ArgumentDependentBoundsMaySatisfyConstraints(
                    parameters,
                    candidateArguments,
                    receiverTerms,
                    argumentDependent,
                    freeBounds,
                    pinned,
                    choices,
                    validateAlternatives,
                    refinements,
                    discoveredDomains
                )
            }
            if requiresValue && referenceUpperBounds.Count > 0 {
                return false
            }
            for upper in upperBounds {
                if !requiresValue &&
                    !InferenceBoundMayHaveCompatibleSubtype(
                    upper,
                    parameter,
                    parameters,
                    possibleArguments,
                    refinements,
                    refine
                ) {
                    return false
                }
            }
            if !InferenceUpperBoundsMayRefineTogether(parameter, upperBounds, refinements, refine) {
                return false
            }
        }
        return SatisfiesDeclaredConstraints(
            parameters,
            NormalizeExtensionReceiverArguments(parameters, possibleArguments),
            default,
            out _,
            out _
        )
    }

    private func ExtensionReceiverConstraintRoot(parents[]int32, index int32) int32 {
        var root = index
        while parents[root] != root {
            root = parents[root]
        }
        return root
    }

    private func ExtensionReceiverConstraintParameterParents(parameters[]Type, arguments[]Type)[]int32 {
        let parametersParents = Enumerable.Range(0, parameters.Length).ToArray()
        for var i = 0; i < parameters.Length; i++ {
            if arguments[i].ContainsGenericParameters {
                for var j = 0; j < parameters.Length; j++ {
                    if MentionsGenericParameter(arguments[i], parameters[j]) {
                        parametersParents[ExtensionReceiverConstraintRoot(parametersParents, i)] =
                        ExtensionReceiverConstraintRoot(parametersParents, j)
                    }
                }
            }
        }
        for var i = 0; i < parameters.Length; i++ {
            if !arguments[i].ContainsGenericParameters {
                continue
            }
            for constraint in parameters[i].GetGenericParameterConstraints() {
                for var j = 0; j < parameters.Length; j++ {
                    if arguments[j].ContainsGenericParameters && MentionsGenericParameter(constraint, parameters[j]) {
                        parametersParents[ExtensionReceiverConstraintRoot(parametersParents, i)] =
                        ExtensionReceiverConstraintRoot(parametersParents, j)
                    }
                }
            }
        }
        return parametersParents
    }

    private func ExtensionReceiverConstraintDomainsMayApply(
        parameters[]Type,
        arguments[]Type,
        domains IReadOnlyDictionary[(Type, Type), List[Type]],
        choices IReadOnlyDictionary[(Type, Type), Type],
        validate Func[IReadOnlyDictionary[(Type, Type), Type], bool],
        discovered IReadOnlyDictionary[(Type, Type), List[Type]]
    ) bool {
        if domains.Count == 0 {
            return true
        }
        let parametersParents = ExtensionReceiverConstraintParameterParents(parameters, arguments)
        let keys = domains.Keys.ToList()
        let roots = List[HashSet[int32]]()
        for key in keys {
            let mentions = HashSet[int32]()
            for var i = 0; i < parameters.Length; i++ {
                if arguments[i].ContainsGenericParameters && MentionsGenericParameter(key.Item2, parameters[i]) {
                    mentions.Add(ExtensionReceiverConstraintRoot(parametersParents, i))
                }
            }
            roots.Add(mentions)
        }
        let parents = Enumerable.Range(0, keys.Count).ToArray()
        for var i = 0; i < keys.Count; i++ {
            for var j = 0; j < i; j++ {
                if roots[i].Overlaps(roots[j]) {
                    parents[ExtensionReceiverConstraintRoot(parents, i)] = ExtensionReceiverConstraintRoot(parents, j)
                }
            }
        }
        let components = Dictionary[int32, List[(Type, Type)]]()
        for var i = 0; i < keys.Count; i++ {
            let root = ExtensionReceiverConstraintRoot(parents, i)
            if !components.TryGetValue(root, out var component) {
                component = List[(Type, Type)]()
                components[root] = component
            }
            component.Add(keys[i])
        }
        for component in components.Values {
            if !ExtensionReceiverConstraintComponentMayApply(
                component,
                domains,
                choices,
                validate,
                discovered,
                HashSet[string](StringComparer.Ordinal)
            ) {
                return false
            }
        }
        return true
    }

    private func ExtensionReceiverConstraintComponentMayApply(
        component IReadOnlyList[(Type, Type)],
        domains IReadOnlyDictionary[(Type, Type), List[Type]],
        selected IReadOnlyDictionary[(Type, Type), Type],
        validate Func[IReadOnlyDictionary[(Type, Type), Type], bool],
        discovered IReadOnlyDictionary[(Type, Type), List[Type]],
        failed HashSet[string]
    ) bool {
        let state = string.Join(
            ",",
            component.Select(
                (key(Type, Type)) ->
                if selected.TryGetValue(key, out var choice) {
                    domains[key].FindIndex((candidate Type) -> ClrTypeUtilities.AreSame(choice, candidate))
                } else {
                    -1
                }
            )
        )
        if failed.Contains(state) {
            return false
        }
        if !validate(selected) {
            failed.Add(state)
            return false
        }
        let choices = Dictionary[(Type, Type), Type](selected)
        let remaining = Dictionary[(Type, Type), List[Type]]()
        for key in component {
            remaining[key] = domains[key].ToList()
        }
        var changed = true
        while changed {
            changed = false
            for key in component {
                if choices.ContainsKey(key) {
                    continue
                }
                let alternatives = remaining[key]
                for var i = alternatives.Count - 1; i >= 0; i-- {
                    let candidate = Dictionary[(Type, Type), Type](choices)
                    candidate[key] = alternatives[i]
                    if !validate(candidate) {
                        alternatives.RemoveAt(i)
                    }
                }
                if alternatives.Count == 0 {
                    failed.Add(state)
                    return false
                }
                if alternatives.Count == 1 {
                    choices[key] = alternatives[0]
                    changed = true
                }
            }
        }
        var branch = component[0]
        var smallest = int32.MaxValue
        for key in component {
            if !choices.ContainsKey(key) && remaining[key].Count < smallest {
                branch = key
                smallest = remaining[key].Count
            }
        }
        if smallest == int32.MaxValue {
            if !validate(choices) {
                return false
            }
            let extended = component.ToList()
            let expandedDomains = Dictionary[(Type, Type), List[Type]](domains)
            for domain in discovered {
                if !expandedDomains.ContainsKey(domain.Key) && !choices.ContainsKey(domain.Key) {
                    extended.Add(domain.Key)
                    expandedDomains[domain.Key] = domain.Value
                }
            }
            return extended.Count == component.Count ||
                ExtensionReceiverConstraintComponentMayApply(
                extended,
                expandedDomains,
                choices,
                validate,
                discovered,
                failed
            )
        }
        for alternative in remaining[branch] {
            let candidate = Dictionary[(Type, Type), Type](choices)
            candidate[branch] = alternative
            if ExtensionReceiverConstraintComponentMayApply(
                component,
                domains,
                candidate,
                validate,
                discovered,
                failed
            ) {
                return true
            }
        }
        failed.Add(state)
        return false
    }

    private func InferCompatibleExtensionReceiverClassBounds(
        upper Type,
        constraint Type,
        inferred Dictionary[Type, Type]
    ) bool {
        if upper.IsGenericParameter || constraint.IsGenericParameter {
            return true
        }
        if upper.IsArray || constraint.IsArray {
            // Array constructions are validated jointly by the variance solver.
            if upper.IsArray && constraint.IsArray {
                return upper.IsSZArray == constraint.IsSZArray && upper.GetArrayRank() == constraint.GetArrayRank()
            }
            let other = if upper.IsArray {
                constraint
            } else {
                upper
            }
            return other.FullName is "System.Object" or "System.Array"
        }
        let Definition = func (type Type) Type {
            return if type.IsGenericType {
                type.GetGenericTypeDefinition()
            } else {
                type
            }
        }
        let Match = func (type Type, definition Type) Type? {
            for var current Type? = type; current != nil; current = current!!.BaseType {
                if ClrTypeUtilities.AreSame(Definition(current), definition) {
                    return current
                }
            }
            return nil
        }
        var pattern Type? = constraint
        var actual = Match(upper, Definition(constraint))
        if actual == nil {
            pattern = Match(constraint, Definition(upper))
            actual = upper
        }
        return pattern != nil && InferExactExtensionReceiverTypeArguments(pattern, actual, inferred)
    }

    private func InferExactExtensionReceiverTypeArguments(
        pattern Type,
        actual Type,
        inferred Dictionary[Type, Type]
    ) bool {
        if pattern == actual {
            return true
        }
        if pattern.IsGenericParameter {
            if inferred.TryGetValue(pattern, out var existing) {
                return existing == actual ||
                    !existing.ContainsGenericParameters &&
                    !actual.ContainsGenericParameters &&
                    ClrTypeUtilities.AreSame(existing, actual)
            }
            inferred[pattern] = actual
            return true
        }
        if pattern.HasElementType || actual.HasElementType {
            if pattern.IsArray != actual.IsArray ||
                pattern.IsByRef != actual.IsByRef ||
                pattern.IsPointer != actual.IsPointer ||
                (
                pattern.IsArray &&
                    (pattern.GetArrayRank() != actual.GetArrayRank() || pattern.IsSZArray != actual.IsSZArray)
            ) {
                return false
            }
            let patternElement = pattern.GetElementType()
            let actualElement = actual.GetElementType()
            return patternElement != nil &&
                actualElement != nil &&
                InferExactExtensionReceiverTypeArguments(patternElement, actualElement, inferred)
        }
        if !pattern.IsGenericType || !actual.IsGenericType {
            return ClrTypeUtilities.AreSame(pattern, actual)
        }
        if !ClrTypeUtilities.AreSame(pattern.GetGenericTypeDefinition(), actual.GetGenericTypeDefinition()) {
            return false
        }
        let patterns = pattern.GetGenericArguments()
        let arguments = actual.GetGenericArguments()
        for var i = 0; i < patterns.Length; i++ {
            if !InferExactExtensionReceiverTypeArguments(patterns[i], arguments[i], inferred) {
                return false
            }
        }
        return true
    }

    private func InferenceBoundMayRefine(type Type) bool {
        if type.IsValueType {
            return false
        }
        if type.IsArray {
            return type.GetElementType() is {} element && InferenceBoundMayRefine(element)
        }
        if !type.IsSealed {
            return true
        }
        if !type.IsGenericType || !ClrTypeUtilities.IsDelegateType(type) {
            return false
        }
        let arguments = type.GetGenericArguments()
        let slots = type.GetGenericTypeDefinition().GetGenericArguments()
        for var i = 0; i < arguments.Length; i++ {
            if arguments[i].IsValueType {
                continue
            }
            let variance = slots[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
            if (variance == GenericParameterAttributes.Covariant && InferenceBoundMayRefine(arguments[i])) ||
                (variance == GenericParameterAttributes.Contravariant && arguments[i].FullName != "System.Object") {
                return true
            }
        }
        return false
    }

    private func InferenceRefinementShape(type Type) Type? {
        if !type.IsArray {
            return if type.IsGenericType {
                type.GetGenericTypeDefinition()
            } else {
                type
            }
        }
        let contextObject = ResolveObjectInSameContext(type) ?? typeof(object)
        let enumerable = contextObject.Assembly.GetType("System.Collections.Generic.IEnumerable`1")
        if enumerable == nil {
            return nil
        }
        // Reuse a same-context metadata slot for the array element equation.
        let element = enumerable.GetGenericArguments()[0]
        return if type.IsSZArray {
            element.MakeArrayType()
        } else {
            element.MakeArrayType(type.GetArrayRank())
        }
    }

    private func CreateExtensionReceiverRefinementQuery(
        parameters[]Type,
        arguments[]Type,
        receiverTerms IReadOnlyList[(Type, Type, bool)],
        choices IReadOnlyDictionary[(Type, Type), Type],
        refinements Dictionary[HashSet[(int32, Type, Type, Type, bool)], bool]
    ) Func[Type, []Type, IReadOnlyList[(Type, Type, bool)], bool] {
        return func (owner Type, prototypeSlots[]Type, terms IReadOnlyList[(Type, Type, bool)]) bool {
            let parents = ExtensionReceiverConstraintParameterParents(parameters, arguments)
            for term in receiverTerms {
                ConnectExtensionReceiverTermParameters(
                    SubstituteExtensionReceiverTerm(term.Item1, parameters, arguments),
                    SubstituteExtensionReceiverTerm(term.Item2, parameters, arguments),
                    parameters,
                    parents
                )
            }
            let roots = Enumerable
                .Range(0, parameters.Length)
                .Where(
                (i int32) -> parameters[i] == owner || terms.Any(
                    (term(Type, Type, bool)) -> MentionsGenericParameter(term.Item2, parameters[i])
                )
            )
                .Select((i int32) -> ExtensionReceiverConstraintRoot(parents, i))
                .ToHashSet()
            let component = Enumerable
                .Range(0, parameters.Length)
                .Where((i int32) -> roots.Contains(ExtensionReceiverConstraintRoot(parents, i)))
                .ToArray()
            let attributes = ExtensionReceiverParameterAttributes(
                parameters,
                arguments,
                Array.IndexOf(parameters, owner)
            )
            if (attributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 ||
                (
                (attributes & GenericParameterAttributes.DefaultConstructorConstraint) != 0 &&
                    terms[0]
                    .Item1
                    .GetConstructor(Type.EmptyTypes) == nil
            ) {
                return false
            }
            if choices.Values.All((selected Type) -> !selected.ContainsGenericParameters) && terms.All(
                (term(Type, Type, bool)) -> !term.Item2.ContainsGenericParameters
            ) &&
                component
                .All(
                (i int32) -> parameters[i] == arguments[i] && parameters[i].GetGenericParameterConstraints().All(
                    (constraint Type) -> !constraint.ContainsGenericParameters || constraint.IsGenericParameter
                )
            ) {
                let key = HashSet[(int32, Type, Type, Type, bool)](
                    terms.Select((term(Type, Type, bool)) -> (0, term.Item1, term.Item2, term.Item2, term.Item3))
                )
                if refinements.TryGetValue(key, out var cached) {
                    return cached
                }
                refinements[key] = true
                let possible = ArgumentDependentBoundsMaySatisfyConstraints(
                    prototypeSlots,
                    prototypeSlots,
                    terms,
                    HashSet[string](StringComparer.Ordinal),
                    nil,
                    refinements: refinements
                )
                refinements[key] = possible
                return possible
            }
            var slots = prototypeSlots
            if component.Any((i int32) -> slots.Contains(parameters[i])) {
                slots = prototypeSlots.ToArray()
                let contextObject = ResolveObjectInSameContext(prototypeSlots[0]) ?? typeof(object)
                let available = contextObject
                    .Assembly
                    .GetTypes()
                    .Where((type Type) -> type.IsGenericTypeDefinition)
                    .OrderBy((type Type) -> type.FullName ?? type.Name, StringComparer.Ordinal)
                    .SelectMany((type Type) -> type.GetGenericArguments())
                    .Distinct()
                    .ToArray()
                for var i = 0; i < slots.Length; i++ {
                    if !component.Any((index int32) -> parameters[index] == prototypeSlots[i]) {
                        continue
                    }
                    let slotAttributes = prototypeSlots[i].GenericParameterAttributes &
                    ~GenericParameterAttributes.VarianceMask
                    let replacement = available.FirstOrDefault(
                        (candidate Type) ->
                        (candidate.GenericParameterAttributes & ~GenericParameterAttributes.VarianceMask) ==
                        slotAttributes && candidate.GetGenericParameterConstraints().All(
                            (constraint Type) ->
                            (slotAttributes & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 &&
                                constraint.FullName == "System.ValueType"
                        ) &&
                            !parameters.Contains(candidate) && !slots.Contains(candidate) && !arguments.Any(
                            (argument Type) -> MentionsGenericParameter(argument, candidate)
                        ) &&
                            !receiverTerms
                            .Any(
                            (term(Type, Type, bool)) ->
                            MentionsGenericParameter(term.Item1, candidate) ||
                                MentionsGenericParameter(term.Item2, candidate)
                        ) &&
                            !terms.Any((term(Type, Type, bool)) -> MentionsGenericParameter(term.Item2, candidate))
                    )
                    if replacement == nil {
                        return true
                    }
                    // Alpha-rename only the new scope, never enclosing target variables.
                    slots[i] = replacement
                }
            }
            let projectedParameters = component.Select((i int32) -> parameters[i]).Concat(slots).ToArray()
            let projectedArguments = component.Select((i int32) -> arguments[i]).Concat(slots).ToArray()
            let projectedTerms = terms.Select(
                (term(Type, Type, bool)) -> (
                    SubstituteExtensionReceiverTerm(term.Item1, prototypeSlots, slots),
                    term.Item2,
                    term.Item3
                )
            )
                .ToList()
            for var i = 0; i < slots.Length; i++ {
                if slots[i] != prototypeSlots[i] {
                    for constraint in prototypeSlots[i].GetGenericParameterConstraints() {
                        projectedTerms.Add(
                            (slots[i], SubstituteExtensionReceiverTerm(constraint, prototypeSlots, slots), false)
                        )
                    }
                }
            }
            if component.Length > 0 {
                projectedTerms.AddRange(
                    receiverTerms.Select(
                        (term(Type, Type, bool)) -> (
                            SubstituteExtensionReceiverTerm(term.Item1, parameters, arguments),
                            SubstituteExtensionReceiverTerm(term.Item2, parameters, arguments),
                            term.Item3
                        )
                    )
                )
                for parameter in parameters {
                    for constraint in parameter.GetGenericParameterConstraints() {
                        let source = SubstituteExtensionReceiverTerm(parameter, parameters, arguments)
                        let target = SubstituteExtensionReceiverTerm(constraint, parameters, arguments)
                        if component.Any(
                            (i int32) -> MentionsGenericParameter(source, parameters[i]) ||
                                MentionsGenericParameter(target, parameters[i])
                        ) {
                            projectedTerms.Add((source, target, false))
                        }
                    }
                }
            }
            let state = HashSet[(int32, Type, Type, Type, bool)](
                projectedTerms.Select((term(Type, Type, bool)) -> (0, term.Item1, term.Item2, term.Item2, term.Item3))
            )
            state.Add((3, owner, owner, owner, false))
            for var i = 0; i < projectedParameters.Length; i++ {
                state.Add((1, projectedParameters[i], projectedArguments[i], projectedArguments[i], false))
            }
            if component.Length > 0 {
                for choice in choices {
                    state.Add((2, choice.Key.Item1, choice.Key.Item2, choice.Value, false))
                }
            }
            if refinements.TryGetValue(state, out var cached) {
                return cached
            }
            refinements[state] = true
            let equations = Dictionary[Type, Type]()
            for var i = 0; i < projectedParameters.Length; i++ {
                if projectedParameters[i] != projectedArguments[i] {
                    equations[projectedParameters[i]] = projectedArguments[i]
                }
            }
            if !UnifyExtensionReceiverConstructorEquation(
                ResolveExtensionReceiverEquations(owner, equations),
                projectedTerms[0].Item1,
                slots,
                equations
            ) {
                refinements[state] = false
                return false
            }
            for term in projectedTerms {
                var source = ResolveExtensionReceiverEquations(term.Item1, equations)
                let target = ResolveExtensionReceiverEquations(term.Item2, equations)
                var exact = false
                if component.Length > 0 && choices.TryGetValue((source, target), out var selected) {
                    source = selected
                    exact = target.IsGenericParameter
                }
                if !CollectExtensionReceiverConversionBounds(
                    source,
                    target,
                    projectedParameters[0],
                    List[Type](),
                    List[Type](),
                    exact: exact,
                    tupleElementConversions: term.Item3,
                    equations: equations,
                    equationSlots: slots
                ) {
                    refinements[state] = false
                    return false
                }
            }
            for var i = 0; i < projectedArguments.Length; i++ {
                projectedArguments[i] = ResolveExtensionReceiverEquations(projectedArguments[i], equations)
            }
            let projectedChoices = Dictionary[(Type, Type), Type]()
            if component.Length > 0 {
                for choice in choices {
                    let key = (
                        ResolveExtensionReceiverEquations(choice.Key.Item1, equations),
                        ResolveExtensionReceiverEquations(choice.Key.Item2, equations)
                    )
                    let selected = ResolveExtensionReceiverEquations(choice.Value, equations)
                    if projectedChoices.TryGetValue(key, out var previous) && previous != selected {
                        refinements[state] = false
                        return false
                    }
                    projectedChoices[key] = selected
                }
            }
            let possible = ArgumentDependentBoundsMaySatisfyConstraints(
                projectedParameters,
                projectedArguments,
                projectedTerms,
                HashSet[string](StringComparer.Ordinal),
                nil,
                constraintAlternatives: projectedChoices,
                refinements: refinements
            )
            refinements[state] = possible
            return possible
        }
    }

    private func InferenceUpperBoundsMayRefineTogether(
        owner Type,
        bounds IReadOnlyList[Type],
        refinements Dictionary[HashSet[(int32, Type, Type, Type, bool)], bool],
        refine Func[Type, []Type, IReadOnlyList[(Type, Type, bool)], bool]? = nil
    ) bool {
        for var i = 0; i < bounds.Count; i++ {
            let bound = bounds[i]
            for var j = 0; j < i; j++ {
                let other = bounds[j]
                if bound.ContainsGenericParameters || other.ContainsGenericParameters {
                    let contract = if bound.ContainsGenericParameters {
                        bound
                    } else {
                        other
                    }
                    let family = if bound.ContainsGenericParameters {
                        other
                    } else {
                        bound
                    }
                    if contract.IsInterface && !family.ContainsGenericParameters && family.IsSealed {
                        let source = if InferenceBoundMayRefine(family) {
                            InferenceRefinementShape(family)
                        } else {
                            family
                        }
                        if source != nil &&
                            !OpenExtensionReceiverStandardShapeMayApply(
                            source,
                            contract,
                            tupleElementConversions: false
                        ) {
                            return false
                        }
                    }
                    continue
                }
                if (!InferenceBoundMayRefine(bound) && !IsExtensionReceiverBoundPromotion(other, bound)) ||
                    (!InferenceBoundMayRefine(other) && !IsExtensionReceiverBoundPromotion(bound, other)) {
                    return false
                }
                if IsExtensionReceiverBoundPromotion(bound, other) || IsExtensionReceiverBoundPromotion(other, bound) {
                    continue
                }
                if bound.IsInterface || other.IsInterface {
                    let family = if bound.IsInterface {
                        other
                    } else {
                        bound
                    }
                    let contract = if bound.IsInterface {
                        bound
                    } else {
                        other
                    }
                    if family.IsSealed {
                        if !InferenceBoundMayRefine(family) {
                            return false
                        }
                        let source = InferenceRefinementShape(family)
                        if source != nil &&
                            !OpenExtensionReceiverStandardShapeMayApply(
                            source,
                            contract,
                            tupleElementConversions: false
                        ) {
                            return false
                        }
                    }
                    continue
                }
                if bound.IsArray &&
                    other.IsArray &&
                    bound.IsSZArray == other.IsSZArray &&
                    bound.GetArrayRank() == other.GetArrayRank() {
                    continue
                }
                if !bound.IsGenericType || !other.IsGenericType || !ClrTypeUtilities.IsDelegateType(bound) ||
                    !ClrTypeUtilities.AreSame(bound.GetGenericTypeDefinition(), other.GetGenericTypeDefinition()) {
                    return false
                }
            }
        }
        let families = HashSet[Type]()
        for bound in bounds {
            if (!bound.IsArray && (!bound.IsGenericType || !ClrTypeUtilities.IsDelegateType(bound))) ||
                !InferenceBoundMayRefine(bound) {
                continue
            }
            let definition = InferenceRefinementShape(bound)
            if definition == nil || !families.Add(definition) {
                continue
            }
            let terms = bounds
                .Where(
                (other Type) -> if bound.IsArray {
                    other.IsInterface ||
                        other.IsArray &&
                        other.IsSZArray == bound.IsSZArray &&
                        other.GetArrayRank() == bound.GetArrayRank()
                } else {
                    other.IsGenericType && ClrTypeUtilities.AreSame(definition, other.GetGenericTypeDefinition())
                }
            )
                .Select((other Type) -> (definition, other, false))
                .ToList()
            if terms.Count < 2 {
                continue
            }
            let key = HashSet[(int32, Type, Type, Type, bool)](
                terms.Select((term(Type, Type, bool)) -> (0, term.Item1, term.Item2, term.Item2, term.Item3))
            )
            let cacheable = refine == nil && terms.All(
                (term(Type, Type, bool)) -> !term.Item2.ContainsGenericParameters
            )
            if cacheable && refinements.TryGetValue(key, out var cached) {
                if !cached {
                    return false
                }
                continue
            }
            let parameters = if definition.GetElementType() is {} element {
                []Type{element}
            } else {
                definition.GetGenericArguments()
            }
            // Variance relates constructions, not nominal subclasses. Reuse
            // the symbolic solver for all of the family's slot obligations.
            // Active recursive obligations remain unknown, not impossible.
            if cacheable {
                refinements[key] = true
            }
            let possible = if refine != nil {
                refine(owner, parameters, terms)
            } else {
                ArgumentDependentBoundsMaySatisfyConstraints(
                    parameters,
                    parameters,
                    terms,
                    HashSet[string](parameters.Select((parameter Type) -> parameter.Name), StringComparer.Ordinal),
                    nil,
                    refinements: refinements
                )
            }
            if cacheable {
                refinements[key] = possible
            }
            if !possible {
                return false
            }
        }
        return true
    }

    // CLR constraint bounds do not relax standalone G# argument conversions.
    private func IsExtensionReceiverBoundPromotion(target Type, source Type) bool ->
    IsInferenceBoundPromotion(target, source) ||
        (
        !target.IsValueType &&
            !source.IsValueType &&
            OpenExtensionReceiverStandardShapeMayApply(source, target, tupleElementConversions: false) &&
            IsVariantAssignable(target, source)
    )

    private func CollectFixedExtensionReceiverConstraintBounds(
        parameters[]Type,
        arguments[]Type,
        index int32,
        lowerBounds List[Type],
        upperBounds List[Type],
        constraintAlternatives IReadOnlyDictionary[(Type, Type), Type],
        referenceUpperBounds List[Type]? = nil
    ) {
        let parameter = parameters[index]
        for var i = 0; i < parameters.Length; i++ {
            if i == index || arguments[i].ContainsGenericParameters {
                continue
            }
            for constraint in parameters[i].GetGenericParameterConstraints() {
                if !MentionsGenericParameter(constraint, parameter) {
                    continue
                }
                let target = SubstituteExtensionReceiverTerm(constraint, parameters, arguments)
                let source = SubstituteExtensionReceiverTerm(arguments[i], parameters, arguments)
                let argument = if constraintAlternatives.TryGetValue((source, target), out var selected) {
                    selected
                } else {
                    source
                }
                CollectExtensionReceiverConversionBounds(
                    argument,
                    constraint,
                    parameter,
                    lowerBounds,
                    upperBounds,
                    referenceUpperBounds: referenceUpperBounds
                )
            }
        }
    }

    private func CollectExtensionReceiverConversionBounds(
        source Type,
        target Type,
        parameter Type,
        lowerBounds List[Type],
        upperBounds List[Type],
        exact bool = false,
        tupleElementConversions bool = false,
        referenceUpperBounds List[Type]? = nil,
        referenceVariance bool = false,
        equations Dictionary[Type, Type]? = nil,
        equationSlots([]Type)? = nil
    ) bool {
        if source == target {
            return true
        }
        if source.IsGenericParameter || target.IsGenericParameter {
            if source.IsGenericParameter && !tupleElementConversions && equations != nil {
                var nested = target
                while nested.IsArray && nested.GetElementType() is {} element {
                    if element == source {
                        return false
                    }
                    nested = element
                }
            }
            if exact &&
                source.ContainsGenericParameters &&
                target.ContainsGenericParameters &&
                equations != nil &&
                equationSlots != nil &&
                equationSlots
                .Any((slot Type) -> MentionsGenericParameter(source, slot) || MentionsGenericParameter(target, slot)) {
                return UnifyExtensionReceiverConstructorEquation(source, target, equationSlots, equations)
            }
            if source.IsGenericParameter && MentionsGenericParameter(source, parameter) {
                upperBounds.Add(target)
                if !exact && referenceVariance && !target.ContainsGenericParameters {
                    referenceUpperBounds?.Add(target)
                }
                if exact && !target.ContainsGenericParameters {
                    lowerBounds.Add(target)
                }
            }
            if target.IsGenericParameter &&
                MentionsGenericParameter(target, parameter) &&
                !source.ContainsGenericParameters {
                lowerBounds.Add(source)
                if exact {
                    upperBounds.Add(source)
                }
            }
            return true
        }
        let underlying = if tupleElementConversions && !exact {
            NullableLifting.GetValueTypeNullableUnderlyingClr(target)
        } else {
            nil
        }
        if underlying != nil {
            return CollectExtensionReceiverConversionBounds(
                NullableLifting.GetValueTypeNullableUnderlyingClr(source) ?? source,
                underlying,
                parameter,
                lowerBounds,
                upperBounds,
                tupleElementConversions: true,
                referenceUpperBounds: referenceUpperBounds,
                referenceVariance: referenceVariance,
                equations: equations,
                equationSlots: equationSlots
            )
        }
        if source.IsArray && target.IsArray && source.GetArrayRank() == target.GetArrayRank() &&
            source.IsSZArray == target
            .IsSZArray {
            let sourceElement = source.GetElementType()
            let targetElement = target.GetElementType()
            if sourceElement != nil && targetElement != nil {
                let elementVariance = (referenceVariance || !tupleElementConversions) &&
                    !exact &&
                    !sourceElement.IsValueType &&
                    !targetElement.IsValueType
                return CollectExtensionReceiverConversionBounds(
                    sourceElement,
                    targetElement,
                    parameter,
                    lowerBounds,
                    upperBounds,
                    exact || !elementVariance,
                    tupleElementConversions,
                    referenceUpperBounds,
                    elementVariance,
                    equations,
                    equationSlots
                )
            }
            return true
        }
        if !target.IsGenericType {
            return true
        }
        let definition = target.GetGenericTypeDefinition()
        if !source.IsGenericType || !ClrTypeUtilities.AreSame(source.GetGenericTypeDefinition(), definition) {
            if !exact {
                let shapes = GetExtensionReceiverGenericShapes(source, definition)
                if shapes.Count == 1 {
                    return CollectExtensionReceiverConversionBounds(
                        shapes[0],
                        target,
                        parameter,
                        lowerBounds,
                        upperBounds,
                        tupleElementConversions: tupleElementConversions,
                        referenceUpperBounds: referenceUpperBounds,
                        referenceVariance: referenceVariance,
                        equations: equations,
                        equationSlots: equationSlots
                    )
                }
            }
            return true
        }
        let sources = source.GetGenericArguments()
        let targets = target.GetGenericArguments()
        let slots = definition.GetGenericArguments()
        let tupleElements = tupleElementConversions && !exact && definition.FullName?.StartsWith(
            "System.ValueTuple`",
            StringComparison.Ordinal
        ) == true
        for var i = 0; i < sources.Length; i++ {
            let variance = if tupleElements {
                GenericParameterAttributes.Covariant
            } else if exact || sources[i].IsValueType || targets[i].IsValueType {
                GenericParameterAttributes.None
            } else {
                slots[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
            }
            if variance == GenericParameterAttributes.Contravariant {
                if !CollectExtensionReceiverConversionBounds(
                    targets[i],
                    sources[i],
                    parameter,
                    lowerBounds,
                    upperBounds,
                    referenceUpperBounds: referenceUpperBounds,
                    referenceVariance: true,
                    equations: equations,
                    equationSlots: equationSlots
                ) {
                    return false
                }
            } else {
                if !CollectExtensionReceiverConversionBounds(
                    sources[i],
                    targets[i],
                    parameter,
                    lowerBounds,
                    upperBounds,
                    variance == GenericParameterAttributes.None,
                    tupleElements,
                    referenceUpperBounds,
                    referenceVariance || !tupleElements && variance != GenericParameterAttributes.None,
                    equations,
                    equationSlots
                ) {
                    return false
                }
            }
        }
        return true
    }

    private func SubstituteExtensionReceiverTerm(type Type, parameters[]Type, arguments[]Type) Type {
        var contextObject = parameters[0]
        while contextObject.BaseType is {} baseType {
            contextObject = baseType
        }
        var substituted = ClrTypeUtilities.RemapHostCoreTypeToContext(type, contextObject) ?? type
        let equations = Dictionary[Type, Type]()
        for var i = 0; i < parameters.Length; i++ {
            if parameters[i] != arguments[i] {
                equations[parameters[i]] = arguments[i]
            }
        }
        return ResolveExtensionReceiverEquations(substituted, equations)
    }

    private func CollectExtensionReceiverTermBounds(
        parameters[]Type,
        arguments[]Type,
        index int32,
        receiverTerms IReadOnlyList[(Type, Type, bool)],
        lowerBounds List[Type],
        upperBounds List[Type],
        choices IReadOnlyDictionary[(Type, Type), Type],
        referenceUpperBounds List[Type]? = nil
    ) int32 {
        var fixedLowerCount = lowerBounds.Count
        for var pass = 0; pass < 2; pass++ {
            let allowTupleElements = pass == 1
            for term in receiverTerms {
                if term.Item3 != allowTupleElements {
                    continue
                }
                var source = SubstituteExtensionReceiverTerm(term.Item1, parameters, arguments)
                let target = SubstituteExtensionReceiverTerm(term.Item2, parameters, arguments)
                var exact = false
                if choices.TryGetValue((source, target), out var selected) {
                    source = selected
                    exact = target.IsGenericParameter
                }
                CollectExtensionReceiverConversionBounds(
                    source,
                    target,
                    parameters[index],
                    lowerBounds,
                    upperBounds,
                    exact: exact,
                    tupleElementConversions: allowTupleElements,
                    referenceUpperBounds: referenceUpperBounds
                )
            }
            if !allowTupleElements {
                fixedLowerCount = lowerBounds.Count
            }
        }
        return fixedLowerCount
    }

    private func ExpandExtensionReceiverConstraintTerms(
        parameters[]Type,
        arguments[]Type,
        receiverTerms IReadOnlyList[(Type, Type, bool)],
        choices IReadOnlyDictionary[(Type, Type), Type]
    ) List[(Type, Type, bool)] {
        let terms = receiverTerms.ToList()
        let known = HashSet[(Type, Type, bool)](terms)
        // A simple dependency path visits at most every method parameter.
        // Recursive metadata relationships remain symbolic instead of
        // unfolding an unbounded sequence of constructed types.
        for var pass = 0; pass < parameters.Length; pass++ {
            var changed = false
            for var i = 0; i < parameters.Length; i++ {
                if !ExtensionReceiverParameterIsOpen(parameters, arguments, i) {
                    continue
                }
                let lower = List[Type]()
                let upper = List[Type]()
                CollectFixedExtensionReceiverConstraintBounds(parameters, arguments, i, lower, upper, choices)
                let fixedLowerCount = CollectExtensionReceiverTermBounds(
                    parameters,
                    arguments,
                    i,
                    terms,
                    lower,
                    upper,
                    choices
                )
                for var index = 0; index < lower.Count; index++ {
                    let source = lower[index]
                    if source.ContainsGenericParameters {
                        continue
                    }
                    if source.IsValueType && index >= fixedLowerCount && !upper.Any(
                        (bound Type) -> ClrTypeUtilities.AreSame(bound, source)
                    ) {
                        if NullableLifting.GetValueTypeNullableUnderlyingClr(source) != nil ||
                            source
                            .FullName
                            ?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) == true {
                            continue
                        }
                        if NumericWideningLattice.WideningTargets(source.FullName).Any() {
                            let promotion = (source, parameters[i], true)
                            if known.Add(promotion) {
                                terms.Add(promotion)
                                changed = true
                            }
                            continue
                        }
                    }
                    for rawConstraint in parameters[i].GetGenericParameterConstraints() {
                        let constraint = SubstituteExtensionReceiverTerm(rawConstraint, parameters, arguments)
                        let term = (source, constraint, false)
                        if known.Add(term) {
                            terms.Add(term)
                            changed = true
                        }
                    }
                }
            }
            if !changed {
                break
            }
        }
        return terms
    }

    private func EnqueueExtensionReceiverUpperBounds(
        parameter Type,
        parameters[]Type,
        arguments[]Type,
        choices IReadOnlyDictionary[(Type, Type), Type],
        receiverTerms IReadOnlyList[(Type, Type, bool)],
        pending Queue[Type]
    ) {
        for var i = 0; i < parameters.Length; i++ {
            if !MentionsGenericParameter(parameter, parameters[i]) {
                continue
            }
            let lower = List[Type]()
            let upper = List[Type]()
            CollectFixedExtensionReceiverConstraintBounds(parameters, arguments, i, lower, upper, choices)
            CollectExtensionReceiverTermBounds(parameters, arguments, i, receiverTerms, lower, upper, choices)
            for bound in upper {
                pending.Enqueue(bound)
            }
        }
    }

    private func GetExtensionReceiverDomainCandidates(
        lowerBounds IReadOnlyList[Type],
        upperBounds IReadOnlyList[Type]
    ) List[Type] {
        let candidates = List[Type]()
        for lower in lowerBounds {
            candidates.AddRange(GetReceiverInferenceCarriers(lower))
        }
        candidates.AddRange(upperBounds.Where((upper Type) -> !upper.ContainsGenericParameters))
        return candidates
    }

    private func ExtensionReceiverBoundDomainsMayApply(
        parameters[]Type,
        arguments[]Type,
        choices IReadOnlyDictionary[(Type, Type), Type],
        receiverTerms IReadOnlyList[(Type, Type, bool)],
        refinements Dictionary[HashSet[(int32, Type, Type, Type, bool)], bool]
    ) bool {
        let arguments = NormalizeExtensionReceiverArguments(parameters, arguments)
        let refine = CreateExtensionReceiverRefinementQuery(parameters, arguments, receiverTerms, choices, refinements)
        if !SatisfiesDeclaredConstraints(parameters, arguments, default, out _, out _) {
            return false
        }
        for term in receiverTerms {
            if !OpenExtensionReceiverStandardShapeMayApply(
                SubstituteExtensionReceiverTerm(term.Item1, parameters, arguments),
                SubstituteExtensionReceiverTerm(term.Item2, parameters, arguments),
                tupleElementConversions: term.Item3
            ) {
                return false
            }
        }
        let inferred = Dictionary[Type, Type]()
        for var index = 0; index < parameters.Length; index++ {
            if !ExtensionReceiverParameterIsOpen(parameters, arguments, index) {
                continue
            }
            let parameter = parameters[index]
            let lowerBounds = List[Type]()
            let upperBounds = List[Type]()
            CollectFixedExtensionReceiverConstraintBounds(
                parameters,
                arguments,
                index,
                lowerBounds,
                upperBounds,
                choices
            )
            let fixedLowerCount = CollectExtensionReceiverTermBounds(
                parameters,
                arguments,
                index,
                receiverTerms,
                lowerBounds,
                upperBounds,
                choices
            )
            let pending = Queue[Type](
                parameter.GetGenericParameterConstraints().Concat(
                    upperBounds.Where((bound Type) -> bound.IsGenericParameter)
                )
            )
            let visited = HashSet[Type]()
            while pending.Count > 0 {
                let rawConstraint = pending.Dequeue()
                if !visited.Add(rawConstraint) {
                    continue
                }
                if rawConstraint.IsGenericParameter {
                    for inherited in rawConstraint.GetGenericParameterConstraints() {
                        pending.Enqueue(inherited)
                    }
                    EnqueueExtensionReceiverUpperBounds(
                        rawConstraint,
                        parameters,
                        arguments,
                        choices,
                        receiverTerms,
                        pending
                    )
                }
                let constraint = SubstituteExtensionReceiverTerm(rawConstraint, parameters, arguments)
                if !constraint.IsGenericParameter {
                    upperBounds.Add(constraint)
                }
            }
            let requiresValue = (
                ExtensionReceiverParameterAttributes(parameters, arguments, index) &
                GenericParameterAttributes.NotNullableValueTypeConstraint
            ) != 0
            if requiresValue && lowerBounds.Any(
                (lower Type) -> !lower.IsValueType || NullableLifting.IsValueTypeNullableClr(lower)
            ) {
                return false
            }
            for var lowerIndex = 0; lowerIndex < lowerBounds.Count; lowerIndex++ {
                let lower = lowerBounds[lowerIndex]
                if lowerIndex >= fixedLowerCount && lower.IsGenericType && lower.FullName?.StartsWith(
                    "System.ValueTuple`",
                    StringComparison.Ordinal
                ) == true {
                    if !ExtensionReceiverTupleConstructorMayApply(
                        lower,
                        index,
                        parameters,
                        arguments,
                        upperBounds,
                        receiverTerms,
                        choices,
                        refinements
                    ) {
                        return false
                    }
                    continue
                }
                if upperBounds.Any(
                    (upper Type) -> if upper.ContainsGenericParameters {
                        !OpenExtensionReceiverStandardShapeMayApply(lower, upper, tupleElementConversions: false)
                    } else if lowerIndex >= fixedLowerCount && lower.IsValueType {
                        !OpenExtensionReceiverStandardShapeMayApply(lower, upper) && !GetReceiverInferenceCarriers(
                            lower
                        ).Any(
                            (candidate Type) ->
                            IsInferenceBoundPromotion(candidate, lower) &&
                                IsExtensionReceiverBoundPromotion(upper, candidate)
                        )
                    } else {
                        !IsExtensionReceiverBoundPromotion(upper, lower)
                    }
                ) {
                    return false
                }
            }
            let closed = upperBounds.Where((upper Type) -> !upper.ContainsGenericParameters).ToList()
            for constraint in upperBounds {
                if constraint.ContainsGenericParameters && !constraint.IsGenericParameter && !constraint.IsInterface {
                    for upper in closed {
                        if !upper.IsInterface &&
                            !InferCompatibleExtensionReceiverClassBounds(upper, constraint, inferred) {
                            return false
                        }
                    }
                    if constraint.IsGenericType {
                        for lower in lowerBounds {
                            let shapes = GetExtensionReceiverGenericShapes(lower, constraint.GetGenericTypeDefinition())
                            if shapes.Count == 1 &&
                                !InferExactExtensionReceiverTypeArguments(constraint, shapes[0], inferred) {
                                return false
                            }
                        }
                    }
                }
            }
            if !InferenceUpperBoundsMayRefineTogether(
                parameter,
                upperBounds.Where(
                    (upper Type) -> !upper.ContainsGenericParameters || upper.IsInterface || upper.IsArray
                )
                    .ToList(),
                refinements,
                refine
            ) {
                return false
            }
            let exact = closed.FirstOrDefault(
                (upper Type) -> !InferenceBoundMayRefine(upper) || lowerBounds.Any(
                    (lower Type) -> ClrTypeUtilities.AreSame(lower, upper)
                )
            )
            if exact != nil && !InferExactExtensionReceiverTypeArguments(parameter, exact, inferred) {
                return false
            }
            if exact != nil || lowerBounds.Count > 0 {
                let candidates = if exact != nil {
                    List[Type](){exact}
                } else {
                    GetExtensionReceiverDomainCandidates(lowerBounds, upperBounds)
                }
                var supported = false
                for candidate in candidates {
                    var lowerCompatible = true
                    for var i = 0; i < lowerBounds.Count; i++ {
                        let incompatible = if i < fixedLowerCount {
                            !IsExtensionReceiverBoundPromotion(candidate, lowerBounds[i])
                        } else {
                            !OpenExtensionReceiverStandardShapeMayApply(lowerBounds[i], candidate)
                        }
                        if incompatible {
                            lowerCompatible = false
                            break
                        }
                    }
                    if !lowerCompatible || closed.Any(
                        (upper Type) -> !IsExtensionReceiverBoundPromotion(upper, candidate)
                    ) {
                        continue
                    }
                    let candidateArguments = cast[[]Type](arguments.Clone())
                    candidateArguments[index] = candidate
                    if SatisfiesDeclaredConstraints(
                        parameters,
                        NormalizeExtensionReceiverArguments(parameters, candidateArguments),
                        default,
                        out _,
                        out _
                    ) {
                        supported = true
                        break
                    }
                }
                let requiresConstructor = (
                    ExtensionReceiverParameterAttributes(parameters, arguments, index) &
                    GenericParameterAttributes.DefaultConstructorConstraint
                ) != 0
                let nominalClassDomain = closed.Any(
                    (upper Type) -> !upper.IsInterface &&
                        !(upper.IsSealed && InferenceBoundMayRefine(upper)) &&
                        upper.FullName is not("System.Object" or "System.ValueType" or "System.Enum")
                )
                let finitePromotionDomain = (requiresValue || requiresConstructor) && lowerBounds.Any(
                    (lower Type) ->
                    lower.FullName?.StartsWith("System.ValueTuple`", StringComparison.Ordinal) != true &&
                        NullableLifting.GetValueTypeNullableUnderlyingClr(lower) == nil
                )
                if !supported && (exact != nil || nominalClassDomain || finitePromotionDomain) {
                    return false
                }
            }
        }
        let refinedArguments = cast[[]Type](arguments.Clone())
        var refined = false
        for var i = 0; i < parameters.Length; i++ {
            if !ExtensionReceiverParameterIsOpen(parameters, arguments, i) || !inferred.TryGetValue(
                parameters[i],
                out var candidate
            ) ||
                candidate.ContainsGenericParameters {
                continue
            }
            refinedArguments[i] = candidate
            refined = true
        }
        if refined {
            return ExtensionReceiverBoundDomainsMayApply(
                parameters,
                refinedArguments,
                choices,
                receiverTerms,
                refinements
            )
        }
        return true
    }

    private func ExtensionReceiverTupleConstructorMayApply(
        source Type,
        index int32,
        parameters[]Type,
        arguments[]Type,
        upperBounds IReadOnlyList[Type],
        receiverTerms IReadOnlyList[(Type, Type, bool)],
        choices IReadOnlyDictionary[(Type, Type), Type],
        refinements Dictionary[HashSet[(int32, Type, Type, Type, bool)], bool]
    ) bool {
        let definition = source.GetGenericTypeDefinition()
        let slots = definition.GetGenericArguments()
        let sourceArguments = source.GetGenericArguments()
        let parents = ExtensionReceiverConstraintParameterParents(parameters, arguments)
        for term in receiverTerms {
            ConnectExtensionReceiverTermParameters(
                SubstituteExtensionReceiverTerm(term.Item1, parameters, arguments),
                SubstituteExtensionReceiverTerm(term.Item2, parameters, arguments),
                parameters,
                parents
            )
        }
        let root = ExtensionReceiverConstraintRoot(parents, index)
        let component = Enumerable
            .Range(0, parameters.Length)
            .Where((i int32) -> ExtensionReceiverConstraintRoot(parents, i) == root)
            .ToArray()
        // Other components remain symbolic here and are checked by the caller.
        let componentParameters = component.Select((i int32) -> parameters[i]).ToArray()
        for candidate in GetReceiverInferenceCarriers(definition) {
            let equations = Dictionary[Type, Type]()
            for var i = 0; i < parameters.Length; i++ {
                if parameters[i] != arguments[i] {
                    equations[parameters[i]] = arguments[i]
                }
            }
            equations[parameters[index]] = candidate
            try {
                if !CollectExtensionReceiverConstructorEquations(parameters, index, upperBounds, slots, equations) {
                    continue
                }
                for var i = 0; i < slots.Length; i++ {
                    if ResolveExtensionReceiverEquations(slots[i], equations) == slots[i] {
                        equations[slots[i]] = sourceArguments[i]
                    }
                }
                let possible = component.Select((i int32) -> ResolveExtensionReceiverEquations(arguments[i], equations))
                    .ToArray()
                let terms = receiverTerms.Select(
                    (term(Type, Type, bool)) -> (
                        ResolveExtensionReceiverEquations(term.Item1, equations),
                        ResolveExtensionReceiverEquations(term.Item2, equations),
                        term.Item3
                    )
                )
                    .ToList()
                for var i = 0; i < parameters.Length; i++ {
                    for constraint in parameters[i].GetGenericParameterConstraints() {
                        terms.Add(
                            (
                                ResolveExtensionReceiverEquations(parameters[i], equations),
                                ResolveExtensionReceiverEquations(constraint, equations),
                                false
                            )
                        )
                    }
                }
                let projectedChoices = Dictionary[(Type, Type), Type]()
                var consistent = true
                for choice in choices {
                    let key = (
                        ResolveExtensionReceiverEquations(choice.Key.Item1, equations),
                        ResolveExtensionReceiverEquations(choice.Key.Item2, equations)
                    )
                    let selected = ResolveExtensionReceiverEquations(choice.Value, equations)
                    if projectedChoices.TryGetValue(key, out var existing) && existing != selected {
                        consistent = false
                        break
                    }
                    projectedChoices[key] = selected
                }
                if !consistent {
                    continue
                }
                let pinned = Enumerable
                    .Range(0, componentParameters.Length)
                    .Where((i int32) -> componentParameters[i] != possible[i])
                    .ToHashSet()
                if ArgumentDependentBoundsMaySatisfyConstraints(
                    componentParameters,
                    possible,
                    terms,
                    componentParameters.Select((parameter Type) -> parameter.Name).ToHashSet(StringComparer.Ordinal),
                    nil,
                    pinned,
                    projectedChoices,
                    refinements: refinements
                ) {
                    return true
                }
            } catch (ex ArgumentException) {
                continue
            }
        }
        return false
    }

    private func ConnectExtensionReceiverTermParameters(source Type, target Type, parameters[]Type, parents[]int32) {
        if source.ContainsGenericParameters {
            let indices = Enumerable
                .Range(0, parameters.Length)
                .Where(
                (i int32) -> MentionsGenericParameter(source, parameters[i]) ||
                    MentionsGenericParameter(target, parameters[i])
            )
                .ToArray()
            for var i = 1; i < indices.Length; i++ {
                parents[ExtensionReceiverConstraintRoot(parents, indices[i])] =
                ExtensionReceiverConstraintRoot(parents, indices[0])
            }
            return
        }
        if source.HasElementType && target.HasElementType && source.GetElementType() is {} sourceElement &&
            target.GetElementType() is {} targetElement {
            ConnectExtensionReceiverTermParameters(sourceElement, targetElement, parameters, parents)
            return
        }
        if !target.IsGenericType {
            return
        }
        let shapes = GetExtensionReceiverGenericShapes(source, target.GetGenericTypeDefinition())
        if shapes.Count > 1 {
            let indices = Enumerable
                .Range(0, parameters.Length)
                .Where((i int32) -> MentionsGenericParameter(target, parameters[i]))
                .ToArray()
            for var i = 1; i < indices.Length; i++ {
                parents[ExtensionReceiverConstraintRoot(parents, indices[i])] =
                ExtensionReceiverConstraintRoot(parents, indices[0])
            }
        } else if shapes.Count == 1 {
            let sources = shapes[0].GetGenericArguments()
            let targets = target.GetGenericArguments()
            for var i = 0; i < sources.Length; i++ {
                ConnectExtensionReceiverTermParameters(sources[i], targets[i], parameters, parents)
            }
        }
    }

    private func CollectExtensionReceiverConstructorEquations(
        parameters[]Type,
        index int32,
        upperBounds IReadOnlyList[Type],
        slots[]Type,
        equations Dictionary[Type, Type]
    ) bool {
        let constraints = List[(Type, Type)]()
        for parameter in parameters {
            for constraint in parameter.GetGenericParameterConstraints() {
                constraints.Add((parameter, constraint))
            }
        }
        constraints.AddRange(upperBounds.Select((upper Type) -> (parameters[index], upper)))
        let known = HashSet[(Type, Type)](constraints)
        for var pass = 0; pass <= parameters.Length + slots.Length; pass++ {
            let count = equations.Count
            let constraintCount = constraints.Count
            for var i = 0; i < constraints.Count; i++ {
                let source = ResolveExtensionReceiverEquations(constraints[i].Item1, equations)
                let target = ResolveExtensionReceiverEquations(constraints[i].Item2, equations)
                if source.IsGenericParameter {
                    continue
                }
                if target.IsGenericParameter {
                    for constraint in target.GetGenericParameterConstraints() {
                        let term = (source, constraint)
                        if known.Add(term) {
                            constraints.Add(term)
                        }
                    }
                    continue
                }
                if target.IsGenericType {
                    let shapes = GetExtensionReceiverGenericShapes(source, target.GetGenericTypeDefinition())
                    if shapes.Count == 1 {
                        let sources = shapes[0].GetGenericArguments()
                        let targets = target.GetGenericArguments()
                        let positions = target.GetGenericTypeDefinition().GetGenericArguments()
                        for var position = 0; position < sources.Length; position++ {
                            let invariant = sources[position].IsValueType ||
                                targets[position].IsValueType ||
                                (
                                positions[position].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
                            ) ==
                            GenericParameterAttributes.None
                            if invariant &&
                                !UnifyExtensionReceiverConstructorEquation(
                                sources[position],
                                targets[position],
                                slots,
                                equations
                            ) {
                                return false
                            }
                        }
                        continue
                    }
                }
                if !OpenExtensionReceiverStandardShapeMayApply(source, target, tupleElementConversions: false) {
                    return false
                }
            }
            if equations.Count == count && constraints.Count == constraintCount {
                return true
            }
        }
        return true
    }

    private func UnifyExtensionReceiverConstructorEquation(
        source Type,
        target Type,
        slots[]Type,
        equations Dictionary[Type, Type]
    ) bool {
        let source = ResolveExtensionReceiverEquations(source, equations)
        let target = ResolveExtensionReceiverEquations(target, equations)
        if source == target ||
            !source.ContainsGenericParameters &&
            !target.ContainsGenericParameters &&
            ClrTypeUtilities.AreSame(source, target) {
            return true
        }
        if source.IsGenericParameter || target.IsGenericParameter {
            let parameter = if source.IsGenericParameter &&
                (slots.Contains(source) || !target.IsGenericParameter || !slots.Contains(target)) {
                source
            } else {
                target
            }
            let value = if parameter == source {
                target
            } else {
                source
            }
            if MentionsGenericParameter(value, parameter) {
                return false
            }
            equations[parameter] = value
            return true
        }
        if source.HasElementType || target.HasElementType {
            if source.IsArray != target.IsArray ||
                source.IsByRef != target.IsByRef ||
                source.IsPointer != target.IsPointer ||
                source.IsArray &&
                (source.GetArrayRank() != target.GetArrayRank() || source.IsSZArray != target.IsSZArray) {
                return false
            }
            let sourceElement = source.GetElementType()
            let targetElement = target.GetElementType()
            return sourceElement != nil &&
                targetElement != nil &&
                UnifyExtensionReceiverConstructorEquation(sourceElement, targetElement, slots, equations)
        }
        if !source.IsGenericType || !target.IsGenericType || !ClrTypeUtilities.AreSame(
            source.GetGenericTypeDefinition(),
            target.GetGenericTypeDefinition()
        ) {
            return false
        }
        let sources = source.GetGenericArguments()
        let targets = target.GetGenericArguments()
        for var i = 0; i < sources.Length; i++ {
            if !UnifyExtensionReceiverConstructorEquation(sources[i], targets[i], slots, equations) {
                return false
            }
        }
        return true
    }

    private func ResolveExtensionReceiverEquations(type Type, equations IReadOnlyDictionary[Type, Type]) Type {
        if equations.TryGetValue(type, out var replacement) && type != replacement {
            return ResolveExtensionReceiverEquations(replacement, equations)
        }
        if !type.ContainsGenericParameters {
            return type
        }
        if type.HasElementType && type.GetElementType() is {} element {
            let resolved = ResolveExtensionReceiverEquations(element, equations)
            if element != resolved {
                return if type.IsByRef {
                    resolved.MakeByRefType()
                } else if type.IsPointer {
                    resolved.MakePointerType()
                } else if type.IsSZArray {
                    resolved.MakeArrayType()
                } else {
                    resolved.MakeArrayType(type.GetArrayRank())
                }
            }
            return type
        }
        if type.IsGenericType {
            let arguments = type.GetGenericArguments()
            var changed = false
            for var i = 0; i < arguments.Length; i++ {
                let resolved = ResolveExtensionReceiverEquations(arguments[i], equations)
                if arguments[i] != resolved {
                    arguments[i] = resolved
                    changed = true
                }
            }
            if changed {
                return type.GetGenericTypeDefinition().MakeGenericType(arguments)
            }
        }
        return type
    }

    private func NormalizeExtensionReceiverArguments(parameters[]Type, arguments[]Type)[]Type {
        let equations = Dictionary[Type, Type]()
        for var i = 0; i < parameters.Length; i++ {
            if parameters[i] != arguments[i] {
                equations[parameters[i]] = arguments[i]
            }
        }
        if equations.Count == 0 {
            return arguments
        }
        return arguments.Select((argument Type) -> ResolveExtensionReceiverEquations(argument, equations)).ToArray()
    }

    private func ExtensionReceiverParameterIsOpen(parameters[]Type, arguments[]Type, index int32) bool ->
    arguments[index] == parameters[index]

    private func ExtensionReceiverParameterAttributes(
        parameters[]Type,
        arguments[]Type,
        index int32
    ) GenericParameterAttributes {
        var attributes = parameters[index].GenericParameterAttributes
        for var i = 0; i < parameters.Length; i++ {
            if arguments[i] == parameters[index] {
                attributes |= parameters[i].GenericParameterAttributes
            }
        }
        return attributes
    }

    private func InferenceBoundMayHaveCompatibleSubtype(
        bound Type,
        parameter Type,
        parameters[]Type,
        arguments[]Type,
        refinements Dictionary[HashSet[(int32, Type, Type, Type, bool)], bool],
        refine Func[Type, []Type, IReadOnlyList[(Type, Type, bool)], bool]
    ) bool {
        if !InferenceBoundMayRefine(bound) ||
            (
            ExtensionReceiverParameterAttributes(parameters, arguments, Array.IndexOf(parameters, parameter)) &
            GenericParameterAttributes.NotNullableValueTypeConstraint
        ) != 0 {
            return false
        }
        if bound.IsSealed &&
            (
            ExtensionReceiverParameterAttributes(parameters, arguments, Array.IndexOf(parameters, parameter)) &
            GenericParameterAttributes.DefaultConstructorConstraint
        ) != 0 &&
            bound.GetConstructor(Type.EmptyTypes) == nil {
            return false
        }
        for rawConstraint in parameter.GetGenericParameterConstraints() {
            let constraint = SubstituteExtensionReceiverTerm(rawConstraint, parameters, arguments)
            if constraint.ContainsGenericParameters {
                if constraint.IsInterface &&
                    !InferenceUpperBoundsMayRefineTogether(parameter, []Type{bound, constraint}, refinements, refine) {
                    return false
                }
                continue
            }
            if constraint.IsValueType {
                return false
            }
            if !InferenceUpperBoundsMayRefineTogether(parameter, []Type{bound, constraint}, refinements, refine) {
                return false
            }
        }
        return true
    }

    private func ClosedExtensionReceiverConversionMayApply(
        method MethodInfo,
        receiver TypeSymbol,
        typeArguments[]Type
    ) bool {
        var closedMethod MethodInfo
        try {
            closedMethod = method.MakeGenericMethod(typeArguments)
        } catch (ex ArgumentException) {
            // Live reflection enforces constraints while closing; the caller
            // checks those separately, including bounds later arguments can fix.
            return true
        }
        let parameter = closedMethod.GetParameters()[0]
        let parameterType = parameter.ParameterType
        let closedReceiver = if parameterType.IsByRef {
            parameterType.GetElementType() ?? parameterType
        } else {
            parameterType
        }
        return if closedReceiver.ContainsGenericParameters {
            receiver.ClrType is {} source && OpenExtensionReceiverStandardShapeMayApply(source, closedReceiver)
        } else {
            (
                ClassifyImplicit(closedReceiver, receiver.ClrType) != ImplicitConversionKind.None ||
                    Conversion
                    .ClassifyNonStructural(receiver, ClrNullability.GetParameterTypeSymbol(parameter)).IsImplicit
            )
        }
    }

    private func GetReceiverInferenceCarriers(type Type) List[Type] {
        let carriers = List[Type]()
        for var current Type? = type; current != nil; current = current?.BaseType {
            carriers.Add(current)
        }
        carriers.AddRange(ClrTypeUtilities.SafeGetInterfaces(type))
        let contextObject = ResolveObjectInSameContext(type) ?? typeof(object)
        if !carriers.Any((candidate Type) -> ClrTypeUtilities.AreSame(candidate, contextObject)) {
            carriers.Add(contextObject)
        }
        for name in NumericWideningLattice.WideningTargets(type.FullName).OrderBy(
            (name string) -> name,
            StringComparer.Ordinal
        ) {
            let widened = type.Assembly.GetType(name) ?? Type.GetType(name)
            if widened != nil {
                carriers.Add(widened)
            }
        }
        return carriers
    }

    /// Partial method type inference for deferred arrow-lambda arguments
    /// (follow-up to issue #891). When a generic method's lambda
    /// parameter return type is a method type parameter that can only be
    /// inferred from the lambda body (e.g.
    /// `Select<TSource,TResult>(this IEnumerable<TSource>, Func<TSource,TResult>)`),
    /// full inference via (cref:TryInferTypeArguments) fails because
    /// `TResult` has no bound. This routine instead infers only the type
    /// parameters reachable from the supplied (non-lambda) argument types, then
    /// resolves each requested delegate parameter's <em>parameter</em> CLR types
    /// through those bounds. It succeeds for a slot only when every delegate
    /// parameter type is fully closed — the delegate's return type may remain an
    /// un-inferred method type parameter (it is later inferred from the lambda
    /// body, which now has typed parameters to bind against).
    /// @param method The candidate method (open generic definition or a
    /// constructed generic method whose definition is used for inference).
    /// @param argTypes CLR types of the supplied arguments in parameter
    /// order; deferred lambda slots are passed as `null`.
    /// @param lambdaParameterIndices Parameter indices (aligned to
    /// [`argTypes`](paramref)) that correspond to deferred lambdas.
    /// @param expectedArities The expected delegate arity (lambda
    /// parameter count) for each entry of [`lambdaParameterIndices`](paramref).
    /// @param closedLambdaParameterTypes On success, maps each requested
    /// parameter index to the closed CLR parameter types of its delegate.
    /// @returns Whether closed parameter types were determined for every
    /// requested lambda slot.
    func TryInferDeferredLambdaParameterTypes(
        method MethodInfo?,
        argTypes IReadOnlyList[Type?]?,
        lambdaParameterIndices IReadOnlyList[int32]?,
        expectedArities IReadOnlyList[int32]?,
        @NotNullWhen(true) out closedLambdaParameterTypes Dictionary[int32, []Type]?
    ) bool {
        closedLambdaParameterTypes = nil
        if method == nil || argTypes == nil || lambdaParameterIndices == nil || expectedArities == nil {
            return false
        }
        var openMethod MethodInfo
        var parameters[]ParameterInfo
        try {
            openMethod = if method.IsGenericMethodDefinition {
                method
            } else {
                (
                    if method.IsGenericMethod {
                        method.GetGenericMethodDefinition()
                    } else {
                        method
                    }
                )
            }
            if !openMethod.IsGenericMethodDefinition {
                return false
            }
            parameters = openMethod.GetParameters()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
        if parameters.Length < argTypes.Count {
            return false
        }
        let bounds = Dictionary[string, Type](StringComparer.Ordinal)
        for var i = 0; i < argTypes.Count; i++ {
            let arg Type? = argTypes[i]
            if arg == nil {
                continue
            }
            try {
                if !UnifyForInference(parameters[i].ParameterType, arg, bounds) {
                    return false
                }
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                return false
            }
        }
        let result = Dictionary[int32, []Type]()
        for var k = 0; k < lambdaParameterIndices.Count; k++ {
            let paramIndex = lambdaParameterIndices[k]
            if paramIndex < 0 || paramIndex >= parameters.Length {
                return false
            }
            var invoke MethodInfo?
            var invokeParams[]ParameterInfo
            try {
                var delegateType Type? = parameters[paramIndex].ParameterType
                if delegateType == nil {
                    return false
                }
                // Issue #2375: mirror UnifyForInference's #2142 unwrap — a
                // deferred lambda slot whose delegate parameter is
                // `Expression<TDelegate>` (e.g. `HasOne<TRelated>(Expression<Func<TEntity, TRelated>>)`)
                // has no `Invoke` method of its own; unwrap to `TDelegate`
                // first so this closes the lambda's parameter types instead
                // of unconditionally bailing out for every expression-tree
                // deferred lambda parameter.
                if delegateType.IsGenericType && !delegateType.IsGenericTypeDefinition && string.Equals(
                    delegateType.GetGenericTypeDefinition().FullName,
                    "System.Linq.Expressions.Expression`1",
                    StringComparison.Ordinal
                ) {
                    let expressionArgs = delegateType.GetGenericArguments()
                    if expressionArgs.Length != 1 {
                        return false
                    }
                    delegateType = expressionArgs[0]
                }
                invoke = delegateType.GetMethodSafe("Invoke")
                if invoke == nil {
                    return false
                }
                invokeParams = invoke.GetParameters()
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                return false
            }
            if (invokeParams.Length != expectedArities[k]) {
                return false
            }
            let closedParams = [invokeParams.Length]Type
            for var p = 0; p < invokeParams.Length; p++ {
                if !TryCloseInferredType(invokeParams[p].ParameterType, bounds, out var closedParam) ||
                    closedParam == nil {
                    return false
                }
                closedParams[p] = closedParam
            }
            result[paramIndex] = closedParams
        }
        closedLambdaParameterTypes = result
        return true
    }

    /// Issue #4026: the per-position genuineness flags for a call site's
    /// explicit type-argument list, or `null` when there is no
    /// list.
    /// @remarks A type argument is GENUINE when it denotes a type applicability can rank
    /// against for real. A same-compilation class, struct or enum, and an
    /// in-scope type parameter, have no reference-context CLR type: the binder
    /// closes the candidate over an erasure SURROGATE
    /// (`MemberLookup.TryProjectErasedClrType`'s imported base, or
    /// `object`) and re-emits the real symbol into the MethodSpec, so those
    /// positions must keep their erased-slot exemption. The predicate is the one
    /// the ARGUMENT side already uses to decide the same question
    /// (`ExpressionBinder.IsErasedArgumentApplicabilityMismatch`), so a
    /// nested surrogate such as `M[List[Derived]](...)` — whose CLR type is
    /// the erased `List<object>`, not null — is correctly not genuine.
    /// @param typeArgSymbols The explicit type-argument symbols in source order.
    /// @returns The flags, or `null` when no explicit list was written.
    func BuildGenuineExplicitTypeArgFlags(typeArgSymbols ImmutableArray[TypeSymbol]) IReadOnlyList[bool]? {
        if typeArgSymbols.IsDefaultOrEmpty {
            return nil
        }
        let flags = [typeArgSymbols.Length]bool
        for var i = 0; i < typeArgSymbols.Length; i++ {
            let typeArgument TypeSymbol? = typeArgSymbols[i]
            flags[i] = typeArgument != nil && !TypeSymbol.ContainsSameCompilationUserType(typeArgument) &&
                !TypeSymbol.ContainsTypeParameter(typeArgument)
        }
        return flags
    }

    /// Issue #4026 (review): the source-index to parameter-position mapping the
    /// resolver itself uses for named arguments, exposed so the SYMBOLIC
    /// type-argument recovery can reorder its vector the same way
    /// (cref:TryBuildOrderedArgTypesForInference) already reorders the
    /// CLR one.
    /// @remarks Without it the two inferences disagree the moment a call names its
    /// arguments out of order: CLR inference reorders and recovers `T`,
    /// symbolic recovery zips in SOURCE order and pairs
    /// `Marked[T](int marker, Dictionary<string, T> entries)`'s map
    /// with `int`, so no symbolic `T` is recovered and the MethodSpec
    /// closes over the erasure again — the very `StackUnexpected` #4026 is
    /// about, reached through `Marked(entries: entries, marker: 0)`.
    /// Answers `false` when the call has no named argument at
    /// all (nothing to reorder) or when the names do not match this candidate.
    /// @param openMethod The candidate whose parameters the names bind against.
    /// @param argCount The number of source arguments.
    /// @param argumentNames The per-source-index names; null entries are positional.
    /// @param mapping The source-index to parameter-position mapping.
    /// @returns True when a reordering mapping was produced.
    internal func TryBuildNamedArgumentReordering(
        openMethod MethodInfo,
        argCount int32,
        argumentNames IReadOnlyList[string?]?,
        @NotNullWhen(true) out mapping[]?int32
    ) bool -> TryBuildNamedArgumentReordering(openMethod, argCount, argumentNames, isExpanded: false, out mapping)

    /// Builds the source-to-parameter mapping for symbolic inference, retaining
    /// every expanded params argument as a source slot mapped to the params
    /// parameter.
    /// @param openMethod The candidate whose parameters the names bind against.
    /// @param argCount The number of source arguments.
    /// @param argumentNames The per-source-index names; null entries are positional.
    /// @param isExpanded Whether trailing scalar arguments bind to the params element.
    /// @param mapping The source-index to parameter-position mapping.
    /// @returns True when a reordering mapping was produced.
    internal func TryBuildNamedArgumentReordering(
        openMethod MethodInfo?,
        argCount int32,
        argumentNames IReadOnlyList[string?]?,
        isExpanded bool,
        @NotNullWhen(true) out mapping[]?int32
    ) bool {
        mapping = nil
        if openMethod == nil || argumentNames == nil || !HasAnyNamedArgument(argumentNames) {
            return false
        }
        return TryBuildNamedArgumentMapping(
            openMethod.GetParameters(),
            argCount,
            argumentNames,
            isExpanded,
            out mapping
        )
    }

    /// Issue #1833: identifies a generic candidate whose only structural
    /// mismatch is a value-type-erased type argument (a same-compilation user
    /// struct/enum, or a struct-constrained type parameter) that fails to
    /// satisfy an explicit CLR base-class constraint — e.g. a concrete
    /// non-enum struct, or a plain `[T struct]` type parameter, forwarded
    /// to `Enum.TryParse[TEnum]`'s `where TEnum : Enum` bound. This
    /// distinguishes that specific "binds through overload resolution but only
    /// fails CLR verification" hole from every other reason a candidate can be
    /// inapplicable (arity mismatch, wrong argument types, an unconstrained type
    /// parameter, ...), which must keep surfacing the generic "cannot find
    /// function" diagnostic exactly as it did before `#1833`.
    /// @param openMethod The open generic method definition considered as a candidate.
    /// @param typeArgs The CLR type arguments (with user value types erased).
    /// @param typeArgSymbols The recovered symbolic type-argument vector.
    /// @param typeParameterName On success, the violated type parameter's name.
    /// @param typeArgument On success, the offending type-argument symbol.
    /// @param constraintDescription On success, a human-readable description of the violated constraint.
    /// @returns `true` when a base-constraint violation of this specific shape was found.
    internal func TryDescribeValueTypeBaseConstraintViolation(
        openMethod MethodInfo?,
        typeArgs[]?Type,
        typeArgSymbols ImmutableArray[TypeSymbol],
        @NotNullWhen(true) out typeParameterName string?,
        @NotNullWhen(true) out typeArgument TypeSymbol?,
        @NotNullWhen(true) out constraintDescription string?
    ) bool {
        typeParameterName = nil
        typeArgument = nil
        constraintDescription = nil
        if openMethod == nil || typeArgs == nil || typeArgSymbols.IsDefaultOrEmpty {
            return false
        }
        var typeParams[]Type
        try {
            typeParams = openMethod.GetGenericArguments()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
        if typeParams.Length != typeArgs.Length || typeParams.Length != typeArgSymbols.Length {
            return false
        }
        for var i = 0; i < typeParams.Length; i++ {
            let arg Type? = typeArgs[i]
            if arg == nil || arg.IsGenericParameter || !IsValueTypeErasedSymbol(typeArgSymbols[i]) {
                continue
            }
            let param = typeParams[i]
            var typeConstraints[]Type
            try {
                typeConstraints = param.GetGenericParameterConstraints()
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                continue
            }
            for constraint in typeConstraints {
                if constraint == nil ||
                    constraint.IsInterface ||
                    constraint.IsGenericParameter ||
                    constraint.ContainsGenericParameters {
                    continue
                }
                if !ValueTypeErasedSymbolSatisfiesBaseConstraint(typeArgSymbols[i], constraint) {
                    typeParameterName = param.Name
                    typeArgument = typeArgSymbols[i]
                    constraintDescription = constraint.FullName ?? constraint.Name
                    return true
                }
            }
        }
        return false
    }

    /// Issue #4032: the generic TYPE mirror of
    /// (cref:SatisfiesGenericConstraints(MethodInfo, Type[], ImmutableArray{TypeSymbol?})).
    /// @remarks (cref:Type.MakeGenericType(Type[])) validates constraints when
    /// the definition is a live runtime type, and does NOT when it comes from
    /// a (cref:System.Reflection.MetadataLoadContext) — which is where
    /// every `/reference` assembly lives. So a base clause such as
    /// `class Bad : Handler[string]` over
    /// `Handler<TOptions> where TOptions : SchemeOptions` was
    /// closed with no complaint, and the emitted `extends` row threw
    /// `TypeLoadException: GenericArguments[0], 'System.String', …
    /// violates the constraint of type parameter 'TOptions'` at run time.
    /// Same defect, same remedy, one type parameter over.
    /// @param openDefinition The open generic type definition.
    /// @param typeArgs The candidate type arguments in declaration order.
    /// @param typeArgSymbols The symbolic type-argument vector, which lets the checks see through
    /// the `object` erasure of same-compilation user types.
    /// @param failedIndex The position that failed, or `-1`.
    /// @param failedConstraint The type-bound constraint that failed, or `null` when a
    /// special (`class` / `struct` / `new()`) constraint did.
    /// @returns `true` when every constraint is satisfied.
    internal func SatisfiesGenericTypeConstraints(
        openDefinition Type?,
        typeArgs[]?Type,
        typeArgSymbols ImmutableArray[TypeSymbol?],
        out failedIndex int32,
        out failedConstraint Type?
    ) bool {
        failedIndex = -1
        failedConstraint = nil
        if openDefinition == nil || typeArgs == nil {
            return true
        }
        var typeParams[]Type
        try {
            typeParams = openDefinition.GetGenericArguments()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return true
        }
        return SatisfiesDeclaredConstraints(typeParams, typeArgs, typeArgSymbols, out failedIndex, out failedConstraint)
    }

    /// Issue #4037: for an OPEN instantiation of a generic type definition —
    /// one whose type argument at [`index`](paramref) is the enclosing
    /// declaration's OWN type parameter, as in
    /// `class Unforwarded[T] : Handler[T]` — decides whether that type
    /// parameter's constraint set IMPLIES the constraint the definition
    /// declares at that position.
    /// @remarks This is a different question from
    /// (cref:SatisfiesGenericTypeConstraints), which asks "does this
    /// ARGUMENT satisfy the bound" and can only answer for a closed
    /// instantiation. Here there is no argument to test: `T` stands for
    /// every type its own bounds admit, so the instantiation is valid exactly
    /// when `T`'s bounds are at least as strong as the definition's.
    /// Measured against `csc`, which reports `CS0314` for this shape
    /// at a base clause, a field type, a local type, an interface list entry
    /// and a return type alike.
    ///
    /// <b>A DEPENDENT bound is deliberately not asked.</b> When the
    /// definition's constraint at this position mentions another of the
    /// definition's own type parameters (`Coupled<T, U> where U :
    /// IList<T>`), answering it requires substituting the whole
    /// symbolic vector, which is the repair #4031 had to make for a sibling
    /// parameter and is the exact shape a placeholder answer gets wrong. Such
    /// a position reports satisfied, so the rule only ever ADDS rejections it
    /// can prove.
    /// @param openDefinition The open generic type definition.
    /// @param index The type-argument position to ask about.
    /// @param argument The type parameter written at that position.
    /// @param failedConstraint The type-bound constraint that is not forwarded, or
    /// `null` when a special (`class` / `struct` /
    /// `new()`) constraint is not, or when nothing failed.
    /// @param declaredParameterName The definition's own name for the parameter at [`index`](paramref)
    /// (e.g. `TOptions`), when a constraint failed.
    /// @returns `true` when the constraint set is forwarded.
    internal func TypeParameterForwardsDeclaredConstraints(
        openDefinition Type?,
        index int32,
        argument TypeParameterSymbol?,
        out failedConstraint Type?,
        out declaredParameterName string?
    ) bool {
        failedConstraint = nil
        declaredParameterName = nil
        if openDefinition == nil || argument == nil || index < 0 {
            return true
        }
        var declaredParameter Type
        var attrs GenericParameterAttributes
        var typeConstraints[]Type
        var siblings[]Type
        try {
            siblings = openDefinition.GetGenericArguments()
            if index >= siblings.Length {
                return true
            }
            declaredParameter = siblings[index]
            attrs = declaredParameter.GenericParameterAttributes
            typeConstraints = declaredParameter.GetGenericParameterConstraints()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            // A metadata load failure did not disprove the constraint.
            return true
        }
        declaredParameterName = declaredParameter.Name
        let special = attrs & GenericParameterAttributes.SpecialConstraintMask
        if (special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 &&
            !argument.HasValueTypeConstraint &&
            !argument.HasUnmanagedConstraint {
            return false
        }
        if (special & GenericParameterAttributes.ReferenceTypeConstraint) != 0 &&
            !argument.HasReferenceTypeConstraint &&
            !TypeParameterHasClassBound(argument) {
            return false
        }
        if (special & GenericParameterAttributes.DefaultConstructorConstraint) != 0 &&
            (special & GenericParameterAttributes.NotNullableValueTypeConstraint) == 0 &&
            !argument.HasDefaultConstructorConstraint &&
            !argument.HasValueTypeConstraint &&
            !argument.HasUnmanagedConstraint {
            return false
        }
        for constraint in typeConstraints {
            if constraint == nil {
                continue
            }
            var dependent bool
            try {
                // A bound that mentions any type parameter — the definition's
                // own, most commonly — is the #4031 shape. Skip it.
                dependent = constraint.IsGenericParameter || constraint.ContainsGenericParameters
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                continue
            }
            if dependent {
                continue
            }
            if TypeParameterSatisfiesClrBound(argument, constraint) {
                continue
            }
            failedConstraint = constraint
            return false
        }
        return true
    }

    // Issue #4400: classifies an argument against a candidate's resolved CLR
    // parameter. Identical to ClassifyImplicit, except that an untyped
    // `default` is applicable to an `in` (readonly by-ref) slot, as in C# (it is
    // materialized at the pointee and passed through a readonly temp). A
    // `ref`/`out` slot still rejects it, so an `M(int)` / `M(ref int)` overload
    // set keeps selecting `M(int)` for `M(default)`.
    private func ClassifyArgumentAtParameter(
        parameter ParameterInfo,
        target Type,
        source Type?,
        supplementaryInterfaceCheck((Type, Type) -> bool)?
    ) ImplicitConversionKind -> if object.ReferenceEquals(source, DefaultLiteralArgumentType) &&
        target.IsByRef &&
        parameter.IsIn &&
        !parameter.IsOut {
        ImplicitConversionKind.Identity
    } else {
        ClassifyImplicit(target, source, supplementaryInterfaceCheck)
    }

    /// Issue #4037: whether a type parameter's own bounds prove it is a
    /// reference type — either an explicit `class` constraint or a
    /// class-typed bound, both of which imply it in every instantiation.
    /// @param argument The type parameter.
    /// @returns `true` when the parameter is provably a reference type.
    private func TypeParameterHasClassBound(argument TypeParameterSymbol) bool {
        // The depth bound terminates a cycle in a chain of forwarded bounds.
        var current TypeSymbol? = argument.ClassConstraint
        for var depth = 0; current != nil && depth < ForwardedBoundChainLimit; depth++ {
            switch current {
                case nested is TypeParameterSymbol {
                    if nested.HasReferenceTypeConstraint {
                        return true
                    }
                    current = nested.ClassConstraint
                    continue
                }
                case structSymbol is StructSymbol when structSymbol.IsClass == true {
                    return true
                }
                default {
                    return current!!.ClrType is {IsClass: true, IsValueType: false}
                }
            }
        }
        return false
    }

    /// Issue #4037: whether a type parameter's own bounds imply the CLR bound
    /// [`constraint`](paramref) — an interface bound through
    /// (cref:TypeParameterSatisfiesClrInterfaceBound), a base-class
    /// bound through (cref:TypeParameterSatisfiesClrClassBound). Both
    /// walk the class bound of every parameter this one stands for
    /// (issue #4084), which may end in an imported CLR class or a
    /// same-compilation user class.
    /// @remarks Issue #4083: the two halves are separate methods because the generic
    /// METHOD path calls the class half DIRECTLY, without this method's
    /// `object`/`ValueType` early-out — see that method's remarks
    /// for why accepting `System.ValueType` there would be a false accept.
    /// @param argument The type parameter written as the type argument.
    /// @param constraint The CLR bound the definition declares.
    /// @returns `true` when the bound is forwarded.
    private func TypeParameterSatisfiesClrBound(argument TypeParameterSymbol, constraint Type) bool {
        try {
            if constraint.IsSameAs(typeof(object)) || constraint.IsSameAs(typeof(ValueType)) {
                return true
            }
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return true
        }
        return if constraint.IsInterface {
            TypeParameterSatisfiesClrInterfaceBound(argument, constraint)
        } else {
            TypeParameterSatisfiesClrClassBound(argument, constraint)
        }
    }

    /// Issue #4037 / issue #4083: whether a type parameter's own bounds imply
    /// the imported BASE-CLASS bound [`constraint`](paramref), by walking
    /// the class bound of every parameter it stands for.
    /// @remarks Extracted from (cref:TypeParameterSatisfiesClrBound) by
    /// issue #4083 so the generic-METHOD path can call it too. It is the exact
    /// base-class analogue of what #4070 did for the interface half:
    /// `Probes.NeedsScheme[T]()` inside `func callIt[T SchemeOptions]()`
    /// reported `GS0159 Cannot find function` because the candidate was
    /// silently FILTERED out, while `class Fwd[T SchemeOptions] :
    /// SchemeConstrained[T]` bound. `csc` accepts both.
    ///
    /// Called WITHOUT (cref:TypeParameterSatisfiesClrBound)'s
    /// `object`/`ValueType` early-out, which is why it is a separate
    /// method rather than a call to its parent: on the method path a
    /// `System.ValueType` bound is the metadata shadow of
    /// `where T : struct`, and that is settled by the special-constraint
    /// arms before this loop is reached — accepting it here on a
    /// reference-constrained parameter would be a false ACCEPT the CLR then
    /// refuses.
    ///
    /// Issue #4084: the chain is
    /// (cref:Binder.EnumerateForwardedParameterChain), which follows
    /// `TypeParameterBound` as well as a type-parameter-valued
    /// `ClassConstraint`, so `[U SchemeOptions, T U]` forwards
    /// `U`'s bound onto `T`. It terminates on a visited set rather
    /// than a depth limit.
    /// @param argument The type parameter written as the type argument.
    /// @param constraint The imported base-class bound the definition declares.
    /// @returns `true` when the base-class bound is forwarded.
    private func TypeParameterSatisfiesClrClassBound(argument TypeParameterSymbol, constraint Type) bool {
        for parameter in GSharp.Core.CodeAnalysis.Binding.Binder.EnumerateForwardedParameterChain(argument) {
            if ClassBoundReachesImportedType(parameter.ClassConstraint, constraint) {
                return true
            }
            if parameter.ClassConstraint is StructSymbol userClass &&
                UserReferenceTypeErasedSymbolSatisfiesBaseConstraint(userClass, constraint) {
                return true
            }
        }
        return false
    }

    /// Issues #4037/#4083/#4084: whether a NON-parameter class bound has a CLR
    /// representation that is name-assignable to [`constraint`](paramref).
    /// A type-parameter-valued bound answers `false` here — the
    /// caller's chain already visits it in its own right.
    /// @param bound The class bound, if any.
    /// @param constraint The CLR bound the definition declares.
    /// @returns `true` when the bound reaches the constraint.
    private func ClassBoundReachesImportedType(bound TypeSymbol?, constraint Type) bool {
        if bound == nil || bound is TypeParameterSymbol || bound.ClrType is not Type boundClr {
            return false
        }
        try {
            return ClrTypeUtilities.IsAssignableByName(constraint, boundClr)
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return true
        }
    }

    /// Issue #4037 (review) / issue #4070: whether a type parameter's own
    /// bounds imply the imported INTERFACE bound [`constraint`](paramref)
    /// — either directly, through one of its own interface bounds, or through
    /// its class-constraint chain, because a class bound proves every interface
    /// that class implements.
    /// @remarks Extracted from (cref:TypeParameterSatisfiesClrBound) so the
    /// SAME walk answers the question on both paths that ask it. #4070
    /// enumerated them: the generic-TYPE construction path
    /// ((cref:TypeParameterSatisfiesClrBound), #4037's `GS0580`)
    /// walked the class chain; the generic-METHOD path
    /// (`SatisfiesDeclaredConstraints`' #2617 arm, since #750/ADR-0088)
    /// did not, so `Probes.NeedsDisposable[T]()` inside
    /// `func callIt[T DisposableBase]()` reported `GS0159 Cannot find
    /// function` while `class Forwarded[T DisposableBase] :
    /// DisposableConstrained[T]` bound. `csc` accepts both (measured).
    /// The leaf `ErasedSymbolSatisfiesInterfaceConstraint` is deliberately
    /// left byte-identical — its type-parameter arm reads only interface
    /// bounds, and it has other callers that must keep that meaning.
    ///
    /// Issue #4084 CLOSED the dependent-bound gap this once declined:
    /// the walk read only `ClassConstraint`, so
    /// `[TBase DisposableBase, TDerived TBase]` did not forward
    /// `TBase`'s `IDisposable` onto `TDerived` — `GS0159`
    /// at a generic method, `GS0580` at a generic type, two different
    /// wrong answers to one question `csc` answers yes. The chain is now
    /// (cref:Binder.EnumerateForwardedParameterChain), #4067's existing
    /// symbol walk, which follows
    /// (cref:TypeParameterSymbol.TypeParameterBound) as well and
    /// terminates on a visited set rather than a depth limit — so one chain
    /// serves both paths and the base-class sibling
    /// ((cref:TypeParameterSatisfiesClrClassBound)) alike.
    ///
    /// The METHOD-path caller additionally guards on the UNSUBSTITUTED
    /// constraint mentioning no type parameter, which is the same skip the
    /// generic-TYPE path applies (#4031/#4041) — a self-referential bound such
    /// as `where T : IEquatable<T>` cannot be answered on the erased
    /// vector. See that call site for the measurement.
    /// @param argument The type parameter written as the type argument.
    /// @param constraint The imported interface bound the definition declares.
    /// @returns `true` when the interface bound is forwarded.
    private func TypeParameterSatisfiesClrInterfaceBound(argument TypeParameterSymbol, constraint Type) bool {
        // Issue #4084: the chain is every parameter this one PROVABLY stands
        // for — through a dependent bound (`[TBase DisposableBase, TDerived
        // TBase]`) as well as through a type-parameter-valued class
        // constraint. The former was the gap: both askers read only
        // `ClassConstraint`, so `TDerived` did not forward `TBase`'s
        // `IDisposable` and the two paths gave DIFFERENT wrong answers for
        // the same program — `GS0159` at a generic method, `GS0580` at a
        // generic type. `csc` accepts both, because
        // `TDerived : TBase : DisposableBase : IDisposable` holds in every
        // instantiation.
        for parameter in GSharp.Core.CodeAnalysis.Binding.Binder.EnumerateForwardedParameterChain(argument) {
            if ErasedSymbolSatisfiesInterfaceConstraint(parameter, constraint) {
                return true
            }
            // Issue #4037 (review): a CLASS bound implies every interface that
            // class implements — `[T DisposableOptions]` forwards
            // `where T : IDisposable` when `DisposableOptions : IDisposable`,
            // and `csc` accepts exactly that (measured; the first version of
            // this rule reported GS0580 on it, which is a FALSE rejection of
            // valid code). `ErasedSymbolSatisfiesInterfaceConstraint`'s
            // type-parameter arm reads only the interface bounds, so the class
            // bound has to be walked here.
            if ClassBoundReachesImportedType(parameter.ClassConstraint, constraint) {
                return true
            }
            // A same-compilation class bound: its own interface list and
            // imported base chain answer this.
            if parameter.ClassConstraint is StructSymbol userClassBound &&
                ErasedSymbolSatisfiesInterfaceConstraint(userClassBound, constraint) {
                return true
            }
        }
        return false
    }

    private func TryInferMethodGroupArgument(
        delegateType Type,
        argumentIndex int32,
        bounds Dictionary[string, Type],
        methodGroupInference(int32, IReadOnlyList[Type]) -> (Parameters[]Type, Return Type)?
    ) bool {
        if !ClrLoadContext.TryGetDelegateSignature(delegateType, out var delegateParameters, out var delegateReturn) {
            return false
        }
        let closedInputs = [delegateParameters.Length]Type
        for var i = 0; i < delegateParameters.Length; i++ {
            if !TryCloseInferredType(delegateParameters[i], bounds, out var closedInput) || closedInput == nil {
                return false
            }
            closedInputs[i] = closedInput
        }
        let signature = methodGroupInference(argumentIndex, closedInputs) ??
            methodGroupInference(argumentIndex, delegateParameters)
        if !(signature != nil) ||
            signature!!
            .Parameters
            .Length != delegateParameters.Length ||
            signature!!.Return == nil {
            return false
        }
        // Issue #1531: void supplies no output bound for a value-returning
        // delegate. In particular, it cannot become a generic type argument.
        if string.Equals(signature.Return.FullName, "System.Void", StringComparison.Ordinal) && !string.Equals(
            delegateReturn.FullName,
            "System.Void",
            StringComparison.Ordinal
        ) &&
            delegateReturn.ContainsGenericParameters {
            return false
        }
        let inferred = Dictionary[string, Type](bounds, StringComparer.Ordinal)
        // Method-group input types select and validate the candidate; only its
        // return type contributes output-inference bounds.
        for var i = 0; i < closedInputs.Length; i++ {
            if ClassifyImplicit(signature.Parameters[i], closedInputs[i]) == ImplicitConversionKind.None {
                return false
            }
        }
        if !UnifyForInference(delegateReturn, signature.Return, inferred) {
            // Covariant return: the method may return a narrower reference
            // type than the delegate expects.
            if !TryCloseInferredType(delegateReturn, inferred, out var closedReturn) ||
                closedReturn == nil ||
                !IsVariantAssignable(target: closedReturn, source: signature.Return) {
                return false
            }
        }
        bounds.Clear()
        for pair in inferred {
            bounds.Add(pair.Key, pair.Value)
        }
        return true
    }

    private func TryInferSingleCandidateMethodGroupArgument(
        delegateType Type,
        argumentIndex int32,
        bounds Dictionary[string, Type],
        methodGroupInference(int32, IReadOnlyList[Type]) -> (Parameters[]Type, Return Type)?
    ) bool {
        if !ClrLoadContext.TryGetDelegateSignature(delegateType, out var delegateParameters, out var delegateReturn) {
            return false
        }
        let closedInputs = [delegateParameters.Length]Type?
        var hasOpenInput = false
        for var i = 0; i < delegateParameters.Length; i++ {
            if !TryCloseInferredType(delegateParameters[i], bounds, &closedInputs[i]) || closedInputs[i] == nil {
                hasOpenInput = true
            }
        }
        if !hasOpenInput {
            return false
        }
        // Issue #3766: preserve single-candidate input inference only for
        // delegate inputs that could not be fixed from other arguments.
        let signature = methodGroupInference(argumentIndex, delegateParameters)
        if !(signature != nil) ||
            signature!!
            .Parameters
            .Length != delegateParameters.Length ||
            signature!!.Return == nil {
            return false
        }
        let inferred = Dictionary[string, Type](bounds, StringComparer.Ordinal)
        for var i = 0; i < delegateParameters.Length; i++ {
            if closedInputs[i] is {} closedInput {
                if ClassifyImplicit(signature.Parameters[i], closedInput) == ImplicitConversionKind.None {
                    return false
                }
                continue
            }
            if !UnifyForInference(delegateParameters[i], signature.Parameters[i], inferred) {
                return false
            }
        }
        let outputBounds = Dictionary[string, Type](inferred, StringComparer.Ordinal)
        if !TryInferMethodGroupReturn(delegateReturn, signature.Return, outputBounds) {
            return false
        }
        bounds.Clear()
        for pair in outputBounds {
            bounds.Add(pair.Key, pair.Value)
        }
        return true
    }

    private func TryInferMethodGroupReturn(
        delegateReturn Type,
        methodReturn Type,
        inferred Dictionary[string, Type]
    ) bool {
        if string.Equals(methodReturn.FullName, "System.Void", StringComparison.Ordinal) && !string.Equals(
            delegateReturn.FullName,
            "System.Void",
            StringComparison.Ordinal
        ) &&
            delegateReturn.ContainsGenericParameters {
            return false
        }
        if UnifyForInference(delegateReturn, methodReturn, inferred) {
            return true
        }
        return TryCloseInferredType(delegateReturn, inferred, out var closedReturn) &&
            closedReturn != nil &&
            IsVariantAssignable(target: closedReturn, source: methodReturn)
    }

    private func IsSafeArrayInterfaceVariance(target Type, source Type) bool {
        if !source.IsArray || source.GetArrayRank() != 1 ||
            !target.IsInterface ||
            !target.IsGenericType ||
            target.IsGenericTypeDefinition {
            return false
        }
        var definition Type
        var targetArguments[]Type
        try {
            definition = target.GetGenericTypeDefinition()
            targetArguments = target.GetGenericArguments()
        } catch (NotSupportedException) {
            return false
        }
        let parameters = definition.GetGenericArguments()
        if parameters.Length != 1 ||
            targetArguments.Length != 1 ||
            (
            parameters[0].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
        ) != GenericParameterAttributes.Covariant {
            return false
        }
        var sourceArgument Type? = nil
        for implemented in ClrTypeUtilities.SafeGetInterfaces(source) {
            if implemented.IsGenericType && string.Equals(
                implemented.GetGenericTypeDefinition().FullName,
                definition.FullName,
                StringComparison.Ordinal
            ) {
                sourceArgument = implemented.GetGenericArguments()[0]
                break
            }
        }
        if sourceArgument == nil {
            let definitionName = definition.FullName
            if !string.Equals(definitionName, typeof(IEnumerable[_]).FullName, StringComparison.Ordinal) &&
                !string.Equals(definitionName, typeof(IReadOnlyList[_]).FullName, StringComparison.Ordinal) &&
                !string.Equals(definitionName, typeof(IReadOnlyCollection[_]).FullName, StringComparison.Ordinal) {
                return false
            }
            sourceArgument = source.GetElementType()
        }
        if !IsClrVarianceReferenceType(sourceArgument) || !IsClrVarianceReferenceType(targetArguments[0]) {
            return false
        }
        return Conversion.ClassifyNonStructural(
            TypeSymbol.FromClrTypeWithoutNullability(sourceArgument, NullabilityFreeReason.IdentityComparison),
            TypeSymbol.FromClrTypeWithoutNullability(targetArguments[0], NullabilityFreeReason.IdentityComparison)
        ) is {Exists: true, IsImplicit: true}
    }

    /// Issue #3501: declaration-site variance for a general (non-array)
    /// reference source against a constructed generic interface target.
    /// Succeeds when the source (or one of its implemented interfaces) closes
    /// the target's open definition with per-slot variance-compatible
    /// arguments: identity for invariant slots, an implicit reference
    /// conversion source→target for `out` slots, and target→source for `in`
    /// slots — the ECMA-335 II.9.7 rule `ImplementsInterfaceByName` cannot
    /// express because it requires exact closed-argument identity.
    private func IsVariantGenericInterfaceConversion(target Type, source Type) bool {
        // Issue #3501: a VALUE-TYPE source is allowed — struct→variant-interface
        // is C#'s boxing conversion composed with variance
        // (`ImmutableArray<IMethodSymbol>` → `IEnumerable<ISymbol>`); the
        // emitter's struct→interface arm boxes and the boxed reference is
        // runtime-assignment-compatible with the variant interface.
        if source.IsArray || source.IsGenericParameter || !target.IsGenericType || target.IsGenericTypeDefinition {
            return false
        }
        var definition Type
        var targetArguments[]Type
        var parameters[]Type
        try {
            definition = target.GetGenericTypeDefinition()
            targetArguments = target.GetGenericArguments()
            parameters = definition.GetGenericArguments()
        } catch (NotSupportedException) {
            return false
        }
        if parameters.Length != targetArguments.Length {
            return false
        }
        var hasVariantSlot = false
        for parameter in parameters {
            if (
                parameter.GenericParameterAttributes & GenericParameterAttributes.VarianceMask
            ) != GenericParameterAttributes.None {
                hasVariantSlot = true
                break
            }
        }
        if !hasVariantSlot {
            return false
        }
        for candidate in ClrTypeUtilities.EnumerateSelfAndInterfaces(source, false) {
            var candidateDefinition Type
            var candidateArguments[]Type
            try {
                if !candidate.IsGenericType || candidate.IsGenericTypeDefinition {
                    continue
                }
                candidateDefinition = candidate.GetGenericTypeDefinition()
                candidateArguments = candidate.GetGenericArguments()
            } catch (NotSupportedException) {
                continue
            }
            if !ClrTypeUtilities.AreSame(candidateDefinition, definition) ||
                candidateArguments.Length != targetArguments.Length {
                continue
            }
            if AreVarianceCompatibleArguments(parameters, candidateArguments, targetArguments) {
                return true
            }
        }
        return false
    }

    private func AreVarianceCompatibleArguments(parameters[]Type, sourceArguments[]Type, targetArguments[]Type) bool {
        for var i = 0; i < parameters.Length; i++ {
            let sourceArgument = sourceArguments[i]
            let targetArgument = targetArguments[i]
            if ClrTypeUtilities.AreSame(sourceArgument, targetArgument) {
                continue
            }
            let variance = parameters[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
            var compatible bool
            switch variance {
                case GenericParameterAttributes.Covariant {
                    compatible = IsClrVarianceReferenceType(sourceArgument) &&
                        IsClrVarianceReferenceType(targetArgument) &&
                        Conversion
                        .ClassifyNonStructural(
                        TypeSymbol.FromClrTypeWithoutNullability(
                            sourceArgument,
                            NullabilityFreeReason.IdentityComparison
                        ),
                        TypeSymbol.FromClrTypeWithoutNullability(
                            targetArgument,
                            NullabilityFreeReason.IdentityComparison
                        )
                    ) is {Exists: true, IsImplicit: true}
                }
                case GenericParameterAttributes.Contravariant {
                    compatible = IsClrVarianceReferenceType(sourceArgument) &&
                        IsClrVarianceReferenceType(targetArgument) &&
                        Conversion
                        .ClassifyNonStructural(
                        TypeSymbol.FromClrTypeWithoutNullability(
                            targetArgument,
                            NullabilityFreeReason.IdentityComparison
                        ),
                        TypeSymbol.FromClrTypeWithoutNullability(
                            sourceArgument,
                            NullabilityFreeReason.IdentityComparison
                        )
                    ) is {Exists: true, IsImplicit: true}
                }
                default {
                    compatible = false
                }
            }
            if !compatible {
                return false
            }
        }
        return true
    }

    private func IsClrVarianceReferenceType(type Type?) bool {
        if type == nil || type.IsValueType {
            return false
        }
        if !type.IsGenericParameter {
            return true
        }
        if (type.GenericParameterAttributes & GenericParameterAttributes.ReferenceTypeConstraint) != 0 {
            return true
        }
        for constraint in type.GetGenericParameterConstraints() {
            if !constraint.IsInterface && !constraint.IsValueType && !string.Equals(
                constraint.FullName,
                "System.Object",
                StringComparison.Ordinal
            ) {
                return true
            }
        }
        return false
    }

    /// Substitutes inferred method-type-parameter [`bounds`](paramref) into
    /// [`type`](paramref), succeeding only when the result is fully closed
    /// (contains no remaining generic parameters). Used by
    /// (cref:TryInferDeferredLambdaParameterTypes) to close a delegate's
    /// parameter types while leaving an un-inferred return type unresolved.
    private func TryCloseInferredType(
        type Type?,
        bounds IReadOnlyDictionary[string, Type],
        @NotNullWhen(true) out closed Type?
    ) bool {
        closed = nil
        if type == nil {
            return false
        }
        try {
            if type.IsGenericParameter {
                if !bounds.TryGetValue(type.Name, out var bound) ||
                    bound == nil ||
                    bound.IsGenericParameter ||
                    bound.ContainsGenericParameters {
                    return false
                }
                closed = bound
                return true
            }
            if !type.ContainsGenericParameters {
                closed = type
                return true
            }
            if type.IsByRef {
                return TryCloseInferredType(type.GetElementType(), bounds, out closed)
            }
            if type.IsPointer {
                if !TryCloseInferredType(type.GetElementType(), bounds, out var elem) {
                    return false
                }
                closed = elem.MakePointerType()
                return true
            }
            if type.IsArray {
                if !TryCloseInferredType(type.GetElementType(), bounds, out var elem) {
                    return false
                }
                closed = elem.MakeArrayType()
                return true
            }
            if type.IsGenericType {
                let def = type.GetGenericTypeDefinition()
                let args = type.GetGenericArguments()
                let closedArgs = [args.Length]Type
                for var i = 0; i < args.Length; i++ {
                    if !TryCloseInferredType(args[i], bounds, out var closedArg) || closedArg == nil {
                        return false
                    }
                    closedArgs[i] = closedArg
                }
                closed = def.MakeGenericType(closedArgs)
                return true
            }
        } catch (ex Exception) when IsMetadataLoadFailure(ex) ||
            ex is ArgumentException ||
            ex is InvalidOperationException {
            return false
        }
        return false
    }

    /// Determines whether an exception thrown while reflecting over a candidate's
    /// signature is a metadata/assembly load failure (issue #321, generalized in
    /// issue #338). Delegates to the single shared predicate in
    /// (cref:ClrTypeUtilities.IsMetadataLoadFailure(Exception)) so every
    /// CLR member enumeration site classifies load failures identically.
    /// @param ex The exception observed while evaluating a candidate.
    /// @returns Whether the exception represents a tolerable load failure.
    private func IsMetadataLoadFailure(ex Exception) bool -> ClrTypeUtilities.IsMetadataLoadFailure(ex)

    /// Issue #889: determines whether [`source`](paramref) is a delegate
    /// type that returns a value (e.g. `Func<...>`) whose parameter
    /// list matches a void-returning delegate [`target`](paramref) (e.g.
    /// `System.Action` / `Action<...>`). Parameter and return
    /// types are compared by name to remain safe across reflection contexts
    /// (the target may be loaded through a `MetadataLoadContext` while the
    /// literal's natural `Func<...>` is a live-runtime type), and
    /// both signatures are read through (cref:ClrLoadContext.TryGetDelegateSignature)
    /// so a constructed delegate whose `Invoke` is unreachable across
    /// those contexts still decomposes (issue #3681).
    /// @param target The candidate void-returning delegate parameter type.
    /// @param source The argument's natural delegate type.
    /// @returns `true` when the discard conversion applies.
    private func IsValueReturningDelegateToVoidDelegate(target Type, source Type) bool {
        if !ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source) {
            return false
        }
        // Issue #3681: read both signatures through TryGetDelegateSignature
        // rather than reflecting `Invoke` directly. A lambda's natural
        // `Func<...>` is built by closing the live `System.Func`n` over the
        // bound argument types; whenever any of those came from the reference
        // load context (every non-primitive imported type — `MemberInfo`,
        // `Type`, `List<int>`, …) the runtime materialises the closure as a
        // `TypeBuilderInstantiation`, whose `GetMethod("Invoke")` throws
        // `NotSupportedException` and whose `GetMethodSafe` wrapper therefore
        // answers null. This predicate then silently reported "not a discard
        // conversion" and `Assert.All(items, (x T) -> value)` failed overload
        // resolution with GS0159 for exactly those element types, while the
        // same call over `string`/`object`/`int32` (host runtime types)
        // resolved. `TryGetDelegateSignature` already carries the
        // cross-context fallback that decomposes `Func`n`/`Action`n`/any
        // closed generic delegate through its open definition, and the two
        // sibling delegate predicates (#908 covariance, #1150 return
        // widening) already go through it — this one was the outlier.
        if !ClrLoadContext.TryGetDelegateSignature(target, out var targetParams, out var targetReturn) ||
            !ClrLoadContext.TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn) {
            return false
        }
        // Target must return void; source must return a value.
        if !string.Equals(targetReturn!!.FullName, "System.Void", StringComparison.Ordinal) {
            return false
        }
        if string.Equals(sourceReturn!!.FullName, "System.Void", StringComparison.Ordinal) {
            return false
        }
        if targetParams.Length != sourceParams.Length {
            return false
        }
        for var i = 0; i < targetParams.Length; i++ {
            if !ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]) {
                return false
            }
        }
        return true
    }

    /// Issue #908: determines whether [`source`](paramref) is a delegate
    /// type whose parameter signature is identical to delegate
    /// [`target`](paramref) but whose return type is a derived /
    /// implementing reference type of the target's return type — i.e. a
    /// reference-preserving delegate return-type covariance
    /// (`Func<MemoryStream>` → `Func<Stream>`,
    /// `() -> NullLoggerFactory` → `Func<ILoggerFactory>`).
    /// Parameter and return types are compared by name to remain safe across
    /// reflection contexts (the target parameter is typically loaded through a
    /// `MetadataLoadContext` while the literal's natural `Func<...>`
    /// may be a host-runtime constructed type). Only reference conversions are
    /// accepted (no value-type / boxing / numeric conversions), matching C#'s
    /// variance rules.
    /// @param target The candidate delegate parameter type.
    /// @param source The argument's natural delegate type.
    /// @returns `true` when the covariant conversion applies.
    private func IsDelegateReturnCovariant(target Type, source Type) bool {
        if !ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source) {
            return false
        }
        if !ClrLoadContext.TryGetDelegateSignature(target, out var targetParams, out var targetReturn) ||
            !ClrLoadContext.TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn) {
            return false
        }
        if targetReturn == nil || sourceReturn == nil {
            return false
        }
        // Identity return types are handled by the normal delegate identity /
        // assignability paths; covariance only applies when they differ.
        if ClrTypeUtilities.AreSame(targetReturn, sourceReturn) {
            return false
        }
        // Reference-preserving only: both return types must be reference types
        // (no value-type covariance, no boxing).
        if targetReturn.IsValueType || sourceReturn.IsValueType || string.Equals(
            targetReturn.FullName,
            "System.Void",
            StringComparison.Ordinal
        ) ||
            string.Equals(sourceReturn.FullName, "System.Void", StringComparison.Ordinal) {
            return false
        }
        if !ClrLoadContext.Satisfies(sourceReturn, targetReturn) {
            return false
        }
        // Parameter signatures must match exactly (by name, cross-context safe).
        if targetParams.Length != sourceParams.Length {
            return false
        }
        for var i = 0; i < targetParams.Length; i++ {
            if !ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]) {
                return false
            }
        }
        return true
    }

    /// Issue #1150: determines whether [`source`](paramref) is a delegate
    /// type whose parameter signature is identical to delegate
    /// [`target`](paramref) but whose numeric return type implicitly,
    /// losslessly widens to the target's numeric return type per the standard
    /// integer-widening lattice (e.g. `Func<Item,uint32>` →
    /// `Func<Item,int64>`). This mirrors C#'s implicit numeric
    /// conversion of a lambda body to an expected delegate return type, and lets
    /// a `uint32` selector flow into `Enumerable.Sum(Func<T,long>)`.
    /// Parameter and return types are compared by name to remain safe across
    /// reflection contexts (the literal's natural `Func<...>` may be a
    /// host-runtime constructed type closed over MetadataLoadContext arguments).
    /// Only the widening lattice in this file is consulted; narrowing and
    /// signed/unsigned same-width mismatches are rejected.
    /// @param target The candidate delegate parameter type.
    /// @param source The argument's natural delegate type.
    /// @returns `true` when the numeric-widening return conversion applies.
    private func IsDelegateReturnNumericWidening(target Type, source Type) bool {
        if !ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source) {
            return false
        }
        if !ClrLoadContext.TryGetDelegateSignature(target, out var targetParams, out var targetReturn) ||
            !ClrLoadContext.TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn) {
            return false
        }
        if targetReturn == nil || sourceReturn == nil {
            return false
        }
        // Identity return types are handled by the normal delegate identity /
        // assignability paths; numeric widening only applies when they differ.
        if ClrTypeUtilities.AreSame(targetReturn, sourceReturn) {
            return false
        }
        // The source's return type must implicitly widen to the target's return
        // type per the lossless numeric-widening lattice (directional only).
        if !IsNumericWidening(sourceReturn, targetReturn) {
            return false
        }
        // Parameter signatures must match exactly (by name, cross-context safe).
        if targetParams.Length != sourceParams.Length {
            return false
        }
        for var i = 0; i < targetParams.Length; i++ {
            if !ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]) {
                return false
            }
        }
        return true
    }

    /// Issue #932: determines whether [`source`](paramref) and
    /// [`target`](paramref) are two distinct delegate types with an
    /// identical `Invoke` shape — the same parameter types and the same
    /// return type. A `func`/arrow literal's natural delegate type is a
    /// `System.Func<...>` / `System.Action<...>`, but a
    /// CLR API may type the parameter as a structurally identical, differently
    /// named delegate (e.g. `System.Predicate<T>`,
    /// `System.Comparison<T>`). C# lets a lambda target any
    /// compatible delegate type, so G# must treat the literal as applicable to
    /// such a parameter. Parameter and return types are compared by name to
    /// remain safe across reflection contexts (the target parameter is
    /// typically loaded through a `MetadataLoadContext` while the literal's
    /// natural `Func<...>` is a live-runtime constructed type). The
    /// exact-return-type requirement keeps this distinct from
    /// (cref:IsDelegateReturnCovariant) (differing returns) and
    /// (cref:IsValueReturningDelegateToVoidDelegate) (void discard),
    /// which handle the non-identity return shapes.
    /// @param target The candidate delegate parameter type.
    /// @param source The argument's natural delegate type.
    /// @returns `true` when the structural delegate conversion applies.
    private func IsStructurallyCompatibleDelegate(target Type, source Type) bool {
        if !ClrTypeUtilities.IsDelegateType(target) || !ClrTypeUtilities.IsDelegateType(source) {
            return false
        }
        // Same delegate definition is already handled by the identity /
        // assignability paths; this conversion only bridges distinct kinds.
        if ClrTypeUtilities.AreSame(target, source) {
            return false
        }
        if !ClrLoadContext.TryGetDelegateSignature(target, out var targetParams, out var targetReturn) ||
            !ClrLoadContext.TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn) {
            return false
        }
        if targetReturn == nil || sourceReturn == nil || !ClrTypeUtilities.AreSame(targetReturn, sourceReturn) {
            return false
        }
        if targetParams.Length != sourceParams.Length {
            return false
        }
        for var i = 0; i < targetParams.Length; i++ {
            if !ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]) {
                return false
            }
        }
        return true
    }

    /// Issue #2142: determines whether a source delegate (a lambda/arrow
    /// literal's natural `Func<...>`/`Action<...>` type, or
    /// any delegate value) converts to an expression-tree parameter
    /// `System.Linq.Expressions.Expression<TDelegate>`. Mirrors the
    /// symbolic-path helper `MemberLookup.TryGetExpressionTreeDelegateType`:
    /// the target must be a closed `Expression`1` whose single type argument
    /// (`TDelegate`) is a delegate type, and the source must be a delegate
    /// that is <em>compatible</em> with `TDelegate` — identity, a
    /// structural delegate match, or reference/covariant/numeric-widening return
    /// adaptation (the same conversions the resolver already accepts between two
    /// plain delegate types). A genuine signature mismatch (different arity or
    /// incompatible parameter/return types) yields `false` so the
    /// candidate is still dropped, preserving overload-resolution rejection of a
    /// truly non-matching lambda. The `TDelegate` must be fully closed (no
    /// open generic parameters); open candidates are closed by
    /// (cref:EvaluateCandidate) before applicability runs, so this holds at
    /// every real call site.
    /// @param target The candidate parameter type.
    /// @param source The argument's natural delegate type.
    /// @param supplementaryInterfaceCheck Optional user-class interface hook, threaded through the
    /// recursive inner-delegate classification.
    /// @param kind On success, the underlying delegate conversion kind (identity or a delegate adaptation)
    /// so the expression-tree conversion ranks identically to the plain-delegate conversion.
    /// @returns `true` when the lambda-to-expression-tree conversion applies.
    private func TryClassifyLambdaToExpressionTree(
        target Type?,
        source Type?,
        supplementaryInterfaceCheck((Type, Type) -> bool)?,
        out kind ImplicitConversionKind
    ) bool {
        kind = ImplicitConversionKind.None
        if source == nil || !ClrTypeUtilities.IsDelegateType(source) {
            return false
        }
        if target == nil || !target.IsGenericType || target.ContainsGenericParameters {
            return false
        }
        let openDefinition = target.GetGenericTypeDefinition()
        if !string.Equals(openDefinition.FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal) {
            return false
        }
        let typeArguments = target.GetGenericArguments()
        if typeArguments.Length != 1 {
            return false
        }
        let targetDelegate Type? = typeArguments[0]
        if targetDelegate == nil || !ClrTypeUtilities.IsDelegateType(targetDelegate) {
            return false
        }
        // A lambda converts to Expression<TDelegate> when its natural delegate
        // shape is compatible with TDelegate. Accept an exact/adaptable delegate
        // match (identity or one of the delegate adaptations the resolver already
        // recognises between two plain delegates), OR — mirroring C#'s lambda
        // conversion — a signature whose parameter types match and whose body
        // (source return) is implicitly convertible to TDelegate's return type,
        // including value-type→object boxing (e.g. `(e) -> e.Id` [int32] into
        // `Expression<Func<T, object?>>`). A genuine parameter/arity mismatch, or
        // a return that does not convert, yields false so the candidate is still
        // dropped.
        let inner = ClassifyImplicit(targetDelegate, source, supplementaryInterfaceCheck)
        switch inner {
            case ImplicitConversionKind.Identity,
            ImplicitConversionKind.DelegateStructuralMatch,
            ImplicitConversionKind.DelegateReturnCovariance,
            ImplicitConversionKind.DelegateReturnNumericWidening {
                kind = inner
                return true
            }
            default {
                let _ = 0
            }
        }
        if IsLambdaBodyConvertibleToDelegate(targetDelegate, source, supplementaryInterfaceCheck) {
            kind = ImplicitConversionKind.DelegateReturnCovariance
            return true
        }
        return false
    }

    /// Issue #2142: determines whether a source delegate's signature is
    /// compatible with a target delegate under a lambda conversion — the
    /// parameter types are pairwise identical and the source's return type is
    /// implicitly convertible (identity, reference, boxing, numeric widening,
    /// nullable-wrap, or user-defined) to the target's return type. This is the
    /// delegate-return counterpart of a lambda-body conversion and is used only
    /// when unwrapping an `Expression<TDelegate>` target, so a lambda
    /// whose body converts to `TDelegate`'s return (e.g. an `int32`
    /// body boxing into an `object?` return) still binds the expression
    /// tree. A `void` return on either side, a parameter mismatch, or a
    /// non-convertible return yields `false`.
    private func IsLambdaBodyConvertibleToDelegate(
        targetDelegate Type,
        source Type,
        supplementaryInterfaceCheck((Type, Type) -> bool)?
    ) bool {
        if !ClrLoadContext.TryGetDelegateSignature(targetDelegate, out var targetParams, out var targetReturn) ||
            !ClrLoadContext.TryGetDelegateSignature(source, out var sourceParams, out var sourceReturn) ||
            targetReturn == nil ||
            sourceReturn == nil ||
            targetParams.Length != sourceParams.Length {
            return false
        }
        // A void return has no body value to convert; the identity / structural
        // delegate paths already handle exact void-return matches.
        if string.Equals(targetReturn.FullName, "System.Void", StringComparison.Ordinal) || string.Equals(
            sourceReturn.FullName,
            "System.Void",
            StringComparison.Ordinal
        ) {
            return false
        }
        for var i = 0; i < targetParams.Length; i++ {
            if !ClrTypeUtilities.AreSame(targetParams[i], sourceParams[i]) {
                return false
            }
        }
        let returnConversion = ClassifyImplicit(targetReturn, sourceReturn, supplementaryInterfaceCheck)
        return returnConversion != ImplicitConversionKind.None
    }

    private func NormalizeIgnoredTrailingParameterCount(
        candidate MethodBase,
        ignoredTrailingParameterCount int32
    ) int32 {
        let parameterCount = candidate.GetParameters().Length
        return Math.Clamp(ignoredTrailingParameterCount, 0, parameterCount)
    }

    /// Evaluates a single candidate for applicability against the supplied
    /// argument types, appending it to [`applicable`](paramref) when it
    /// applies. Factored out of (cref:Resolve{T})
    /// so the per-candidate work can be guarded against reflection load
    /// failures (issue #321) without disturbing the surrounding control flow.
    private func EvaluateCandidate[T MethodBase](
        rawCandidate T,
        argTypes IReadOnlyList[Type?],
        explicitTypeArgs IReadOnlyList[Type]?,
        projectTypeArgument((Type) -> Type)?,
        applicable List[
            (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
        ],
        interpolatedStringArgs IReadOnlyList[bool]? = nil,
        argumentNames IReadOnlyList[string?]? = nil,
        recoverTypeArgSymbols((MethodInfo, bool) -> ImmutableArray[TypeSymbol?])? = nil,
        supplementaryInterfaceCheck((Type, Type) -> bool)? = nil,
        constantNarrowingArgumentCheck((int32, Type) -> bool)? = nil,
        structuralProjectionArgumentCheck((int32, Type) -> bool)? = nil,
        delegateRefKindArgumentCheck((int32, Type) -> bool?)? = nil,
        methodGroupInference((int32, IReadOnlyList[Type]) -> (Parameters[]Type, Return Type)?)? = nil,
        methodGroupArgumentCheck((int32) -> bool)? = nil,
        deferredInferenceArgs IReadOnlyList[bool]? = nil,
        functionLiteralArgumentCheck((int32) -> bool)? = nil,
        erasedArgumentMismatchCheck((int32, Type) -> bool)? = nil,
        explicitTypeArgIsGenuine IReadOnlyList[bool]? = nil,
        explicitTypeArgumentMismatchCheck((int32, MethodBase) -> bool)? = nil,
        openLiteralArgumentCheck((int32, Type) -> bool)? = nil,
        symbolicArgTypes IReadOnlyList[TypeSymbol]? = nil,
        symbolicArgumentConversionClassifier((int32, Type, ParameterInfo) -> ImplicitConversionKind?)? = nil,
        trailingParameterCountToIgnore((MethodBase) -> int32)? = nil
    ) {
        {
            // Stream F follow-up: when the candidate is an open generic method
            // definition, attempt to infer its type arguments from the supplied
            // arg types. A successful inference yields a closed MethodInfo that
            // then participates in the same applicability + ranking pass as a
            // non-generic candidate. Inference failures or constraint
            // violations drop the candidate silently (matches C# §7.5.2 "if
            // type inference fails, the method is not applicable").
            var candidate = rawCandidate
            let ignoredCount = trailingParameterCountToIgnore?(rawCandidate) ?? 0
            let rawParameters = rawCandidate.GetParameters()
            let ignoredTrailingParameters = Math.Clamp(ignoredCount, 0, rawParameters.Length)
            // Issue #1325: when a candidate must be closed over a
            // same-compilation user value type — erased to a `System.Object`
            // placeholder — live-reflection `MakeGenericMethod` rejects the
            // `object` argument against a `where T : struct` parameter (unlike
            // the MetadataLoadContext overload, which never validates). The
            // fallback below closes the method over a value-type placeholder so
            // a valid closed `MethodInfo` is obtained, and rewrites the closed
            // parameter types back to the `object`-erased shape so applicability
            // still matches the `object`-erased argument types. Emit uses the
            // recovered symbolic type arguments, so the placeholder never leaks
            // into the produced IL.
            var paramTypeRewrite((Type) -> Type)? = nil
            var resolvedTypeArgSymbols = default(ImmutableArray[TypeSymbol?])
            if explicitTypeArgs != nil {
                // Issue #311: explicit type-argument path. Only open generic
                // method definitions of matching arity are applicable; close
                // them with the supplied type arguments verbatim.
                if rawCandidate is MethodInfo gmi && gmi.IsGenericMethodDefinition && gmi.GetGenericArguments()
                    .Length == explicitTypeArgs
                    .Count {
                    var closed MethodInfo?
                    let explicitTypeArgsArray = explicitTypeArgs.ToArray()
                    try {
                        closed = gmi.MakeGenericMethod(explicitTypeArgsArray)
                        if rawParameters.Any(
                            (p ParameterInfo) -> p
                                .ParameterType
                                .ContainsGenericParameters &&
                                ClrTypeUtilities
                                .IsDelegateType(
                                Invariant.Required(
                                    UnwrapArrayElement(p.ParameterType),
                                    "an array parameter has an element type",
                                    expression: "UnwrapArrayElement(p.ParameterType)"
                                )
                            )
                        ) {
                            let recoveredSymbols = recoverTypeArgSymbols?(gmi, false) ??
                                default(ImmutableArray[TypeSymbol?])
                            if TryCloseOverUserReferenceTypePlaceholders(
                                gmi,
                                explicitTypeArgsArray,
                                recoveredSymbols,
                                out var referenceClosed
                            ) {
                                closed = referenceClosed
                            }
                        }
                    } catch (ex ArgumentException) {
                        let recoveredSymbols = recoverTypeArgSymbols?(gmi, false) ??
                            default(ImmutableArray[TypeSymbol?])
                        // Issue #1325: live reflection rejects the `object`
                        // erasure of a user value type against a `struct`
                        // constraint. Retry over a value-type placeholder when
                        // the recovered symbols satisfy the real constraints.
                        if TryCloseOverUserValueTypePlaceholders(
                            gmi,
                            explicitTypeArgsArray,
                            recoveredSymbols,
                            out closed
                        ) {
                            paramTypeRewrite = RewriteUserValueTypePlaceholder
                        } else if !TryCloseOverUserReferenceTypePlaceholders(
                            gmi,
                            explicitTypeArgsArray,
                            recoveredSymbols,
                            out closed
                        ) {
                            RejectConstraintFailureOrThrowCompilerInvariant(
                                gmi,
                                explicitTypeArgsArray,
                                recoveredSymbols,
                                ex
                            )
                            return
                        }
                    }
                    // Issue #750 / ADR-0088: same constraint check as the
                    // inference path. Required because MetadataLoadContext's
                    // MakeGenericMethod does not validate constraints.
                    //
                    // Issue #4016 follow-up (code-exploder gate): constraints
                    // are asked on the `object`-NORMALISED vector. #4016 closes
                    // an explicit type argument over the same erasure the
                    // ARGUMENTS present — a same-compilation class arrives as
                    // its imported base — so applicability compares like with
                    // like. A constraint is a different question, and one type
                    // parameter's surrogate leaks into ANOTHER's constraint
                    // when that constraint mentions it:
                    // `AddScheme[TOptions, THandler]
                    //  where THandler : AuthenticationHandler[TOptions]`
                    // substituted `TOptions` to `AuthenticationSchemeOptions`,
                    // so the constraint read
                    // `AuthenticationHandler<AuthenticationSchemeOptions>`
                    // while the handler's own base chain still erases to
                    // `AuthenticationHandler<object>` — invariant, so the check
                    // failed and the candidate was dropped with GS0159.
                    // Normalising the erased positions back to `object` asks
                    // exactly the question this check asked before #4016, and
                    // leaves the projected vector to do its own job in
                    // `closed`'s parameter types.
                    let constraintTypeArgSymbols = recoverTypeArgSymbols?(closed!!, false) ??
                        default(ImmutableArray[TypeSymbol?])
                    resolvedTypeArgSymbols = constraintTypeArgSymbols
                    if HasSymbolicInferenceConflict(resolvedTypeArgSymbols) {
                        return
                    }
                    if !SatisfiesGenericConstraints(
                        gmi,
                        NormaliseErasedTypeArgsForConstraintCheck(explicitTypeArgsArray, constraintTypeArgSymbols),
                        constraintTypeArgSymbols
                    ) {
                        return
                    }
                    candidate = cast[T](cast[MethodBase](closed!!))
                } else {
                    return
                }
            }
            let inferredMethod MethodInfo? = rawCandidate as MethodInfo
            if explicitTypeArgs == nil && inferredMethod != nil && inferredMethod.IsGenericMethodDefinition {
                let mi = inferredMethod
                // Issue #343: when named arguments are present, the per-source
                // argTypes are not necessarily in parameter order. Build an
                // ordered argTypes for inference by mapping each source index to
                // its target parameter position (positional first, then named by
                // name). Inference is purely on parameter-type vs argument-type
                // unification, so the mapping must already be known before
                // inference; we use this open candidate's parameters to compute it.
                var inferenceArgTypes = argTypes
                if deferredInferenceArgs != nil {
                    let deferred = argTypes.ToArray()
                    for var i = 0; i < deferred.Length && i < deferredInferenceArgs.Count; i++ {
                        if (deferredInferenceArgs[i]) {
                            deferred[i] = nil
                        }
                    }
                    inferenceArgTypes = deferred
                }
                // Issue #3501 A5: a method-group argument contributes only
                // OUTPUT-type inference (C# §12.6.3): its natural function
                // type must not hard-unify the delegate's parameter slots —
                // `paths.Select(Stringify)` with `Stringify(object?)` infers
                // TSource from the receiver (string) and TResult from the
                // group's return given those inputs, with the contravariant
                // parameter satisfied by conversion, not unification. Null
                // the slot so TryInferMethodGroupArgument handles it.
                if methodGroupInference != nil && methodGroupArgumentCheck != nil {
                    var groupCleared[]?Type? = nil
                    for var i = 0; i < inferenceArgTypes.Count; i++ {
                        if inferenceArgTypes[i] != nil && methodGroupArgumentCheck(i) {
                            groupCleared ??= inferenceArgTypes.ToArray()
                            groupCleared!![i] = nil
                        }
                    }
                    if groupCleared != nil {
                        inferenceArgTypes = groupCleared
                    }
                }
                var inferenceMethodGroup = methodGroupInference
                if argumentNames != nil && HasAnyNamedArgument(argumentNames) {
                    if !TryBuildOrderedArgTypesForInference(
                        mi,
                        inferenceArgTypes,
                        argumentNames,
                        out var orderedArgTypes
                    ) {
                        return
                    }
                    inferenceArgTypes = orderedArgTypes
                    if methodGroupInference != nil &&
                        TryBuildNamedArgumentMapping(
                        mi.GetParameters(),
                        argTypes.Count,
                        argumentNames,
                        out var sourceToParameter
                    ) {
                        let parameterToSource = Enumerable.Repeat(-1, mi.GetParameters().Length).ToArray()
                        for var sourceIndex = 0; sourceIndex < sourceToParameter!!.Length; sourceIndex++ {
                            parameterToSource[sourceToParameter!![sourceIndex]] = sourceIndex
                        }
                        let MapNamedMethodGroup = func (parameterIndex int32, delegateParameters IReadOnlyList[Type])(
                            Parameters[]Type,
                            Return Type
                        )? {
                            return if parameterIndex >= 0 &&
                                parameterIndex < parameterToSource.Length &&
                                parameterToSource[parameterIndex] >= 0 {
                                methodGroupInference(parameterToSource[parameterIndex], delegateParameters)
                            } else {
                                nil
                            }
                        }
                        inferenceMethodGroup = MapNamedMethodGroup
                    }
                }
                let symbolicTypeArgs = recoverTypeArgSymbols?(mi, false) ?? default(ImmutableArray[TypeSymbol?])
                if HasSymbolicInferenceConflict(symbolicTypeArgs) {
                    return
                }
                var typeArgs[]?Type = nil
                // CLR inference remains authoritative for ordinary arguments;
                // symbolic-first closure is only needed for withheld arguments.
                let useRecoveredInference = HasDeferredInferenceArgument(deferredInferenceArgs) &&
                    !HasDeferredMethodGroupArgument(argTypes.Count, methodGroupArgumentCheck) &&
                    TryRecoverErasedTypeArguments(mi, symbolicTypeArgs, projectTypeArgument, out typeArgs)
                if !useRecoveredInference &&
                    !TryInferTypeArguments(
                    mi,
                    inferenceArgTypes,
                    out typeArgs,
                    inferenceMethodGroup,
                    ignoredTrailingParameters
                ) &&
                    !TryRecoverErasedTypeArguments(mi, symbolicTypeArgs, projectTypeArgument, out typeArgs) {
                    return
                }
                if typeArgs == nil {
                    return
                }
                // Issue #321: inferred type arguments are live host-runtime types
                // pulled from the bound arguments. Project them onto the same load
                // context that loaded the open method so MakeGenericMethod accepts
                // them; otherwise it throws "was not loaded by the
                // MetadataLoadContext that loaded the generic type or method".
                if projectTypeArgument != nil {
                    for var t = 0; t < typeArgs.Length; t++ {
                        // Issue #2126: a resolution sentinel (the inline `out var`
                        // placeholder — issue #977/#1599/#1601 — or the untyped
                        // `default` literal — issue #1391) was bound to this type
                        // parameter because the corresponding argument's real type
                        // is a same-compilation value type with no reference-context
                        // CLR type (so it is erased to `object` everywhere else).
                        // The sentinel is a GSharp.Core marker with no name in the
                        // reference set: projecting it threw and surfaced as a fatal
                        // GS9998 ICE during emit. Normalise it to its erased `object`
                        // form (projected into the candidate's context) — the same
                        // erasure the argument types already carry — so the generic
                        // candidate closes via the issue #1325 value-type-placeholder
                        // path and emit uses the recovered symbolic type argument.
                        typeArgs[t] = if IsResolutionSentinel(typeArgs[t]) {
                            (projectTypeArgument(typeof(object)) ?? typeof(object))
                        } else {
                            (projectTypeArgument(typeArgs[t]) ?? typeArgs[t])
                        }
                    }
                }
                var closed MethodInfo?
                try {
                    closed = mi.MakeGenericMethod(typeArgs)
                } catch (ex ArgumentException) {
                    let recoveredSymbols = recoverTypeArgSymbols?(mi, false) ?? default(ImmutableArray[TypeSymbol?])
                    if HasSymbolicInferenceConflict(recoveredSymbols) {
                        return
                    }
                    // Issue #1325: live reflection rejects the `object` erasure
                    // of a user value type against a `struct` constraint. Retry
                    // over a value-type placeholder when the recovered symbols
                    // satisfy the real constraints.
                    if TryCloseOverUserValueTypePlaceholders(mi, typeArgs, recoveredSymbols, out closed) {
                        paramTypeRewrite = RewriteUserValueTypePlaceholder
                    } else if !TryCloseOverUserReferenceTypePlaceholders(mi, typeArgs, recoveredSymbols, out closed) {
                        RejectConstraintFailureOrThrowCompilerInvariant(mi, typeArgs, recoveredSymbols, ex)
                        return
                    }
                }
                // Issue #750 / ADR-0088: explicitly validate generic-parameter
                // constraints against the inferred type arguments. The runtime
                // overload of MakeGenericMethod throws on constraint violation,
                // but the MetadataLoadContext overload silently accepts any
                // closure — without this check, a `where T : class` candidate
                // bound with T = Nullable<int> survives applicability and the
                // resolver picks the wrong overload, emitting IL that fails
                // verification at runtime.
                resolvedTypeArgSymbols = recoverTypeArgSymbols?(closed!!, false) ?? default(ImmutableArray[TypeSymbol?])
                if HasSymbolicInferenceConflict(resolvedTypeArgSymbols) {
                    return
                }
                if !SatisfiesGenericConstraints(mi, typeArgs, resolvedTypeArgSymbols) {
                    return
                }
                candidate = cast[T](cast[MethodBase](closed!!))
            }
            // Closing a generic method changes its parameter types, not the raw declaration.
            var parameters = if object.ReferenceEquals(candidate, rawCandidate) {
                rawParameters
            } else {
                candidate.GetParameters()
            }
            if ignoredTrailingParameters > 0 {
                parameters = parameters[.. ^ignoredTrailingParameters]
            }
            // Issue #343: build a per-source-index → parameter-position mapping
            // when named arguments are present. Reject the candidate if any
            // named argument refers to a parameter that does not exist, is
            // already filled by a positional argument, or is named twice. Any
            // parameter slot that ends up unfilled must be optional.
            var mapping[]?int32 = nil
            if argumentNames != nil && HasAnyNamedArgument(argumentNames) {
                if !TryBuildNamedArgumentMapping(parameters, argTypes.Count, argumentNames, out mapping) {
                    return
                }
            } else if argTypes.Count > parameters.Length || !TrailingParametersOptional(parameters, argTypes.Count) {
                // Issue #321: a candidate applies when it has at least as many
                // parameters as arguments and every parameter beyond the supplied
                // arguments is optional (has a compile-time default). Only the
                // supplied arguments participate in applicability and ranking; the
                // omitted trailing optionals are materialized to their defaults by
                // the binder before emit.
                return
            }
            let conversions = [argTypes.Count]ImplicitConversionKind
            let paramTypes = [argTypes.Count]Type
            var ok = true
            for var i = 0; i < argTypes.Count; i++ {
                let paramIndex = if mapping != nil {
                    mapping[i]
                } else {
                    i
                }
                paramTypes[i] = if paramTypeRewrite != nil {
                    paramTypeRewrite(parameters[paramIndex].ParameterType)
                } else {
                    parameters[paramIndex].ParameterType
                }
                if argTypes[i] == nil && methodGroupInference != nil && methodGroupArgumentCheck?(i) == true {
                    if !ClrLoadContext.TryGetDelegateSignature(
                        paramTypes[i],
                        out var delegateParameters,
                        out var delegateReturn
                    ) ||
                        !IsMethodGroupSignatureCompatible(
                        methodGroupInference(i, delegateParameters),
                        delegateParameters,
                        delegateReturn!!
                    ) {
                        ok = false
                        break
                    }
                    conversions[i] = if delegateRefKindArgumentCheck?(i, paramTypes[i]) == false {
                        ImplicitConversionKind.DelegateRefKindMismatch
                    } else {
                        ImplicitConversionKind.Identity
                    }
                    continue
                }
                var conv = ClassifyArgumentAtParameter(
                    parameters[paramIndex],
                    paramTypes[i],
                    argTypes[i],
                    supplementaryInterfaceCheck
                )
                conv = RefineErasedTypeParameterConversion(
                    conv,
                    if symbolicArgTypes != nil && i < symbolicArgTypes.Count {
                        symbolicArgTypes[i]
                    } else {
                        default(TypeSymbol?)
                    },
                    rawCandidate,
                    paramIndex,
                    isExpanded: false,
                    resolvedTypeArgSymbols: resolvedTypeArgSymbols
                )
                if !(
                    conv == ImplicitConversionKind.Identity &&
                        IsErasedGenericParameterSlot(rawCandidate, paramIndex, explicitTypeArgIsGenuine)
                ) &&
                    symbolicArgumentConversionClassifier?(
                    i,
                    paramTypes[i],
                    parameters[paramIndex]
                ) is {} symbolicConversion {
                    conv = symbolicConversion
                }
                // Issue #3989: the CLR comparison just above ranks the ERASED
                // argument, where an element with no CLR identity is
                // indistinguishable from a genuine `object` — so a `List[Pair]`
                // matches a parameter that really is `List<object>` by
                // identity, and the raw `List<Pair>` is then pushed at a slot
                // that cannot hold it (ILVerify StackUnexpected, and a hard
                // failure at run time). This is the SUBTRACTIVE counterpart of
                // `ChannelViewAppliesAtErasedGenericSlot` below: that one adds
                // applicability at a slot whose `object` CAME from erasure,
                // this one removes it at a slot whose `object` did not. Both
                // turn on the same question, so both ask
                // `IsErasedGenericParameterSlot` — an inferred generic slot
                // (`Count[TSource](IEnumerable[TSource])`, `M[T](List[T])`) is
                // exactly what the erasure exists to serve and is never
                // second-guessed here.
                // The callback is ordered BEFORE the slot predicate on purpose:
                // it short-circuits on cheap symbol tests (did this argument
                // have an erasure at all, and does this parameter even carry a
                // nested `object`?), while the slot predicate walks the open
                // declaring type's members by reflection. Reversing them would
                // pay that walk for every argument of every candidate on every
                // constructed generic class — `List[T].Add`, `Dictionary[K,
                // V].TryGetValue` — on the hot path.
                if conv != ImplicitConversionKind.None &&
                    conv != ImplicitConversionKind.UserDefinedImplicit &&
                    erasedArgumentMismatchCheck != nil &&
                    erasedArgumentMismatchCheck(i, paramTypes[i]) &&
                    (
                    !IsErasedGenericParameterSlot(rawCandidate, paramIndex, explicitTypeArgIsGenuine) ||
                        explicitTypeArgumentMismatchCheck?(i, rawCandidate) == true
                ) {
                    ok = false
                    break
                }
                if conv == ImplicitConversionKind.None {
                    // Issue #2640: handler conversion is contextual: only an
                    // actual interpolated-string expression can target an
                    // imported [InterpolatedStringHandler] parameter. Keeping
                    // this beside the FormattableString fallback lets every CLR
                    // Resolve caller share the rule, while a plain string no
                    // longer reaches handler lowering and fails later as a
                    // misleading by-ref argument error.
                    if interpolatedStringArgs != nil &&
                        i < interpolatedStringArgs.Count &&
                        interpolatedStringArgs[i] &&
                        InterpolatedStringHandlerInfo.IsHandlerType(paramTypes[i]) {
                        conv = ImplicitConversionKind.InterpolatedStringHandler
                    } else if interpolatedStringArgs != nil &&
                        i < interpolatedStringArgs.Count &&
                        interpolatedStringArgs[i] &&
                        IsFormattableStringTarget(paramTypes[i]) {
                        conv = ImplicitConversionKind.InterpolatedStringToFormattable
                    } else if constantNarrowingArgumentCheck != nil &&
                        constantNarrowingArgumentCheck(i, paramTypes[i]) {
                        // Issue #1311: a constant integer argument that fits a
                        // narrower / cross-sign integer parameter is implicitly
                        // convertible there (C# §10.2.11), so it must not
                        // disqualify the imported/BCL candidate. Mirrors the
                        // user-method path (OverloadResolver). The binder's
                        // BindClrParameterConversions pass re-materialises the
                        // correctly-typed literal before emit.
                        conv = ImplicitConversionKind.ConstantNarrowing
                    } else if structuralProjectionArgumentCheck != nil &&
                        structuralProjectionArgumentCheck(i, paramTypes[i]) {
                        // Issue #4006: the same question the #3989 gate above
                        // asks, asked again here because this arm can admit a
                        // candidate the CLR comparison had already declined.
                        // The ADR-0148 callback reaches
                        // `StructuralProjectionPlanner.CanProject` DIRECTLY,
                        // behind `Conversion`'s back, and the planner only asks
                        // whether the target can be built from the source's
                        // public member surface — which two constructed
                        // generics over the same definition trivially satisfy
                        // (`List[Derived]` and `List[ImportedBase]` both have a
                        // public parameterless constructor and a settable
                        // `Capacity`). So a `List[Derived]` was admitted with
                        // `StructuralProjection` while
                        // `ConversionClassifier.BindConversion` — whose verdict
                        // is `Conversion.Classify`, which refuses that pair at
                        // the #2735/#3962 identity gate — produced no node at
                        // all, and the raw `List<Derived>` was pushed at an
                        // INVARIANT slot: ILVerify StackUnexpected.
                        // Asking here rather than inside the callback is what
                        // keeps `IsErasedGenericParameterSlot` in the loop: a
                        // `List[Mode]` at a `System.Action[List[Mode]]`'s
                        // `Invoke`, whose parameter erases to `List<int>`, is a
                        // slot that DID come from erasure and must keep
                        // binding.
                        if erasedArgumentMismatchCheck != nil &&
                            erasedArgumentMismatchCheck(i, paramTypes[i]) &&
                            (
                            !IsErasedGenericParameterSlot(rawCandidate, paramIndex, explicitTypeArgIsGenuine) ||
                                explicitTypeArgumentMismatchCheck?(i, rawCandidate) == true
                        ) {
                            ok = false
                            break
                        }
                        conv = ImplicitConversionKind.StructuralProjection
                    } else if openLiteralArgumentCheck?(i, paramTypes[i]) == true &&
                        IsErasedGenericParameterSlot(rawCandidate, paramIndex, explicitTypeArgIsGenuine) {
                        conv = ImplicitConversionKind.StructuralProjection
                    } else if ChannelViewAppliesAtErasedGenericSlot(
                        rawCandidate,
                        paramIndex,
                        paramTypes[i],
                        argTypes[i]
                    ) {
                        conv = ImplicitConversionKind.StructuralProjection
                    } else if functionLiteralArgumentCheck?(i) == true &&
                        argTypes[i] != nil &&
                        IsLambdaBodyConvertibleToDelegate(paramTypes[i], argTypes[i]!!, supplementaryInterfaceCheck) {
                        conv = ImplicitConversionKind.DelegateReturnCovariance
                    } else {
                        ok = false
                        break
                    }
                }
                if conv != ImplicitConversionKind.None && delegateRefKindArgumentCheck?(i, paramTypes[i]) == false {
                    conv = ImplicitConversionKind.DelegateRefKindMismatch
                }
                conversions[i] = conv
            }
            if ok {
                applicable.Add((candidate, conversions, paramTypes, mapping, false))
            }
        }
    }

    /// Issue #4086: an in-scope type parameter is represented by
    /// (cref:object) during CLR overload resolution. Preserve the
    /// identity conversion only when that exact symbol supplied the inferred
    /// method type argument. A genuine (cref:object) parameter or a
    /// second genuine-object inference bound instead uses the real reference
    /// conversion or boxing conversion.
    private func RefineErasedTypeParameterConversion(
        conversion ImplicitConversionKind,
        sourceSymbol TypeSymbol?,
        rawCandidate MethodBase?,
        parameterIndex int32,
        isExpanded bool,
        resolvedTypeArgSymbols ImmutableArray[TypeSymbol?]
    ) ImplicitConversionKind {
        if conversion != ImplicitConversionKind.Identity ||
            sourceSymbol is not TypeParameterSymbol sourceTypeParameter ||
            rawCandidate == nil {
            return conversion
        }
        let openCandidate = if rawCandidate is MethodInfo{IsGenericMethod: true} generic {
            cast[MethodBase](generic.GetGenericMethodDefinition())
        } else {
            rawCandidate
        }
        let parameters = openCandidate.GetParameters()
        if uint32(parameterIndex) >= uint32(parameters.Length) {
            return conversion
        }
        var declaredParameter = parameters[parameterIndex].ParameterType
        if isExpanded &&
            IsParamsArrayParameter(parameters[parameterIndex]) &&
            declaredParameter.GetElementType() is {} elementType {
            declaredParameter = elementType
        }
        declaredParameter = PeelByRef(declaredParameter) ?? declaredParameter
        if declaredParameter != nil &&
            declaredParameter.IsGenericParameter == true &&
            declaredParameter.DeclaringMethod != nil {
            let position = declaredParameter.GenericParameterPosition
            if uint32(position) < uint32(resolvedTypeArgSymbols.Length) &&
                resolvedTypeArgSymbols[position] is {} recovered &&
                DeclarationBinder.TypeSignaturesEquivalent(recovered, sourceTypeParameter) {
                return conversion
            }
            return if sourceTypeParameter.HasReferenceTypeConstraint || sourceTypeParameter.ClassConstraint != nil {
                ImplicitConversionKind.Reference
            } else {
                ImplicitConversionKind.Boxing
            }
        }
        if !IsSystemObject(declaredParameter) {
            return conversion
        }
        return if sourceTypeParameter.HasReferenceTypeConstraint || sourceTypeParameter.ClassConstraint != nil {
            ImplicitConversionKind.Reference
        } else {
            ImplicitConversionKind.Boxing
        }
    }

    private func HasSymbolicInferenceConflict(
        typeArguments ImmutableArray[TypeSymbol?]
    ) bool -> !typeArguments.IsDefaultOrEmpty &&
        typeArguments.Any(MemberLookup.IsSymbolicInferenceConflict)

    private func HasDeferredMethodGroupArgument(argumentCount int32, methodGroupArgumentCheck((int32) -> bool)?) bool {
        if methodGroupArgumentCheck == nil {
            return false
        }
        for var i = 0; i < argumentCount; i++ {
            if methodGroupArgumentCheck(i) {
                return true
            }
        }
        return false
    }

    private func HasDeferredInferenceArgument(deferredInferenceArgs IReadOnlyList[bool]?) bool {
        if deferredInferenceArgs == nil {
            return false
        }
        for var i = 0; i < deferredInferenceArgs.Count; i++ {
            if (deferredInferenceArgs[i]) {
                return true
            }
        }
        return false
    }

    private func IsMethodGroupSignatureCompatible(
        signature(Parameters[]Type, Return Type)?,
        delegateParameters IReadOnlyList[Type],
        delegateReturn Type
    ) bool {
        if !(signature != nil) ||
            signature!!
            .Parameters
            .Length != delegateParameters.Count ||
            signature!!.Return == nil {
            return false
        }
        for var i = 0; i < delegateParameters.Count; i++ {
            if ClassifyImplicit(signature.Parameters[i], delegateParameters[i]) == ImplicitConversionKind.None {
                return false
            }
        }
        let methodVoid = string.Equals(signature.Return.FullName, "System.Void", StringComparison.Ordinal)
        let delegateVoid = string.Equals(delegateReturn?.FullName, "System.Void", StringComparison.Ordinal)
        return if methodVoid || delegateVoid {
            methodVoid && delegateVoid
        } else {
            ClassifyImplicit(delegateReturn, signature.Return) != ImplicitConversionKind.None
        }
    }

    /// Issue #506: evaluates a candidate in <em>expanded</em> form — the trailing
    /// `params T[]` parameter accepts zero or more positional arguments, each
    /// assignable to the element type `T`. Closes open generic candidates
    /// (e.g. `Bar<T>(params T[] items)`) by inferring `T` from
    /// the trailing arguments via the same unification used by
    /// (cref:TryInferTypeArguments). Honours named arguments that bind to
    /// a fixed parameter in its natural source position; later positional
    /// surplus is packed into the synthesised params array. Mirrors the
    /// applicability check in (cref:EvaluateCandidate) but rewrites the
    /// trailing parameter type to the element type for ranking purposes.
    private func EvaluateExpandedParamsCandidate[T MethodBase](
        rawCandidate T,
        argTypes IReadOnlyList[Type?],
        explicitTypeArgs IReadOnlyList[Type]?,
        projectTypeArgument((Type) -> Type)?,
        applicable List[
            (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
        ],
        interpolatedStringArgs IReadOnlyList[bool]? = nil,
        argumentNames IReadOnlyList[string?]? = nil,
        recoverTypeArgSymbols((MethodInfo, bool) -> ImmutableArray[TypeSymbol?])? = nil,
        supplementaryInterfaceCheck((Type, Type) -> bool)? = nil,
        constantNarrowingArgumentCheck((int32, Type) -> bool)? = nil,
        structuralProjectionArgumentCheck((int32, Type) -> bool)? = nil,
        delegateRefKindArgumentCheck((int32, Type) -> bool?)? = nil,
        methodGroupInference((int32, IReadOnlyList[Type]) -> (Parameters[]Type, Return Type)?)? = nil,
        methodGroupArgumentCheck((int32) -> bool)? = nil,
        erasedArgumentMismatchCheck((int32, Type) -> bool)? = nil,
        explicitTypeArgIsGenuine IReadOnlyList[bool]? = nil,
        explicitTypeArgumentMismatchCheck((int32, MethodBase) -> bool)? = nil,
        deferredInferenceArgs IReadOnlyList[bool]? = nil,
        openLiteralArgumentCheck((int32, Type) -> bool)? = nil,
        symbolicArgTypes IReadOnlyList[TypeSymbol]? = nil,
        symbolicArgumentConversionClassifier((int32, Type, ParameterInfo) -> ImplicitConversionKind?)? = nil,
        trailingParameterCountToIgnore((MethodBase) -> int32)? = nil
    ) {
        var candidate = rawCandidate
        var paramTypeRewrite((Type) -> Type)? = nil
        var resolvedTypeArgSymbols = default(ImmutableArray[TypeSymbol?])
        // Issue #506 follow-up: close open generic candidates before applicability
        // classification. Explicit type arguments win; otherwise infer from the
        // supplied positional/named args (trailing positionals beyond the params
        // index unify against T).
        if explicitTypeArgs != nil {
            if rawCandidate is MethodInfo gmi && gmi.IsGenericMethodDefinition && gmi.GetGenericArguments()
                .Length == explicitTypeArgs
                .Count {
                var closed MethodInfo?
                var recoveredSymbols = default(ImmutableArray[TypeSymbol?])
                try {
                    closed = gmi.MakeGenericMethod(explicitTypeArgs.ToArray())
                } catch (ex ArgumentException) {
                    recoveredSymbols = recoverTypeArgSymbols?(gmi, true) ?? default(ImmutableArray[TypeSymbol?])
                    let explicitTypeArgsArray = explicitTypeArgs.ToArray()
                    if TryCloseOverUserValueTypePlaceholders(gmi, explicitTypeArgsArray, recoveredSymbols, out closed) {
                        paramTypeRewrite = RewriteUserValueTypePlaceholder
                    } else if !TryCloseOverUserReferenceTypePlaceholders(
                        gmi,
                        explicitTypeArgsArray,
                        recoveredSymbols,
                        out closed
                    ) {
                        RejectConstraintFailureOrThrowCompilerInvariant(
                            gmi,
                            explicitTypeArgsArray,
                            recoveredSymbols,
                            ex
                        )
                        return
                    }
                }
                resolvedTypeArgSymbols = if recoveredSymbols.IsDefault {
                    recoverTypeArgSymbols?(closed!!, true) ?? default(ImmutableArray[TypeSymbol?])
                } else {
                    recoveredSymbols
                }
                if HasSymbolicInferenceConflict(resolvedTypeArgSymbols) {
                    return
                }
                if !SatisfiesGenericConstraints(gmi, explicitTypeArgs.ToArray(), resolvedTypeArgSymbols) {
                    return
                }
                candidate = cast[T](cast[MethodBase](closed!!))
            } else {
                return
            }
        }
        let inferredMethod MethodInfo? = rawCandidate as MethodInfo
        if explicitTypeArgs == nil && inferredMethod != nil && inferredMethod.IsGenericMethodDefinition {
            let mi = inferredMethod
            let symbolicTypeArgs = recoverTypeArgSymbols?(mi, true) ?? default(ImmutableArray[TypeSymbol?])
            if HasSymbolicInferenceConflict(symbolicTypeArgs) {
                return
            }
            var typeArgs[]?Type = nil
            // CLR inference owns ordinary and method-group evidence. Only
            // withheld non-method-group arguments require symbolic-first closure.
            let useRecoveredInference = HasDeferredInferenceArgument(deferredInferenceArgs) &&
                !HasDeferredMethodGroupArgument(argTypes.Count, methodGroupArgumentCheck) &&
                TryRecoverErasedTypeArguments(mi, symbolicTypeArgs, projectTypeArgument, out typeArgs)
            if !useRecoveredInference &&
                !TryInferTypeArgumentsForExpandedParams(
                mi,
                argTypes,
                argumentNames,
                deferredInferenceArgs,
                methodGroupInference,
                methodGroupArgumentCheck,
                out typeArgs
            ) &&
                !TryRecoverErasedTypeArguments(mi, symbolicTypeArgs, projectTypeArgument, out typeArgs) {
                return
            }
            if typeArgs == nil {
                return
            }
            if projectTypeArgument != nil {
                for var t = 0; t < typeArgs.Length; t++ {
                    // Issue #2126: see the primary projection loop above — a
                    // resolution sentinel must be normalised to its erased
                    // `object` form rather than projected, or it throws a fatal
                    // GS9998 ICE when projected into a MetadataLoadContext.
                    typeArgs[t] = if IsResolutionSentinel(typeArgs[t]) {
                        (projectTypeArgument(typeof(object)) ?? typeof(object))
                    } else {
                        (projectTypeArgument(typeArgs[t]) ?? typeArgs[t])
                    }
                }
            }
            var closed MethodInfo?
            var recoveredSymbols = default(ImmutableArray[TypeSymbol?])
            try {
                closed = mi.MakeGenericMethod(typeArgs)
            } catch (ex ArgumentException) {
                recoveredSymbols = recoverTypeArgSymbols?(mi, true) ?? default(ImmutableArray[TypeSymbol?])
                if HasSymbolicInferenceConflict(recoveredSymbols) {
                    return
                }
                if TryCloseOverUserValueTypePlaceholders(mi, typeArgs, recoveredSymbols, out closed) {
                    paramTypeRewrite = RewriteUserValueTypePlaceholder
                } else if !TryCloseOverUserReferenceTypePlaceholders(mi, typeArgs, recoveredSymbols, out closed) {
                    RejectConstraintFailureOrThrowCompilerInvariant(mi, typeArgs, recoveredSymbols, ex)
                    return
                }
            }
            resolvedTypeArgSymbols = if recoveredSymbols.IsDefault {
                recoverTypeArgSymbols?(closed!!, true) ?? default(ImmutableArray[TypeSymbol?])
            } else {
                recoveredSymbols
            }
            if HasSymbolicInferenceConflict(resolvedTypeArgSymbols) {
                return
            }
            if !SatisfiesGenericConstraints(mi, typeArgs, resolvedTypeArgSymbols) {
                return
            }
            candidate = cast[T](cast[MethodBase](closed!!))
        }
        var parameters = candidate.GetParameters()
        let ignoredTrailingParameters = Math.Clamp(
            trailingParameterCountToIgnore?(candidate) ?? 0,
            0,
            parameters.Length
        )
        if ignoredTrailingParameters > 0 {
            parameters = parameters[.. ^ignoredTrailingParameters]
        }
        if parameters.Length == 0 {
            return
        }
        let paramsIndex = parameters.Length - 1
        if !IsParamsArrayParameter(parameters[paramsIndex]) {
            return
        }
        let elementType Type? = parameters[paramsIndex].ParameterType.GetElementType()
        if elementType == nil {
            return
        }
        let names = argumentNames ?? Array.Empty[string?]()
        let hasNamed = HasAnyNamedArgument(names)
        var mapping = [argTypes.Count]int32
        if hasNamed {
            if !TryBuildNamedArgumentMapping(
                parameters,
                argTypes.Count,
                names,
                isExpanded: true,
                out var namedMapping
            ) {
                return
            }
            mapping = namedMapping
        } else {
            for var i = 0; i < argTypes.Count; i++ {
                mapping[i] = if i < paramsIndex {
                    i
                } else {
                    paramsIndex
                }
            }
        }
        let conversions = [argTypes.Count]ImplicitConversionKind
        let paramTypes = [argTypes.Count]Type
        for var i = 0; i < argTypes.Count; i++ {
            let slot = mapping[i]
            var target Type
            if slot == paramsIndex {
                target = elementType
            } else {
                target = parameters[slot].ParameterType
            }
            target = paramTypeRewrite?(target) ?? target
            paramTypes[i] = target
            if argTypes[i] == nil && methodGroupInference != nil && methodGroupArgumentCheck?(i) == true {
                if !ClrLoadContext.TryGetDelegateSignature(
                    target,
                    out var delegateParameters,
                    out var delegateReturn
                ) ||
                    !IsMethodGroupSignatureCompatible(
                    methodGroupInference(i, delegateParameters),
                    delegateParameters,
                    delegateReturn!!
                ) {
                    return
                }
                conversions[i] = if delegateRefKindArgumentCheck?(i, target) == false {
                    ImplicitConversionKind.DelegateRefKindMismatch
                } else {
                    ImplicitConversionKind.Identity
                }
                continue
            }
            var conv = if slot == paramsIndex {
                ClassifyImplicit(target, argTypes[i], supplementaryInterfaceCheck)
            } else {
                ClassifyArgumentAtParameter(parameters[slot], target, argTypes[i], supplementaryInterfaceCheck)
            }
            if (
                conv == ImplicitConversionKind.None &&
                    interpolatedStringArgs != nil &&
                    i < interpolatedStringArgs.Count &&
                    interpolatedStringArgs[i]
            ) {
                if InterpolatedStringHandlerInfo.IsHandlerType(target) {
                    conv = ImplicitConversionKind.InterpolatedStringHandler
                } else if IsFormattableStringTarget(target) {
                    conv = ImplicitConversionKind.InterpolatedStringToFormattable
                }
            }
            conv = RefineErasedTypeParameterConversion(
                conv,
                if symbolicArgTypes != nil && i < symbolicArgTypes.Count {
                    symbolicArgTypes[i]
                } else {
                    default(TypeSymbol?)
                },
                rawCandidate,
                slot,
                isExpanded: true,
                resolvedTypeArgSymbols: resolvedTypeArgSymbols
            )
            if !(
                conv == ImplicitConversionKind.Identity &&
                    IsErasedGenericParameterSlot(rawCandidate, slot, explicitTypeArgIsGenuine)
            ) &&
                symbolicArgumentConversionClassifier?(i, target, parameters[slot]) is {} symbolicConversion {
                conv = symbolicConversion
            }
            // Issue #3989: the same second opinion the normal-form loop takes.
            // A `params object[]` slot is the common shape here, and it is a
            // genuine `object` element rather than an erased one, so the top-
            // level-`object` narrowing inside the callback keeps it applicable.
            if conv != ImplicitConversionKind.None &&
                conv != ImplicitConversionKind.UserDefinedImplicit &&
                erasedArgumentMismatchCheck != nil &&
                erasedArgumentMismatchCheck(i, target) &&
                !IsErasedGenericParameterSlot(rawCandidate, slot, explicitTypeArgIsGenuine) {
                return
            }
            if conv == ImplicitConversionKind.None {
                if structuralProjectionArgumentCheck != nil && structuralProjectionArgumentCheck(i, target) {
                    // Issue #4006: the same second opinion the normal-form
                    // loop now takes on this arm. The ADR-0148 callback asks
                    // the projection planner directly, which says yes for two
                    // constructed generics over one definition even where
                    // `Conversion` refuses the pair outright and would emit
                    // nothing.
                    if erasedArgumentMismatchCheck != nil &&
                        erasedArgumentMismatchCheck(i, target) &&
                        !IsErasedGenericParameterSlot(rawCandidate, slot, explicitTypeArgIsGenuine) {
                        return
                    }
                    conv = ImplicitConversionKind.StructuralProjection
                } else if openLiteralArgumentCheck?(i, target) == true &&
                    IsErasedGenericParameterSlot(rawCandidate, slot, explicitTypeArgIsGenuine) {
                    conv = ImplicitConversionKind.StructuralProjection
                } else {
                    return
                }
            }
            if conv != ImplicitConversionKind.None && delegateRefKindArgumentCheck?(i, target) == false {
                conv = ImplicitConversionKind.DelegateRefKindMismatch
            }
            conversions[i] = conv
        }
        // When all arguments are purely positional, drop the mapping so the
        // existing ExpandParamsArguments fast path remains the canonical
        // post-resolution lowering (matches the prior signature).
        let storedMapping = if hasNamed {
            mapping
        } else {
            default([]?int32)
        }
        applicable.Add((candidate, conversions, paramTypes, storedMapping, true))
    }

    /// Issue #506 follow-up: infers method type arguments for an open generic
    /// candidate in `params T[]` expanded form. Each fixed leading
    /// parameter unifies against its positional/named argument; trailing
    /// positionals beyond the params index unify against the params element
    /// type. Returns `false` when any type parameter cannot
    /// be bound.
    private func TryInferTypeArgumentsForExpandedParams(
        openMethod MethodInfo,
        argTypes IReadOnlyList[Type?],
        argumentNames IReadOnlyList[string?]?,
        deferredInferenceArgs IReadOnlyList[bool]?,
        methodGroupInference((int32, IReadOnlyList[Type]) -> (Parameters[]Type, Return Type)?)?,
        methodGroupArgumentCheck((int32) -> bool)?,
        @NotNullWhen(true) out typeArgs[]?Type
    ) bool {
        typeArgs = nil
        let parameters = openMethod.GetParameters()
        if parameters.Length == 0 {
            return false
        }
        let paramsIndex = parameters.Length - 1
        if !IsParamsArrayParameter(parameters[paramsIndex]) {
            return false
        }
        let elementType Type? = parameters[paramsIndex].ParameterType.GetElementType()
        if elementType == nil {
            return false
        }
        let names = argumentNames ?? Array.Empty[string?]()
        let hasNamed = HasAnyNamedArgument(names)
        let typeParams = openMethod.GetGenericArguments()
        let bounds = Dictionary[string, Type](StringComparer.Ordinal)
        var mapping[]?int32 = nil
        if hasNamed && !TryBuildNamedArgumentMapping(parameters, argTypes.Count, names, isExpanded: true, out mapping) {
            return false
        }
        let TryGetTargetType = func (argumentIndex int32, @NotNullWhen(true) out targetType Type?) bool {
            let parameterIndex = mapping?[argumentIndex] ??
                (
                if argumentIndex < paramsIndex {
                    argumentIndex
                } else {
                    paramsIndex
                }
            )
            targetType = if parameterIndex == paramsIndex {
                elementType
            } else {
                parameters[parameterIndex].ParameterType
            }
            return true
        }
        for var i = 0; i < argTypes.Count; i++ {
            if argTypes[i] == nil ||
                methodGroupArgumentCheck?(i) == true ||
                (deferredInferenceArgs != nil && i < deferredInferenceArgs.Count && deferredInferenceArgs[i]) {
                continue
            }
            if !TryGetTargetType(i, out var targetType) {
                return false
            }
            if !UnifyForInference(targetType, argTypes[i], bounds) {
                return false
            }
        }
        if methodGroupInference != nil && methodGroupArgumentCheck != nil {
            for var i = 0; i < argTypes.Count; i++ {
                if methodGroupArgumentCheck(i) {
                    if !TryGetTargetType(i, out var targetType) {
                        return false
                    }
                    if !TryInferSingleCandidateMethodGroupArgument(targetType!!, i, bounds, methodGroupInference) {
                        TryInferMethodGroupArgument(targetType!!, i, bounds, methodGroupInference)
                    }
                }
            }
        }
        let result = [typeParams.Length]Type
        for var i = 0; i < typeParams.Length; i++ {
            if !bounds.TryGetValue(typeParams[i].Name, out var bound) {
                return false
            }
            result[i] = bound
        }
        typeArgs = result
        return true
    }

    /// Issue #343: returns `true` when any entry in
    /// [`argumentNames`](paramref) is non-null (i.e. the call site has at
    /// least one named argument).
    private func HasAnyNamedArgument(argumentNames IReadOnlyList[string?]?) bool {
        if argumentNames == nil {
            return false
        }
        for var i = 0; i < argumentNames.Count; i++ {
            if argumentNames[i] != nil {
                return true
            }
        }
        return false
    }

    /// Issue #343: matches positional and named arguments to a candidate's
    /// parameters, producing a per-source-index → parameter-position mapping.
    /// Returns `false` when the candidate is not applicable
    /// (unknown name, duplicate slot, or required slot left unfilled).
    private func TryBuildNamedArgumentMapping(
        parameters[]ParameterInfo,
        argCount int32,
        argumentNames IReadOnlyList[string?],
        @NotNullWhen(true) out mapping[]?int32
    ) bool -> TryBuildNamedArgumentMapping(parameters, argCount, argumentNames, isExpanded: false, out mapping)

    private func TryBuildNamedArgumentMapping(
        parameters[]ParameterInfo,
        argCount int32,
        argumentNames IReadOnlyList[string?],
        isExpanded bool,
        @NotNullWhen(true) out mapping[]?int32
    ) bool {
        mapping = nil
        let paramsIndex = if isExpanded && parameters.Length > 0 && IsParamsArrayParameter(parameters[^1]) {
            parameters.Length - 1
        } else {
            -1
        }
        if argumentNames.Count < argCount || (argCount > parameters.Length && paramsIndex < 0) {
            return false
        }
        let result = [argCount]int32
        let filled = [parameters.Length]bool
        var paramsFilledByName = false
        // Positional arguments bind to their source index. Named arguments bind
        // by parameter name; a later positional is legal only when that natural
        // slot remains unfilled (C# 7.2 named-then-positional rule).
        for var i = 0; i < argCount; i++ {
            let name string? = argumentNames[i]
            let paramIndex = if name == nil {
                (
                    if paramsIndex >= 0 && i >= paramsIndex {
                        paramsIndex
                    } else {
                        i
                    }
                )
            } else {
                FindParameterIndex(parameters, name)
            }
            let repeatedExpandedArgument = paramsIndex >= 0 &&
                paramIndex == paramsIndex &&
                name == nil &&
                i >= paramsIndex &&
                !paramsFilledByName
            if paramIndex < 0 || paramIndex >= parameters.Length || (filled[paramIndex] && !repeatedExpandedArgument) {
                return false
            }
            result[i] = paramIndex
            filled[paramIndex] = true
            paramsFilledByName |= paramIndex == paramsIndex && name != nil
        }
        // Every unfilled parameter must be optional.
        for var i = 0; i < parameters.Length; i++ {
            if !filled[i] && i != paramsIndex && !IsOptionalParameter(parameters[i]) {
                return false
            }
        }
        mapping = result
        return true
    }

    private func ParameterNameMatches(
        parameterName string?,
        argumentName string,
        parameters[]ParameterInfo
    ) bool -> parameterName != nil &&
        OverloadResolver
        .ClrParameterNameMatches(
        parameterName,
        argumentName,
        parameters.Select((parameter ParameterInfo) -> parameter.Name ?? string.Empty)
    )

    /// Issue #343: returns the index of the parameter whose name matches
    /// [`name`](paramref) (ordinal comparison), or -1 when no parameter
    /// has that name.
    private func FindParameterIndex(parameters[]ParameterInfo, name string) int32 {
        for var i = 0; i < parameters.Length; i++ {
            if ParameterNameMatches(parameters[i].Name, name, parameters) {
                return i
            }
        }
        return -1
    }

    /// Issue #343: builds the parameter-order arg-type vector required by
    /// (cref:TryInferTypeArguments) when named arguments are present.
    /// Returns `false` when names cannot be matched to
    /// [`openMethod`](paramref)'s parameters.
    private func TryBuildOrderedArgTypesForInference(
        openMethod MethodInfo,
        argTypes IReadOnlyList[Type?],
        argumentNames IReadOnlyList[string?],
        @NotNullWhen(true) out orderedArgTypes[]?Type?
    ) bool {
        orderedArgTypes = nil
        let parameters = openMethod.GetParameters()
        if !TryBuildNamedArgumentMapping(parameters, argTypes.Count, argumentNames, out var mapping) {
            return false
        }
        // The inference helper only consumes the leading parameters whose count
        // equals argTypes.Count, in parameter order. Reorder argTypes so each
        // source argument's type lands at its target parameter position. Any
        // omitted optional slots in the middle break the leading-prefix
        // invariant; in that case fall back to the per-parameter-position
        // mapping and trim trailing nulls — TryInferTypeArguments expects
        // exactly argTypes.Count leading types.
        let perParam = [parameters.Length]Type?
        let filled = [parameters.Length]bool
        for var i = 0; i < argTypes.Count; i++ {
            perParam[mapping[i]] = argTypes[i]
            filled[mapping[i]] = true
        }
        // Inference only needs types for parameters that have an argument; the
        // helper accepts argTypes shorter than parameters.Length (with the
        // trailing parameters required to be optional). We compress filled
        // parameter positions into a leading prefix while preserving order.
        // When non-contiguous slots are filled (e.g. positional[0] + named at
        // slot 3 with slots 1,2 omitted), inference would have to skip the gaps
        // — but TryInferTypeArguments aligns position-by-position. To handle
        // gaps cleanly, build a contiguous leading-prefix view that uses each
        // filled parameter's type so per-position unification still aligns
        // correctly with the open candidate's parameter list, then close any
        // open type parameters that appeared only in gap positions.
        var leadingCount = 0
        for var i = 0; i < parameters.Length; i++ {
            if (filled[i]) {
                leadingCount = i + 1
            }
        }
        // Pad gap positions with the parameter's declared type so unification
        // is a no-op there (parameter unified against itself adds no new bound).
        let ordered = [leadingCount]Type?
        for var i = 0; i < leadingCount; i++ {
            ordered[i] = if filled[i] {
                perParam[i]
            } else {
                parameters[i].ParameterType
            }
        }
        orderedArgTypes = ordered
        return true
    }

    /// Issue #343: packages a per-source-index → parameter-position mapping
    /// into an (cref:ImmutableArray{Int32}) for the resolution result.
    /// Returns the default array when no named arguments were supplied.
    private func BuildMappingArray(mapping[]?int32, argumentNames IReadOnlyList[string?]?) ImmutableArray[int32] {
        if mapping == nil || !HasAnyNamedArgument(argumentNames) {
            return default(ImmutableArray[int32])
        }
        return ImmutableArray.Create(mapping)
    }

    /// Determines whether every parameter from [`suppliedCount`](paramref)
    /// onward is optional (issue #321). Used to decide whether an overload with
    /// more parameters than supplied arguments can still apply by relying on the
    /// trailing parameters' compile-time default values.
    /// @param parameters The candidate's parameter list.
    /// @param suppliedCount The number of arguments supplied at the call site.
    /// @returns Whether all parameters past the supplied arguments are optional.
    private func TrailingParametersOptional(parameters[]ParameterInfo, suppliedCount int32) bool {
        for var i = suppliedCount; i < parameters.Length; i++ {
            if !IsOptionalParameter(parameters[i]) {
                return false
            }
        }
        return true
    }

    private func IsOptionalParameter(parameter ParameterInfo) bool {
        if parameter.IsOptional || parameter.HasDefaultValue {
            return true
        }
        for attribute in parameter.GetCustomAttributesData() {
            if (
                attribute
                    .AttributeType
                    .FullName is "System.Runtime.CompilerServices.DecimalConstantAttribute" or
                    "System.Runtime.CompilerServices.DateTimeConstantAttribute" or
                    "System.Runtime.InteropServices.OptionalAttribute"
            ) {
                return true
            }
        }
        return false
    }

    /// Applies the C# "better function member" ranking pass to the applicable
    /// candidate set, returning the unique best, an ambiguity, or "none".
    /// Always called with at least two applicable candidates.
    /// @remarks Issue #505 reworked this pass to match C# §7.5.3.2 semantics more
    /// faithfully:
    /// 1. Pairwise <em>domination</em> removes candidates for which some other candidate is strictly
    /// better. A candidate that is not strictly worse than any other survives. (The previous implementation
    /// required strict dominance over <em>every</em> other candidate, which incorrectly rejected
    /// non-generic vs generic ties where neither dominates by pure conversion-kind ranking.)
    /// 2. Among survivors, the standard tie-breakers run in C# order: fewer-parameters (fewer omitted
    /// optionals), more-specific parameter types, then non-generic-over-generic.
    /// Issue #506: the tuple carries an `IsExpanded` flag so the winning
    /// candidate's `params T[]`-expanded form is propagated to the
    /// caller through (cref:Result{T}.IsExpanded).
    private func RankApplicable[T MethodBase](
        applicable List[
            (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
        ],
        argTypes IReadOnlyList[Type?],
        argumentNames IReadOnlyList[string?]?,
        trailingParameterCountToIgnore((MethodBase) -> int32)?
    ) Result[T] {
        let ignoredTrailingParameterCounts = Dictionary[MethodBase, int32]()
        let IgnoredTrailingParameterCount = func (method T) int32 {
            if !ignoredTrailingParameterCounts.TryGetValue(method, out var count) {
                count = NormalizeIgnoredTrailingParameterCount(method, trailingParameterCountToIgnore?(method) ?? 0)
                ignoredTrailingParameterCounts.Add(method, count)
            }
            return count
        }
        // Phase 1 — drop candidates that are strictly dominated by another.
        // C# §7.5.3.2: a candidate c is the best iff no other candidate is
        // strictly better than c. Equivalently, c survives iff for every other
        // candidate `other`, !IsStrictlyBetter(other, c).
        let nonDominated = List[
            (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
        ]()
        for c in applicable {
            var dominated = false
            for other in applicable {
                if object.ReferenceEquals(c.Method, other.Method) {
                    continue
                }
                if IsAtLeastAsGoodAs(other.Conversions, other.ParamTypes, c.Conversions, c.ParamTypes, argTypes) {
                    dominated = true
                    break
                }
            }
            if !dominated {
                nonDominated.Add(c)
            }
        }
        if nonDominated.Count == 1 {
            return Result[T].Single(
                nonDominated[0].Method,
                BuildMappingArray(nonDominated[0].Mapping, argumentNames),
                nonDominated[0].IsExpanded
            )
        }
        var pool = if nonDominated.Count > 0 {
            nonDominated
        } else {
            applicable
        }
        // Phase 2a — issue #327: prefer the candidate that does not rely on
        // omitted optional/default parameters (the smallest parameter count).
        // Matches C# §7.5.3.2's preference for the member with no extra
        // defaulted parameters.
        if pool.Count > 1 {
            var minParamCount = int32.MaxValue
            for candidate in pool {
                let parameterCount = candidate
                    .Method
                    .GetParameters()
                    .Length - IgnoredTrailingParameterCount(candidate.Method)
                minParamCount = Math.Min(minParamCount, parameterCount)
            }
            let fewestParams = List[
                (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
            ]()
            for candidate in pool {
                if candidate
                    .Method
                    .GetParameters()
                    .Length - IgnoredTrailingParameterCount(candidate.Method) == minParamCount {
                    fewestParams.Add(candidate)
                }
            }
            if fewestParams.Count >= 1 && fewestParams.Count < pool.Count {
                pool = fewestParams
            }
            if pool.Count == 1 {
                return Result[T].Single(
                    pool[0].Method,
                    BuildMappingArray(pool[0].Mapping, argumentNames),
                    pool[0].IsExpanded
                )
            }
        }
        // Phase 2b — prefer the candidate whose parameter types are
        // "more specific" (parameter-by-parameter assignability — a less
        // derived type is implicitly assignable from a more derived one).
        if pool.Count > 1 && argTypes.Count > 0 {
            let mostSpecific = List[
                (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
            ]()
            for candidate in pool {
                var atLeastAsSpecific = true
                for other in pool {
                    if !object.ReferenceEquals(candidate.Method, other.Method) &&
                        !IsAtLeastAsSpecific(
                        candidate.Method,
                        other.Method,
                        IgnoredTrailingParameterCount(candidate.Method),
                        IgnoredTrailingParameterCount(other.Method)
                    ) {
                        atLeastAsSpecific = false
                        break
                    }
                }
                if atLeastAsSpecific {
                    mostSpecific.Add(candidate)
                }
            }
            if mostSpecific.Count >= 1 && mostSpecific.Count < pool.Count {
                pool = mostSpecific
            }
            if pool.Count == 1 {
                return Result[T].Single(
                    pool[0].Method,
                    BuildMappingArray(pool[0].Mapping, argumentNames),
                    pool[0].IsExpanded
                )
            }
        }
        // Phase 2c — issue #505: prefer a non-generic candidate over a generic
        // one when the candidates are otherwise tied. Matches C# §7.5.3.2:
        // "If MP is a non-generic method and MQ is a generic method, then MP
        // is better than MQ." Without this tie-break, xUnit-style helpers like
        // `Assert.Equal<T>(T, T)` collide with the non-generic
        // `Assert.Equal(string, string)` overload for two string arguments.
        if pool.Count > 1 {
            let nonGeneric = List[
                (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
            ]()
            for candidate in pool {
                if !IsGenericMethod(candidate.Method) {
                    nonGeneric.Add(candidate)
                }
            }
            if nonGeneric.Count >= 1 && nonGeneric.Count < pool.Count {
                pool = nonGeneric
            }
            if pool.Count == 1 {
                return Result[T].Single(
                    pool[0].Method,
                    BuildMappingArray(pool[0].Mapping, argumentNames),
                    pool[0].IsExpanded
                )
            }
        }
        // Phase 2d — issue #530: when multiple candidates survive with identical
        // parameter types but different declaring types (e.g. Task<T>.GetAwaiter()
        // vs. inherited Task.GetAwaiter()), prefer the most-derived declaring type.
        // This mirrors C#'s "method hiding" rule: a derived-class method hides any
        // base-class method with the same signature.
        if pool.Count > 1 {
            let mostDerived = FilterToMostDerivedDeclaringType(pool)
            if mostDerived.Count >= 1 && mostDerived.Count < pool.Count {
                pool = mostDerived
            }
            if pool.Count == 1 {
                return Result[T].Single(
                    pool[0].Method,
                    BuildMappingArray(pool[0].Mapping, argumentNames),
                    pool[0].IsExpanded
                )
            }
        }
        // Phase 2e — issue #750 / ADR-0088: when two open generic candidates
        // have already been closed and both apply, prefer the one whose
        // generic-parameter constraints are strictly more specific
        // (struct > class > no constraint, per ADR-0088 §2). This is the
        // pure-overload tie-break that lets `Map<T>(T?, …) where T : class`
        // and `Map<T>(T?, …) where T : struct` co-exist on the same name —
        // mirroring C# §11.6.4.6 which uses constraints as the final ranking
        // axis after parameter shape and arity.
        if pool.Count > 1 {
            let mostConstrained = pool.Where(
                (
                    w(Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
                ) -> pool
                    .All(
                    (
                        o(
                            Method T,
                            Conversions[]ImplicitConversionKind,
                            ParamTypes[]Type,
                            Mapping[]?int32,
                            IsExpanded bool
                        )
                    ) -> object.ReferenceEquals(w.Method, o.Method) ||
                        CompareConstraintSpecificity(w.Method, o.Method) >= 0
                )
            )
                .ToList()
            if mostConstrained.Count >= 1 && mostConstrained.Count < pool.Count {
                pool = mostConstrained
            }
            if pool.Count == 1 {
                return Result[T].Single(
                    pool[0].Method,
                    BuildMappingArray(pool[0].Mapping, argumentNames),
                    pool[0].IsExpanded
                )
            }
        }
        // Phase 2f — issue #2172: when an argument is a task-returning lambda
        // (its natural delegate type returns Task/Task<T>), prefer the candidate
        // whose OPEN delegate parameter is shaped Func<Task<TResult>> (binding
        // the whole task to a Task-typed delegate result) over one shaped
        // Func<TResult> (binding the whole task to a bare method type parameter).
        // Both close to the same Func<Task<X>> after inference — e.g.
        // Task.Run<TResult>(Func<TResult>) with TResult = Task<X> versus
        // Task.Run<TResult>(Func<Task<TResult>>) with TResult = X — so neither
        // dominates on conversion kind and the earlier tie-breaks cannot choose.
        // This mirrors C#'s preference for the task-returning delegate overload
        // for an async/task-returning lambda argument. Generalised: it fires for
        // ANY overload set differing by Func<X> vs Func<Task<X>> at a slot whose
        // argument is a task-returning delegate, not just Task.Run.
        if pool.Count > 1 {
            let preferred = PreferTaskShapedDelegateForTaskLambda(pool, argTypes)
            if preferred.Count >= 1 && preferred.Count < pool.Count {
                pool = preferred
            }
            if pool.Count == 1 {
                return Result[T].Single(
                    pool[0].Method,
                    BuildMappingArray(pool[0].Mapping, argumentNames),
                    pool[0].IsExpanded
                )
            }
        }
        // Phase 2g — the full NuGet transitive closure can surface the exact
        // same method more than once: e.g. `MemoryExtensions.AsSpan` reachable
        // via both `System.Memory` and a type-forwarding facade, or
        // `ConfigureAwait`/`WithCancellation`/`GetValueOrDefault` reachable via
        // multiple reference assemblies. Those duplicates are genuinely
        // interchangeable (identical declaring type, name, generic arity, and
        // parameter types), so collapse them to a single representative rather
        // than reporting a spurious ambiguity. Distinct real overloads (e.g.
        // `Ceiling(Decimal)` vs `Ceiling(Double)`) differ in parameter types
        // and are never collapsed.
        if pool.Count > 1 {
            let deduped = List[
                (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
            ](pool.Count)
            for candidate in pool {
                var isDuplicate = false
                for kept in deduped {
                    if AreInterchangeableDuplicates(
                        kept.Method,
                        kept.ParamTypes,
                        candidate.Method,
                        candidate.ParamTypes
                    ) {
                        isDuplicate = true
                        break
                    }
                }
                if !isDuplicate {
                    deduped.Add(candidate)
                }
            }
            if deduped.Count < pool.Count {
                pool = deduped
            }
            if pool.Count == 1 {
                return Result[T].Single(
                    pool[0].Method,
                    BuildMappingArray(pool[0].Mapping, argumentNames),
                    pool[0].IsExpanded
                )
            }
        }
        // If nothing dominated above, report the surviving pool as ambiguous.
        let ambiguous = pool.Select(
            (
                c(Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
            ) -> c.Method
        )
            .ToImmutableArray()
        return Result[T].AmbiguousResult(ambiguous)
    }

    /// Determines whether two applicable candidates are the same logical method
    /// surfaced twice through the reference closure (identical declaring type,
    /// name, generic arity, and resolved parameter types). Such duplicates arise
    /// from type-forwarding facades / duplicated reference assemblies and are
    /// interchangeable, so overload resolution collapses them instead of
    /// reporting a spurious ambiguity. Cross-reflection-context type identity is
    /// compared with (cref:ClrTypeUtilities.AreSame(Type, Type)), which
    /// matches by assembly-agnostic full name.
    private func AreInterchangeableDuplicates(
        a MethodBase?,
        aParamTypes[]?Type,
        b MethodBase?,
        bParamTypes[]?Type
    ) bool {
        if a == nil || b == nil || aParamTypes == nil || bParamTypes == nil {
            return false
        }
        if !string.Equals(a.Name, b.Name, StringComparison.Ordinal) {
            return false
        }
        if !ClrTypeUtilities.AreSame(a.DeclaringType, b.DeclaringType) {
            return false
        }
        if GetGenericArity(a) != GetGenericArity(b) {
            return false
        }
        let aParameters = a.GetParameters()
        let bParameters = b.GetParameters()
        if aParameters.Length != bParameters.Length {
            return false
        }
        for var i = 0; i < aParameters.Length; i++ {
            if !ClrTypeUtilities.AreSame(aParameters[i].ParameterType, bParameters[i].ParameterType) {
                return false
            }
        }
        return true
    }

    /// Returns the generic arity of a method (the number of its generic type
    /// parameters), or `0` for a non-generic method.
    private func GetGenericArity(method MethodBase?) int32 {
        if method == nil || !method.IsGenericMethod {
            return 0
        }
        try {
            return method.GetGenericArguments().Length
        } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
            return 0
        }
    }

    /// Issue #2172: narrows [`pool`](paramref) to prefer, for each argument
    /// slot whose argument is a task-returning delegate (a lambda whose natural
    /// return type is `Task`/`Task<T>`), the candidates whose
    /// OPEN delegate parameter at that slot is shaped `Func<Task<TResult>>`
    /// over those shaped `Func<TResult>`. Only narrows when the pool
    /// genuinely splits into both shapes at such a slot, so non-task-lambda calls
    /// and single-shape overload sets are unaffected. Returns the (possibly
    /// unchanged) surviving list.
    private func PreferTaskShapedDelegateForTaskLambda[T MethodBase](
        pool List[(Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)],
        argTypes IReadOnlyList[Type?]?
    ) List[(Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)] {
        if argTypes == nil || argTypes.Count == 0 {
            return pool
        }
        var current = pool
        for var argIndex = 0; argIndex < argTypes.Count; argIndex++ {
            if current.Count <= 1 {
                break
            }
            // The argument must itself be a task-returning delegate value
            // (an async / task-returning lambda's natural Func<...> type).
            if !IsTaskReturningDelegate(argTypes[argIndex]) {
                continue
            }
            let taskShaped = List[
                (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
            ](current.Count)
            var bareTypeParam = false
            for c in current {
                switch ClassifyOpenDelegateReturnShape(c.Method, c.Mapping, argIndex) {
                    case TaskLambdaDelegateShape.TaskShaped {
                        taskShaped.Add(c)
                    }
                    case TaskLambdaDelegateShape.BareTypeParameter {
                        bareTypeParam = true
                    }
                    default {
                        // Neither shape — keep it eligible so an unrelated
                        // sibling overload is never silently dropped.
                        taskShaped.Add(c)
                    }
                }
            }
            // Only narrow when the split is a genuine Func<Task<X>> vs Func<X>
            // discrimination (at least one of each) — otherwise leave the pool
            // untouched.
            if bareTypeParam && taskShaped.Count >= 1 && taskShaped.Count < current.Count {
                current = taskShaped
            }
        }
        return current
    }

    /// Issue #2172: classifies the OPEN (generic-definition) delegate parameter
    /// bound to argument [`argIndex`](paramref) as either
    /// (cref:TaskLambdaDelegateShape.TaskShaped) (its delegate return type
    /// is `Task`/`Task<...>`, i.e. `Func<Task<TResult>>`),
    /// (cref:TaskLambdaDelegateShape.BareTypeParameter) (its delegate
    /// return type is a bare method type parameter, i.e. `Func<TResult>`),
    /// or (cref:TaskLambdaDelegateShape.Other).
    private func ClassifyOpenDelegateReturnShape[T MethodBase](
        method T,
        mapping[]?int32,
        argIndex int32
    ) TaskLambdaDelegateShape {
        let paramIndex = if mapping != nil && argIndex < mapping.Length {
            mapping[argIndex]
        } else {
            argIndex
        }
        if paramIndex < 0 {
            return TaskLambdaDelegateShape.Other
        }
        var openMethod MethodBase = method
        if method is MethodInfo mi && mi.IsGenericMethod && !mi.IsGenericMethodDefinition {
            try {
                openMethod = mi.GetGenericMethodDefinition()
            } catch (Exception) {
                return TaskLambdaDelegateShape.Other
            }
        }
        var parameters[]ParameterInfo
        try {
            parameters = openMethod.GetParameters()
        } catch (Exception) {
            return TaskLambdaDelegateShape.Other
        }
        if paramIndex >= parameters.Length {
            return TaskLambdaDelegateShape.Other
        }
        let openParamType Type? = parameters[paramIndex].ParameterType
        if openParamType == nil || openParamType.IsByRef {
            return TaskLambdaDelegateShape.Other
        }
        if !ClrLoadContext.TryGetDelegateSignature(openParamType, out _, out var openReturn) || openReturn == nil {
            return TaskLambdaDelegateShape.Other
        }
        if IsTaskType(openReturn) {
            return TaskLambdaDelegateShape.TaskShaped
        }
        if openReturn.IsGenericParameter {
            return TaskLambdaDelegateShape.BareTypeParameter
        }
        return TaskLambdaDelegateShape.Other
    }

    /// Issue #2172: whether [`type`](paramref) is a delegate type whose
    /// return type is `Task`/`Task<T>` (the natural type of an
    /// async / task-returning lambda argument).
    private func IsTaskReturningDelegate(type Type?) bool {
        if type == nil || !ClrTypeUtilities.IsDelegateType(type) {
            return false
        }
        return ClrLoadContext.TryGetDelegateSignature(type, out _, out var returnType) && IsTaskType(returnType)
    }

    /// Issue #2172: whether [`type`](paramref) is `System.Threading.Tasks.Task`
    /// or `Task<T>` (or the `ValueTask` equivalents), compared by
    /// name so it works across reflection contexts and for constructed types
    /// closed over open generic parameters (whose (cref:Type.FullName) is
    /// `null`).
    private func IsTaskType(type Type?) bool {
        if type == nil {
            return false
        }
        if !string.Equals(type.Namespace, "System.Threading.Tasks", StringComparison.Ordinal) {
            return false
        }
        let name = type.Name
        return string.Equals(name, "Task", StringComparison.Ordinal) || string.Equals(
            name,
            "Task`1",
            StringComparison.Ordinal
        ) ||
            string.Equals(name, "ValueTask", StringComparison.Ordinal) || string.Equals(
            name,
            "ValueTask`1",
            StringComparison.Ordinal
        )
    }

    private func IsGenericMethod(method MethodBase) bool -> method is MethodInfo mi && mi.IsGenericMethod

    /// Issue #530: when multiple surviving candidates have the same parameter
    /// types but different declaring types (e.g. `Task<T>.GetAwaiter()`
    /// hiding `Task.GetAwaiter()`), keep only those declared on the
    /// most-derived type. This mirrors C#'s method-hiding semantics: a derived
    /// class method with the same signature as a base class method hides it.
    private func FilterToMostDerivedDeclaringType[T](
        pool List[(Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)]
    ) List[(Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)] {
        let result = List[
            (Method T, Conversions[]ImplicitConversionKind, ParamTypes[]Type, Mapping[]?int32, IsExpanded bool)
        ](pool.Count)
        for candidate in pool {
            let declaringType Type? = (candidate.Method as MethodBase)?.DeclaringType
            if declaringType == nil {
                result.Add(candidate)
                continue
            }
            // Check if any other candidate in the pool is declared on a
            // more-derived type (i.e., a type that inherits from this one).
            var isHidden = false
            for other in pool {
                if object.ReferenceEquals(candidate.Method as MethodBase, other.Method as MethodBase) {
                    continue
                }
                let otherDeclaring Type? = (other.Method as MethodBase)?.DeclaringType
                if otherDeclaring != nil &&
                    otherDeclaring != declaringType &&
                    IsSubclassOf(otherDeclaring, declaringType) {
                    isHidden = true
                    break
                }
            }
            if !isHidden {
                result.Add(candidate)
            }
        }
        return result
    }

    /// Checks whether [`derived`](paramref) is a subclass of
    /// [`baseType`](paramref), using FullName comparison for cross-context
    /// type compatibility (MetadataLoadContext vs. runtime types).
    private func IsSubclassOf(derived Type?, baseType Type?) bool {
        if derived == nil || baseType == nil {
            return false
        }
        let baseFullName = baseType.FullName
        for var current Type? = derived.BaseType; current != nil; current = current!!.BaseType {
            if current == baseType || current.FullName == baseFullName {
                return true
            }
        }
        return false
    }

    private func IsAtLeastAsGoodAs(
        a[]ImplicitConversionKind,
        paramsA[]Type,
        b[]ImplicitConversionKind,
        paramsB[]Type,
        sources IReadOnlyList[Type?]
    ) bool {
        var hasStrictlyBetter = false
        for var i = 0; i < a.Length; i++ {
            // A null source is an argument with no CLR type -- `nil` is the
            // common one. It carries no preference between two candidates, and
            // CompareNumericTargets already returns 0 for it, so the comparison
            // must CONTINUE to the remaining arguments rather than bail out.
            // Returning false here (as a nullable-warning guard once did) made
            // every overload set containing a `nil` argument ambiguous:
            // `Timer(cb, nil, 0, 1000)` stopped preferring .ctor(_, _, int, int)
            // over the Int64/UInt32 overloads and failed to bind at all.
            let cmp = CompareConversions(a[i], paramsA[i], b[i], paramsB[i], sources[i])
            if cmp > 0 {
                return false
            }
            if cmp < 0 {
                hasStrictlyBetter = true
            }
        }
        return hasStrictlyBetter
    }

    private func CompareConversions(
        ka ImplicitConversionKind,
        paramA Type,
        kb ImplicitConversionKind,
        paramB Type,
        source Type?
    ) int32 {
        // Issue #377 sub-item 4: when one candidate offers a Tier-4
        // interpolated-string→FormattableString/IFormattable conversion and
        // the other offers a plain reference upcast to System.Object, prefer
        // the formattable conversion. This matches C# §11.18.1's "more
        // specific target" rule for interpolated-string arguments where
        // string > FormattableString > IFormattable > object. Without this
        // tiebreak the lower-ranked ImplicitConversionKind.Reference (3)
        // would beat InterpolatedStringToFormattable (8) and silently route
        // the interpolation through M(object).
        if ka == ImplicitConversionKind.InterpolatedStringToFormattable &&
            kb == ImplicitConversionKind.Reference &&
            IsSystemObject(paramB) {
            return -1
        }
        if kb == ImplicitConversionKind.InterpolatedStringToFormattable &&
            ka == ImplicitConversionKind.Reference &&
            IsSystemObject(paramA) {
            return 1
        }
        // Issue #3866: a user-defined implicit conversion to a SPECIFIC target
        // beats boxing/reference-converting the same argument to
        // `System.Object`. C# §12.6.4.5 ranks two applicable candidates by
        // "better conversion target", not by the mechanism of the conversion:
        // `EntityHandle` converts implicitly to `object` and `object` does not
        // convert back, so `EntityHandle` is the better target. Without this
        // rule the ordinal comparison below let Boxing (4) beat
        // UserDefinedImplicit (6), so
        // `List[EntityHandle].Add(StandaloneSignatureHandle)` bound to the
        // non-generic `IList.Add(object)` face instead of `Add(T)` via
        // `StandaloneSignatureHandle`'s `op_Implicit` — a silent runtime
        // divergence (`List<T>` throws ArgumentException from
        // `IList.Add`), not a compile error.
        //
        // `System.Object` is the least specific possible target, so this can
        // never demote a genuinely better candidate; unrelated non-object
        // targets keep falling through to the ordinal comparison.
        if ka == ImplicitConversionKind.UserDefinedImplicit &&
            (kb == ImplicitConversionKind.Reference || kb == ImplicitConversionKind.Boxing) &&
            IsSystemObject(paramB) &&
            !IsSystemObject(paramA) {
            return -1
        }
        if kb == ImplicitConversionKind.UserDefinedImplicit &&
            (ka == ImplicitConversionKind.Reference || ka == ImplicitConversionKind.Boxing) &&
            IsSystemObject(paramA) &&
            !IsSystemObject(paramB) {
            return 1
        }
        let nullableNumeric = CompareNullableNumericTargets(paramA, paramB, source)
        if nullableNumeric != 0 {
            return nullableNumeric
        }
        if ka != kb {
            return (int32(ka)).CompareTo(int32(kb))
        }
        // Same conversion kind: tie-break by "better conversion target" for
        // numeric widenings (C# §7.5.3.4). Other kinds fall back to "equal";
        // upstream IsAtLeastAsSpecific then breaks pure reference ties.
        if ka == ImplicitConversionKind.NumericWidening {
            return CompareNumericTargets(paramA, paramB, source)
        }
        // Issue #1311 follow-up: when the SAME constant literal adapts to two
        // candidates via constant-narrowing (e.g. `UIntPtr(16)` matching both
        // `.ctor(UInt32)` and `.ctor(UInt64)`), apply the same "better
        // conversion target" rule so the narrowest applicable integral target
        // wins (UInt32 over UInt64) instead of producing a spurious GS0160.
        // A genuinely non-orderable pair (CompareNumericTargets returns 0)
        // still surfaces as ambiguous.
        if ka == ImplicitConversionKind.ConstantNarrowing {
            return CompareNumericTargets(paramA, paramB, source)
        }
        // Issue #2146: reference "better conversion target" tie-break
        // (C# §7.5.3.4). When both candidates convert the SAME argument by a
        // non-identity implicit reference/boxing conversion to related targets
        // (e.g. Dog->object vs Dog->Animal, or Type->object vs Type->Type?),
        // prefer the MORE DERIVED target instead of tying and relying solely on
        // IsAtLeastAsSpecific: target T1 is better than T2 when an implicit
        // conversion exists from T1 to T2 but not from T2 to T1. Unrelated
        // targets stay tied (0), preserving genuine ambiguity.
        if ka == ImplicitConversionKind.Reference || ka == ImplicitConversionKind.Boxing {
            return CompareReferenceTargets(paramA, paramB)
        }
        if ka == ImplicitConversionKind.UserDefinedImplicit {
            return CompareReferenceTargets(paramA, paramB)
        }
        // Issue #1150: when two candidates both convert a delegate argument by
        // numeric return-type widening, prefer the one whose delegate return is
        // the "better conversion target" for the source's return type — so a
        // uint32 selector prefers Func<T,long> over Func<T,double>/decimal,
        // mirroring C#'s preference of the closest integral target.
        if ka == ImplicitConversionKind.DelegateReturnNumericWidening {
            // A null source has no delegate return type to compare against, so
            // this tiebreak yields no preference -- the same `return 0` the
            // TryGetDelegateSignature failures below already produce.
            if source != nil && ClrLoadContext.TryGetDelegateSignature(paramA, out _, out var retA) &&
                ClrLoadContext.TryGetDelegateSignature(paramB, out _, out var retB) &&
                ClrLoadContext.TryGetDelegateSignature(source, out _, out var retSource) &&
                retA != nil &&
                retB != nil &&
                retSource != nil {
                return CompareNumericTargets(retA, retB, retSource)
            }
            return 0
        }
        // Issue #377 sub-item 4: FormattableString is more specific than
        // IFormattable for an interpolated-string argument.
        if ka == ImplicitConversionKind.InterpolatedStringToFormattable {
            let aIsFs = string.Equals(PeelByRef(paramA)?.FullName, "System.FormattableString", StringComparison.Ordinal)
            let bIsFs = string.Equals(PeelByRef(paramB)?.FullName, "System.FormattableString", StringComparison.Ordinal)
            if aIsFs && !bIsFs {
                return -1
            }
            if bIsFs && !aIsFs {
                return 1
            }
        }
        return 0
    }

    private func IsSystemObject(type Type) bool {
        let peeled Type? = PeelByRef(type)
        return peeled != nil && string.Equals(peeled.FullName, "System.Object", StringComparison.Ordinal)
    }

    private func PeelByRef(type Type) Type? {
        return if type != nil && type.IsByRef == true {
            type.GetElementType()
        } else {
            type
        }
    }

    private func IsAtLeastAsSpecific(
        a MethodBase,
        b MethodBase,
        trailingParametersToIgnoreFromA int32,
        trailingParametersToIgnoreFromB int32
    ) bool {
        var a = a
        var b = b
        // Compare generic definitions rather than their inferred closed forms.
        // Closing can erase the distinction that makes one overload more
        // specific, e.g. Enumerable.Min<T>(..., Func<T, int>) versus
        // Min<T, TResult>(..., Func<T, TResult>) after TResult infers as int.
        if a is MethodInfo{IsGenericMethod: true} aGeneric {
            a = aGeneric.GetGenericMethodDefinition()
        }
        if b is MethodInfo{IsGenericMethod: true} bGeneric {
            b = bGeneric.GetGenericMethodDefinition()
        }
        var pa = a.GetParameters()
        var pb = b.GetParameters()
        if trailingParametersToIgnoreFromA > 0 {
            pa = pa[.. ^trailingParametersToIgnoreFromA]
        }
        if trailingParametersToIgnoreFromB > 0 {
            pb = pb[.. ^trailingParametersToIgnoreFromB]
        }
        // Issue #327/#321: optional-parameter omission can leave two applicable
        // candidates with different parameter counts. Compare only the shared
        // leading positions (the supplied arguments live there); trailing
        // optionals do not affect specificity.
        let shared = Math.Min(pa.Length, pb.Length)
        for var i = 0; i < shared; i++ {
            // a is "at least as specific" parameter-wise when each of its
            // parameter types is assignable to b's (i.e. a's parameter is
            // more derived or equal).
            if !IsParameterTypeAtLeastAsSpecific(pa[i].ParameterType, pb[i].ParameterType) {
                return false
            }
        }
        return true
    }

    private func IsParameterTypeAtLeastAsSpecific(candidate Type, other Type) bool {
        var candidate = candidate
        var other = other
        candidate = PeelByRef(candidate) ?? candidate
        other = PeelByRef(other) ?? other
        // C# better-member specificity treats a concrete type as more specific
        // than a method type parameter. Two type-parameter slots are tied.
        if candidate.IsGenericParameter || other.IsGenericParameter {
            return other.IsGenericParameter
        }
        if ClrTypeUtilities.AreSame(candidate, other) {
            return true
        }
        if candidate.IsArray && other.IsArray && candidate.GetArrayRank() == other.GetArrayRank() {
            let candidateElement Type? = candidate.GetElementType()
            let otherElement Type? = other.GetElementType()
            return candidateElement != nil &&
                otherElement != nil &&
                IsParameterTypeAtLeastAsSpecific(candidateElement, otherElement)
        }
        if candidate.IsGenericType && other.IsGenericType && ClrTypeUtilities.AreSame(
            candidate.GetGenericTypeDefinition(),
            other.GetGenericTypeDefinition()
        ) {
            let candidateArguments = candidate.GetGenericArguments()
            let otherArguments = other.GetGenericArguments()
            if candidateArguments.Length != otherArguments.Length {
                return false
            }
            for var i = 0; i < candidateArguments.Length; i++ {
                if !IsParameterTypeAtLeastAsSpecific(candidateArguments[i], otherArguments[i]) {
                    return false
                }
            }
            return true
        }
        return ClrTypeUtilities.IsAssignableByName(other, candidate)
    }

    private func TryRecoverErasedTypeArguments(
        openMethod MethodInfo?,
        recoveredSymbols ImmutableArray[TypeSymbol?],
        projectTypeArgument((Type) -> Type)?,
        @NotNullWhen(true) out typeArgs[]?Type
    ) bool {
        typeArgs = nil
        if openMethod == nil ||
            recoveredSymbols.IsDefaultOrEmpty ||
            recoveredSymbols.Length != openMethod
            .GetGenericArguments().Length || recoveredSymbols.Any(
            (symbol TypeSymbol?) -> symbol == nil || MemberLookup.IsSymbolicInferenceConflict(symbol)
        ) {
            return false
        }
        let result = [recoveredSymbols.Length]Type
        for var i = 0; i < result.Length; i++ {
            let symbol TypeSymbol? = recoveredSymbols[i]
            if symbol == nil {
                return false
            }
            if !MemberLookup.TryProjectErasedClrType(symbol, out var clrType) {
                return false
            }
            result[i] = (projectTypeArgument?(clrType) ?? clrType)
        }
        typeArgs = result
        return true
    }

    /// Issue #750 / ADR-0088: validates that [`typeArgs`](paramref)
    /// satisfies every CLR-level generic-parameter constraint declared on
    /// [`openMethod`](paramref). The runtime overload of
    /// (cref:MethodInfo.MakeGenericMethod(Type[])) performs this
    /// check itself and throws (cref:ArgumentException) on failure,
    /// but the (cref:System.Reflection.MetadataLoadContext) overload
    /// (used for every `/reference` assembly the binder consumes)
    /// silently accepts any closure regardless of constraints. Without this
    /// explicit check a `where T : class` candidate inferred with
    /// `T = Nullable<int>` survives applicability and the
    /// resolver picks the wrong overload, emitting IL that fails
    /// verification at runtime.
    /// @param openMethod The open generic method definition.
    /// @param typeArgs The candidate type arguments in declaration order.
    /// @param typeArgSymbols Issue #1325: the recovered symbolic type-argument vector (open-arity
    /// order), or `default`. Lets the value-type/struct
    /// constraint checks see through the `object` erasure of
    /// same-compilation user value types.
    /// @returns `true` when every constraint is satisfied.
    private func SatisfiesGenericConstraints(
        openMethod MethodInfo?,
        typeArgs[]?Type,
        typeArgSymbols ImmutableArray[TypeSymbol?] = default(ImmutableArray[TypeSymbol?])
    ) bool {
        if openMethod == nil || typeArgs == nil {
            return true
        }
        var typeParams[]Type
        try {
            typeParams = openMethod.GetGenericArguments()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return true
        }
        return SatisfiesDeclaredConstraints(typeParams, typeArgs, typeArgSymbols, out _, out _)
    }

    private func SatisfiesDeclaredConstraints(
        typeParams[]Type,
        typeArgs[]Type,
        typeArgSymbols ImmutableArray[TypeSymbol?],
        out failedIndex int32,
        out failedConstraint Type?
    ) bool {
        failedIndex = -1
        failedConstraint = nil
        if typeParams.Length != typeArgs.Length {
            return true
        }
        for var i = 0; i < typeParams.Length; i++ {
            failedIndex = i
            failedConstraint = nil
            let param = typeParams[i]
            let arg Type? = typeArgs[i]
            if arg == nil || arg.IsGenericParameter {
                continue
            }
            var attrs GenericParameterAttributes
            try {
                attrs = param.GenericParameterAttributes
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                continue
            }
            // A by-ref-like argument is admitted only for a parameter that
            // declares `allows ref struct` (issues #367, #5216). Live
            // reflection rejects it on any other parameter, so this is ordinary
            // inapplicability, not a compiler identity/context failure.
            if ClrTypeUtilities.IsByRefLike(arg) && !ClrTypeUtilities.AllowsByRefLikeArgument(attrs) {
                return false
            }
            let special = attrs & GenericParameterAttributes.SpecialConstraintMask
            // Issue #1325: a same-compilation user value type (a non-class
            // `StructSymbol` or an `EnumSymbol`) is erased to a `System.Object`
            // placeholder in the CLR `typeArgs` vector because its symbol carries
            // no reference-context CLR type during binding. The recovered
            // symbolic vector lets the value-type/reference-type constraint
            // checks see through that erasure so a `where T : struct` candidate
            // (e.g. MemoryMarshal.Cast/AsBytes) is not wrongly filtered out and a
            // `where T : class` candidate is not wrongly admitted.
            // Issue #1601: a value-type-constrained generic type parameter (e.g.
            // a `TEnum` forwarded from an enclosing `[TEnum Enum struct]`) erases
            // the same way and must classify as a value type here too.
            let argSymbol TypeSymbol? = if !typeArgSymbols.IsDefaultOrEmpty && i < typeArgSymbols.Length {
                typeArgSymbols[i]
            } else {
                default(TypeSymbol?)
            }
            let argIsUserValueType = argSymbol != nil && IsValueTypeErasedSymbol(argSymbol)
            let argIsUserReferenceType = argSymbol is StructSymbol &&
                argSymbol.IsClass == true &&
                argSymbol.ClrType == nil
            if (special & GenericParameterAttributes.ReferenceTypeConstraint) != 0 {
                // `where T : class` — arg must be a reference type (not a
                // value type, not Nullable<T>).
                if arg.IsValueType || argIsUserValueType {
                    return false
                }
            }
            if (special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 {
                // `where T : struct` — arg must be a non-nullable value type.
                // A user struct/enum (erased to `object`) satisfies this even
                // though `arg.IsValueType` is false for the placeholder.
                if !argIsUserValueType && (!arg.IsValueType || NullableLifting.IsValueTypeNullableClr(arg)) {
                    return false
                }
            }
            if (special & GenericParameterAttributes.DefaultConstructorConstraint) != 0 &&
                (special & GenericParameterAttributes.NotNullableValueTypeConstraint) == 0 {
                // `where T : new()` — arg must have a public parameterless
                // constructor. Value types always satisfy this implicitly;
                // reference types require an actual ctor.
                if !arg.IsValueType && !argIsUserValueType {
                    if argIsUserReferenceType && argSymbol is StructSymbol userClass {
                        if userClass.IsAbstract ||
                            userClass.HasPrimaryConstructor ||
                            (
                            !userClass
                                .EffectiveExplicitConstructors
                                .IsDefaultOrEmpty &&
                                !userClass
                                .EffectiveExplicitConstructors
                                .Any(
                                (constructor ConstructorSymbol) -> constructor
                                    .Parameters
                                    .Length == 0 &&
                                    constructor
                                    .Function
                                    .Accessibility == Accessibility.Public
                            )
                        ) {
                            return false
                        }
                    } else {
                        try {
                            let ctor ConstructorInfo? = arg.GetConstructor(Type.EmptyTypes)
                            if ctor == nil || !ctor.IsPublic {
                                return false
                            }
                        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                            // Conservative: a load failure means we can't disprove
                            // the constraint; keep the candidate alive.

                        }
                    }
                }
            }
            // Type-bound constraints — `where T : SomeBase`,
            // `where T : ISomething`, or a dependent bound such as
            // `where TResult : T`. Substitute the complete type-argument
            // vector before testing the constraint.
            var typeConstraints[]Type
            try {
                typeConstraints = param.GetGenericParameterConstraints()
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                continue
            }
            for var c = 0; c < typeConstraints.Length; c++ {
                var constraint Type? = typeConstraints[c]
                if constraint == nil {
                    continue
                }
                // Issue #4041: keep the UNSUBSTITUTED bound. A bound that
                // mentions another type parameter (`where U : IList<T>`) is
                // DEPENDENT, and substituting the erased vector into it is
                // exactly what loses the answer: two distinct same-compilation
                // classes both project to the `System.Object` placeholder, so
                // `Coupled[A, List[Bee]]` becomes `Coupled<object, List<object>>`
                // and `List<object>` honestly does satisfy `IList<object>`. The
                // symbolic vector still distinguishes `A` from `Bee`, so ask it
                // first and only fall through to the CLR comparison when it has
                // no closed answer.
                let rawConstraint = constraint
                try {
                    for var p = 0; p < typeParams.Length; p++ {
                        constraint = SubstituteClrType(constraint!!, typeParams[p], typeArgs[p])
                    }
                } catch (ArgumentException) {
                    // A cross-context type argument can make the substitution
                    // itself fail. It did not disprove the language constraint;
                    // the MakeGenericMethod failure is classified below.

                } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                    continue
                }
                if constraint!!.IsGenericParameter || constraint!!.ContainsGenericParameters {
                    continue
                }
                // Issue #4032: from here on, every `return false` in this loop
                // is a type-BOUND constraint failure, so name the bound that
                // failed. Callers that only want a yes/no discard it.
                failedConstraint = constraint
                // Issue #4041: a DEPENDENT bound over an ERASED vector is
                // answered on the SYMBOLS, never on the projected `Type[]`.
                // Three-state on purpose: a definitive no rejects, a definitive
                // yes accepts, and anything the symbols cannot settle falls
                // through to the CLR comparison below — never to a rejection,
                // because a wrong `no` here is a GS0152 on a legal program.
                if rawConstraint.ContainsGenericParameters &&
                    AnyDependentPositionIsErased(rawConstraint, typeParams, typeArgSymbols) &&
                    TrySatisfiesDependentBoundSymbolically(
                    rawConstraint,
                    typeParams,
                    typeArgSymbols,
                    argSymbol,
                    out var dependentSatisfied
                ) {
                    if dependentSatisfied {
                        continue
                    }
                    // Issue #4063: for a BARE dependent bound the substituted
                    // `constraint` is the erased placeholder — `object` — and a
                    // message reading "does not satisfy the 'System.Object'
                    // constraint" names the erasure rather than the bound the
                    // author wrote. The UNSUBSTITUTED bound is the generic
                    // parameter itself, whose `Name` is `TBase`.
                    if rawConstraint.IsGenericParameter {
                        failedConstraint = rawConstraint
                    }
                    return false
                }
                // Issue #2617: a same-compilation type argument is represented by
                // `object` while imported generic methods are resolved. Check CLR
                // interface constraints against the symbol's declared interfaces
                // instead of the placeholder. This is the Oahu
                // SettingsManager.GetUserSettings[UserSettings]() shape.
                if constraint!!.IsInterface && argSymbol is {} interfaceSymbol && interfaceSymbol.ClrType == nil {
                    if ErasedSymbolSatisfiesInterfaceConstraint(interfaceSymbol, constraint!!) {
                        continue
                    }
                    // Issue #4070: when the type argument is a TYPE PARAMETER,
                    // its CLASS bound proves every interface that class
                    // implements — `Probes.NeedsDisposable[T]()` inside
                    // `func callIt[T DisposableBase]()` forwards
                    // `where T : IDisposable`, and `csc` accepts it. This is
                    // the SAME question the generic-TYPE construction path
                    // answers in `TypeParameterSatisfiesClrBound` (#4037), and
                    // it is answered by the SAME walk — the two paths differed
                    // only in that this one never looked past the parameter's
                    // interface bounds, so the candidate was silently FILTERED
                    // out of overload resolution and the author saw
                    // `GS0159 Cannot find function` rather than a constraint
                    // message. Monotone in the satisfaction direction: it only
                    // turns a `false` into a `true`, never the reverse.
                    //
                    // Guarded on the UNSUBSTITUTED constraint mentioning no
                    // type parameter, which is the same skip the generic-TYPE
                    // path applies (#4031/#4041: a bound such as
                    // `where T : IEquatable<T>` cannot be answered on the
                    // erased vector, because `IEquatable<T>` and the
                    // same-compilation `IEquatable<GsEq>` both project to
                    // `IEquatable<object>` and the walk would "prove" an
                    // implication that does not hold). Without it, measured:
                    // `func callIt[T GsEq]()` over a same-compilation
                    // `class GsEq : IEquatable[GsEq]` compiled and then threw
                    // `VerificationException: Method
                    // HelperLib2.Probes.NeedsEquatable: type argument 'T'
                    // violates the constraint of type parameter 'T'` — and
                    // `csc` reports `CS0311` on the C# equivalent, so the
                    // acceptance was wrong on both counts. A constraint whose
                    // arguments are all CONCRETE (`where T : IEnumerable<string>`)
                    // still goes through: the erasure cannot lose anything
                    // there.
                    if interfaceSymbol is TypeParameterSymbol erasedTypeParameter &&
                        !rawConstraint.ContainsGenericParameters &&
                        TypeParameterSatisfiesClrInterfaceBound(erasedTypeParameter, constraint!!) {
                        continue
                    }
                    return false
                }
                // Issue #1325: a `where T : struct` parameter carries an implicit
                // `System.ValueType` base constraint in metadata (and an enum a
                // `System.Enum` one). A same-compilation user value type is erased
                // to a `System.Object` placeholder, which is not name-assignable
                // to `ValueType`/`Enum` by the plain `IsAssignableByName` check
                // below, so a base-type (class, non-interface) constraint needs
                // the symbolic derivation check instead.
                // Issue #1833: the former version of this guard unconditionally
                // treated *every* `ValueType`/`Enum`-named constraint as satisfied
                // once `argIsUserValueType` was true — so a plain (non-enum)
                // struct, or a bare `[T struct]` type parameter with no `Enum`
                // bound, silently bound through `Enum.TryParse[T]`'s `where T :
                // Enum` constraint and only failed later at CLR verification.
                // `ValueTypeErasedSymbolSatisfiesBaseConstraint` walks the
                // recovered symbol's real derivation/constraint chain so
                // `ValueType`/`Object` are still trivially satisfied by any
                // struct/enum, but `Enum` (or any other concrete base) is only
                // satisfied by an actual enum or a type parameter that itself
                // carries that same base bound.
                if argIsUserValueType && !constraint!!.IsInterface {
                    if argSymbol is {} constrainedValueTypeSymbol &&
                        ValueTypeErasedSymbolSatisfiesBaseConstraint(constrainedValueTypeSymbol, constraint) {
                        continue
                    }
                    return false
                }
                // A same-compilation user class also has no CLR Type during
                // binding and is represented by an object placeholder. Check
                // its symbolic base chain for concrete class constraints.
                if argIsUserReferenceType && !constraint!!.IsInterface {
                    if argSymbol is StructSymbol userReferenceType &&
                        UserReferenceTypeErasedSymbolSatisfiesBaseConstraint(userReferenceType, constraint) {
                        continue
                    }
                    return false
                }
                // Issue #4083: a TYPE PARAMETER type argument erases to the
                // same `System.Object` placeholder, and for a BASE-CLASS bound
                // none of the arms above match it — so `IsAssignableByName`
                // below was asked whether `object` derives from
                // `SchemeOptions`, said no, and the candidate was silently
                // FILTERED out of overload resolution. The author saw
                // `GS0159 Cannot find function NeedsScheme.` rather than a
                // constraint message, on a program `csc` accepts:
                // `Probes.NeedsScheme[T]()` inside
                // `func callIt[T SchemeOptions]()` forwards
                // `where T : SchemeOptions` in every instantiation. This is
                // #4070's repair one bound-kind over — the generic-TYPE
                // construction path has walked the parameter's own class
                // chain since #4037, and this calls the SAME walk.
                //
                // Monotone in the satisfaction direction: it only turns a
                // `false` into a `true`, never the reverse, so no program the
                // CLR refuses becomes acceptable.
                //
                // Guarded on the UNSUBSTITUTED bound mentioning no type
                // parameter, the same skip #4031/#4041 apply and #4070 paid
                // for on the interface half: `where T : Base<T>` and a
                // same-compilation `Base<Gs>` both project to `Base<object>`,
                // so the walk would "prove" an implication that does not hold.
                if argSymbol is TypeParameterSymbol{ClrType: nil} erasedBoundedParameter &&
                    !constraint!!.IsInterface &&
                    !rawConstraint.ContainsGenericParameters &&
                    TypeParameterSatisfiesClrClassBound(erasedBoundedParameter, constraint!!) {
                    continue
                }
                try {
                    if !ClrTypeUtilities.IsAssignableByName(constraint, arg) {
                        return false
                    }
                } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                    // Conservative — treat as satisfied on load failure.

                }
            }
        }
        failedIndex = -1
        failedConstraint = nil
        return true
    }

    private func RejectConstraintFailureOrThrowCompilerInvariant(
        openMethod MethodInfo,
        typeArgs[]Type,
        typeArgSymbols ImmutableArray[TypeSymbol?],
        failure ArgumentException
    ) {
        if !SatisfiesGenericConstraints(openMethod, typeArgs, typeArgSymbols) {
            return
        }
        let hasErasedSymbol = !typeArgSymbols.IsDefaultOrEmpty && typeArgSymbols.Any(
            (symbol TypeSymbol?) -> symbol != nil && symbol.ClrType == nil
        )
        if hasErasedSymbol && !HasConcreteReflectionContextMismatch(openMethod, typeArgs, typeArgSymbols) {
            // Placeholder closure is deliberately best-effort for
            // same-compilation symbols with no CLR Type. Preserve their
            // established silent rejection, but do not let one erased slot
            // hide a mismatch in another concrete slot.
            return
        }
        let methodName = "${openMethod.DeclaringType?.FullName ?? "<unknown>"}.${openMethod.Name}"
        let arguments = string.Join(
            ", ",
            typeArgs.Select((type Type) -> "${type.FullName ?? type.Name} [${type.Assembly.GetName().Name}]")
        )
        throw InvalidOperationException(
            "Generic method closure invariant violated for '$methodName': MakeGenericMethod rejected " +
                "compiler-supplied type arguments after their generic constraints were satisfied. The method " +
                "and type arguments have incompatible reflection/load contexts or inconsistent CLR identities. " +
                "Type arguments: $arguments. Reflection reported: ${failure.Message}"
        )
    }

    private func HasConcreteReflectionContextMismatch(
        openMethod MethodInfo,
        typeArgs[]Type,
        typeArgSymbols ImmutableArray[TypeSymbol?]
    ) bool {
        var typeParameters[]Type
        try {
            typeParameters = openMethod.GetGenericArguments()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
        for var i = 0; i < typeParameters.Length && i < typeArgs.Length; i++ {
            if !typeArgSymbols.IsDefaultOrEmpty && i < typeArgSymbols.Length && typeArgSymbols[i] is {ClrType: nil} {
                continue
            }
            let argument = typeArgs[i]
            if !CanConstructGenericContextProbe(typeParameters[i], argument) {
                return true
            }
            var constraints[]Type
            try {
                constraints = typeParameters[i].GetGenericParameterConstraints()
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                continue
            }
            for originalConstraint in constraints {
                if DependsOnErasedTypeParameter(originalConstraint, typeParameters, typeArgSymbols) {
                    continue
                }
                var constraint = originalConstraint
                try {
                    for var p = 0; p < typeParameters.Length; p++ {
                        constraint = SubstituteClrType(constraint, typeParameters[p], typeArgs[p])
                    }
                    if !constraint.ContainsGenericParameters && ClrTypeUtilities.IsAssignableByName(
                        constraint,
                        argument
                    ) &&
                        !constraint.IsAssignableFrom(argument) {
                        return true
                    }
                } catch (ArgumentException) {
                    return true
                } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                    continue
                }
            }
        }
        return false
    }

    private func DependsOnErasedTypeParameter(
        type Type,
        typeParameters[]Type,
        typeArgSymbols ImmutableArray[TypeSymbol?]
    ) bool {
        if type.IsGenericParameter {
            for var i = 0; i < typeParameters.Length && i < typeArgSymbols.Length; i++ {
                if object.ReferenceEquals(type, typeParameters[i]) && typeArgSymbols[i] is {ClrType: nil} {
                    return true
                }
            }
            return false
        }
        if type.HasElementType && type.GetElementType() is {} element {
            return DependsOnErasedTypeParameter(element, typeParameters, typeArgSymbols)
        }
        return type.IsGenericType && type.GetGenericArguments().Any(
            (argument Type) -> DependsOnErasedTypeParameter(argument, typeParameters, typeArgSymbols)
        )
    }

    private func CanConstructGenericContextProbe(genericParameter Type, argument Type) bool {
        try {
            var root Type? = genericParameter.BaseType
            while root?.BaseType is {} baseType {
                root = baseType
            }
            let listDefinition Type? = root?.Assembly.GetType("System.Collections.Generic.List`1")
            if listDefinition == nil {
                return true
            }
            let _ = listDefinition.MakeGenericType(argument)
            return true
        } catch (ArgumentException) {
            return false
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return true
        }
    }

    private func ErasedSymbolSatisfiesInterfaceConstraint(symbol TypeSymbol, constraint Type) bool {
        if symbol is StructSymbol aggregate {
            for current in aggregate.GetHierarchy() {
                for implemented in current.ImplementedClrInterfaces {
                    if ClrInterfaceSatisfies(implemented?.ClrType, constraint) {
                        return true
                    }
                }
                for implemented in current.Interfaces {
                    if UserInterfaceSatisfies(implemented, constraint) {
                        return true
                    }
                }
            }
            return aggregate.ImportedBaseType?.ClrType is Type importedBase && ClrTypeUtilities.IsAssignableByName(
                constraint,
                importedBase
            )
        }
        if symbol is InterfaceSymbol userInterface {
            return UserInterfaceSatisfies(userInterface, constraint)
        }
        return symbol is TypeParameterSymbol typeParameter &&
            (
            ClrInterfaceSatisfies(typeParameter.ClrInterfaceConstraint?.ClrType, constraint) ||
                UserInterfaceSatisfies(typeParameter.InterfaceConstraint, constraint)
        )
    }

    private func UserInterfaceSatisfies(userInterface InterfaceSymbol?, constraint Type) bool {
        if userInterface == nil {
            return false
        }
        for candidate in userInterface.SelfAndAllBaseInterfaces() {
            for importedBase in candidate.BaseClrInterfaces {
                if ClrInterfaceSatisfies(importedBase?.ClrType, constraint) {
                    return true
                }
            }
        }
        return false
    }

    private func ClrInterfaceSatisfies(candidate Type?, constraint Type) bool -> candidate != nil &&
        (
        ClrTypeUtilities.AreSame(candidate, constraint) || ClrTypeUtilities.ImplementsInterfaceByName(
            candidate,
            constraint
        )
    )

    /// Issue #1325: recognizes a type-argument symbol that is a same-compilation
    /// user value type — a non-class (cref:StructSymbol) or an
    /// (cref:EnumSymbol). These are erased to a `System.Object`
    /// placeholder in the CLR type-argument vector, so the value-type/struct
    /// generic constraint checks need the symbol to classify them correctly. A
    /// user class (`StructSymbol { IsClass: true }`) and a nullable value
    /// type are deliberately excluded.
    /// @param symbol The recovered type-argument symbol.
    /// @returns `true` when the symbol is a user struct or enum.
    private func IsUserValueTypeSymbol(symbol TypeSymbol) bool -> symbol is StructSymbol &&
        symbol.IsClass == false ||
        symbol is EnumSymbol

    /// Issue #1601: recognizes a type-argument symbol that has no reference-context
    /// CLR type but is guaranteed to be a non-nullable value type — either a
    /// same-compilation user value type (see (cref:IsUserValueTypeSymbol)) or
    /// an in-scope generic type parameter carrying a value-type (`struct`)
    /// constraint (e.g. the `TEnum` of `func Parse[TEnum Enum struct]`
    /// forwarded to `Enum.TryParse[TEnum]`). Both erase to a `System.Object`
    /// placeholder in the CLR type-argument vector, so the value-type/struct generic
    /// constraint checks (and the placeholder closure) need the symbol to classify
    /// them correctly. Live-reflection (cref:MethodInfo.MakeGenericMethod(Type[]))
    /// cannot be called with such a symbol because it is not a real runtime
    /// (cref:Type), so the closure over a value-type placeholder applies to it
    /// exactly as it does to a same-compilation user value type.
    /// @param symbol The recovered type-argument symbol.
    /// @returns `true` when the symbol erases to a value-type placeholder.
    private func IsValueTypeErasedSymbol(symbol TypeSymbol) bool -> IsUserValueTypeSymbol(symbol) ||
        symbol is TypeParameterSymbol &&
        symbol.HasValueTypeConstraint == true

    /// Issue #1833: determines whether a value-type-erased type-argument symbol
    /// (see (cref:IsValueTypeErasedSymbol)) satisfies an explicit CLR
    /// base-class (non-interface) constraint [`constraint`](paramref),
    /// generalizing the former hardcoded `System.ValueType`/`System.Enum` name
    /// check into a walk of the symbol's own derivation/constraint chain.
    /// - `System.ValueType` and `System.Object` are trivially satisfied by every struct/enum — every value
    /// type derives from them.
    /// - A concrete enum ((cref:EnumSymbol)) satisfies exactly `System.Enum` — no other base class is
    /// possible for an enum.
    /// - A plain struct ((cref:StructSymbol)) satisfies neither — a value type has no symbolic base beyond
    /// `ValueType`/`Object` under the CLR, so any other base-class constraint (most notably `Enum`) is
    /// unsatisfiable.
    /// - An in-scope generic type parameter ((cref:TypeParameterSymbol), e.g. the forwarded `TEnum` of
    /// `[TEnum Enum struct]`) satisfies [`constraint`](paramref) only when its own
    /// (cref:TypeParameterSymbol.ClassConstraint) resolves to the same CLR type (transitively, through a
    /// chain of forwarded constraints) — a bare `struct` constraint with no class bound does not prove
    /// anything about `Enum` or any other base.
    /// @param symbol The recovered value-type-erased type-argument symbol.
    /// @param constraint The CLR base-class constraint to check against.
    /// @returns `true` when the symbol provably satisfies the constraint.
    private func ValueTypeErasedSymbolSatisfiesBaseConstraint(symbol TypeSymbol, constraint Type?) bool {
        if constraint == nil {
            return true
        }
        if constraint.IsSameAs(typeof(object)) || string.Equals(
            constraint.FullName,
            "System.ValueType",
            StringComparison.Ordinal
        ) {
            return true
        }
        var current TypeSymbol? = symbol
        while current != nil {
            switch current {
                case EnumSymbol {
                    return string.Equals(constraint.FullName, "System.Enum", StringComparison.Ordinal)
                }
                case StructSymbol {
                    return false
                }
                case typeParam is TypeParameterSymbol {
                    let classConstraint = typeParam.ClassConstraint
                    if classConstraint?.ClrType != nil && string.Equals(
                        classConstraint!!.ClrType!!.FullName,
                        constraint.FullName,
                        StringComparison.Ordinal
                    ) {
                        return true
                    }
                    current = classConstraint
                    continue
                }
                default {
                    return false
                }
            }
        }
        return false
    }

    /// Issue #4016 follow-up: the explicit type-argument vector with every
    /// ERASED position put back to the reference-context `object`
    /// placeholder, for the purpose of checking generic constraints.
    /// @remarks #4016 closes an explicit type argument over the same erasure the
    /// arguments present, so a same-compilation class arrives as its imported
    /// base and applicability compares like with like. Constraints must not see
    /// that surrogate: it leaks into ANOTHER type parameter's constraint
    /// whenever the constraint mentions this one, and the two sides then
    /// disagree the way `AuthenticationHandler<AuthenticationSchemeOptions>`
    /// disagrees with the `AuthenticationHandler<object>` that the
    /// handler's own base chain erases to. A position is erased exactly when
    /// its recovered symbol has no CLR type of its own — the same test
    /// `RejectConstraintFailureOrThrowCompilerInvariant` uses. Returns the
    /// original array when nothing needs normalising, so the common path
    /// allocates nothing.
    /// @param typeArgs The closed type-argument vector.
    /// @param typeArgSymbols The recovered symbolic type arguments.
    /// @returns The vector to check constraints against.
    private func NormaliseErasedTypeArgsForConstraintCheck(
        typeArgs[]?Type,
        typeArgSymbols ImmutableArray[TypeSymbol?]
    )[]Type {
        if typeArgs == nil || typeArgSymbols.IsDefaultOrEmpty || typeArgSymbols.Length != typeArgs.Length {
            return typeArgs ?? Array.Empty[Type]()
        }
        var normalised[]?Type = nil
        for var i = 0; i < typeArgs.Length; i++ {
            if typeArgSymbols[i] is not{ClrType: nil} {
                continue
            }
            let contextObject Type? = ResolveObjectInSameContext(typeArgs[i])
            if contextObject == nil || typeArgs[i].IsSameAs(contextObject) {
                continue
            }
            normalised ??= cast[[]Type](typeArgs.Clone())
            normalised!![i] = contextObject
        }
        return normalised ?? typeArgs
    }

    /// Issue #4016 follow-up: `System.Object` as loaded in the same
    /// reflection context as [`sibling`](paramref), so the normalised
    /// vector stays usable in that load context.
    /// @param sibling A type already in the target context.
    /// @returns That context's `System.Object`.
    private func ResolveObjectInSameContext(sibling Type?) Type? {
        if sibling == nil {
            return typeof(object)
        }
        try {
            return if sibling.Assembly == typeof(object).Assembly {
                typeof(object)
            } else {
                sibling.Assembly.GetType("System.Object", throwOnError: false) ?? typeof(object)
            }
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return typeof(object)
        }
    }

    /// Issue #4041: `true` when at least one type-argument
    /// position that [`rawConstraint`](paramref) mentions arrived ERASED —
    /// a same-compilation symbol with no CLR type of its own, or an imported
    /// construction over one. That is the only situation in which the projected
    /// `Type[]` can answer a dependent bound wrongly, so the symbolic path
    /// below is gated on it and every non-dependent or fully-imported bound
    /// keeps the pre-#4041 behaviour byte for byte.
    /// @param rawConstraint The UNSUBSTITUTED declared bound.
    /// @param typeParams The definition's own generic parameters.
    /// @param typeArgSymbols The recovered symbolic type arguments.
    /// @returns `true` when the bound reads an erased position.
    private func AnyDependentPositionIsErased(
        rawConstraint Type,
        typeParams[]?Type,
        typeArgSymbols ImmutableArray[TypeSymbol?]
    ) bool {
        if typeArgSymbols.IsDefaultOrEmpty || typeParams == nil {
            return false
        }
        for var p = 0; p < typeParams.Length && p < typeArgSymbols.Length; p++ {
            if !MentionsGenericParameter(rawConstraint, typeParams[p]) {
                continue
            }
            if IsErasedForDependentCheck(typeArgSymbols[p]) {
                return true
            }
        }
        return false
    }

    /// Issue #4041: whether [`symbol`](paramref) reaches the constraint
    /// check as a placeholder rather than as itself — a same-compilation type
    /// (no CLR type of its own) or an imported construction one of whose
    /// symbolic arguments is such a type.
    /// @param symbol The recovered symbolic type argument.
    /// @returns `true` when the CLR projection lost information.
    private func IsErasedForDependentCheck(symbol TypeSymbol?) bool {
        if symbol == nil {
            return false
        }
        if symbol.ClrType == nil {
            return true
        }
        if symbol is ImportedTypeSymbol{TypeArguments: {IsDefaultOrEmpty: false}} imported {
            for argument in imported.TypeArguments {
                if IsErasedForDependentCheck(argument) {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #4041: whether [`type`](paramref) mentions
    /// [`parameter`](paramref) anywhere in its shape.
    /// @param type The type to inspect.
    /// @param parameter The generic parameter to look for.
    /// @returns `true` when the parameter occurs.
    private func MentionsGenericParameter(type Type?, parameter Type?) bool {
        if type == nil || parameter == nil {
            return false
        }
        try {
            if type.IsGenericParameter {
                return parameter.IsGenericParameter &&
                    type.GenericParameterPosition == parameter.GenericParameterPosition &&
                    type.DeclaringMethod == parameter.DeclaringMethod &&
                    type.DeclaringType == parameter.DeclaringType
            }
            if type.HasElementType {
                return MentionsGenericParameter(type.GetElementType(), parameter)
            }
            if type.IsGenericType {
                for argument in type.GetGenericArguments() {
                    if MentionsGenericParameter(argument, parameter) {
                        return true
                    }
                }
            }
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
        return false
    }

    /// Issue #4041: answers a DEPENDENT bound from the SYMBOLIC vector.
    /// @remarks The bound is read UNSUBSTITUTED, so `where U : IList<T>`
    /// is still `IList<T>` when it arrives, with `T` naming the
    /// definition's own generic parameter. (cref:MatchDependentShape)
    /// then walks that SHAPE against the type argument's SYMBOL in parallel:
    /// at `IList<>` it recovers `List[Bee]`'s own instantiation
    /// of `IList<>` as `[Bee]`, and at the leaf `T` it
    /// compares `Bee` against the symbol supplied for `T`, which is
    /// `A`. The erased `IList<object>` vs `List<object>`
    /// comparison this replaces could not see that difference at all.
    ///
    /// <b>Three-state, and indeterminate wherever it is not sure.</b>
    /// It returns `false` (meaning "no symbolic answer") rather
    /// than a verdict whenever the shape reaches a concrete (non-parameter,
    /// non-generic) position, a mentioned parameter has no recovered symbol,
    /// the open definition declares a VARIANT parameter — where
    /// `IEnumerable[Derived]` legitimately satisfies
    /// `IEnumerable[Base]` and identity is the wrong relation — the open
    /// definition is not reachable from the argument's symbol at all, or (issue
    /// #4063) the assignability relation at the TOP of a bare bound cannot be
    /// settled on closed symbols. Every one
    /// of those falls back to the pre-#4041 CLR comparison, which is what keeps
    /// the same-compilation base-chain path (#4032's
    /// `AddScheme[TOptions, THandler]` row) green. A wrong "no" here would
    /// be a GS0152 on a legal program, which is strictly worse than the defect
    /// being fixed.
    /// @param rawConstraint The UNSUBSTITUTED declared bound.
    /// @param typeParams The definition's own generic parameters.
    /// @param typeArgSymbols The recovered symbolic type arguments.
    /// @param argSymbol The symbol supplied for the BOUNDED parameter.
    /// @param satisfied Set only when the method returns `true`.
    /// @returns `true` when a symbolic verdict was reached.
    private func TrySatisfiesDependentBoundSymbolically(
        rawConstraint Type?,
        typeParams[]Type,
        typeArgSymbols ImmutableArray[TypeSymbol?],
        argSymbol TypeSymbol?,
        out satisfied bool
    ) bool {
        satisfied = false
        if rawConstraint == nil || argSymbol == nil || typeArgSymbols.IsDefaultOrEmpty {
            return false
        }
        let verdict = MatchDependentShape(
            rawConstraint,
            argSymbol,
            typeParams,
            typeArgSymbols,
            atTopOfBound: true,
            shapePath: List[string]()
        )
        if verdict == DependentShapeIndeterminate {
            return false
        }
        satisfied = verdict == DependentShapeMatches
        return true
    }

    /// Issue #4041: walks a declared bound's SHAPE — a CLR type that may still
    /// mention the definition's own generic parameters — against a symbolic
    /// type in parallel, recursing through generic arguments so a NESTED bound
    /// such as `IList<List<T>>` is answered at its leaf rather
    /// than at its outermost construction.
    /// @param shape The bound, or a fragment of it.
    /// @param actual The symbol that fragment must match.
    /// @param typeParams The definition's own generic parameters.
    /// @param typeArgSymbols The recovered symbolic type arguments.
    /// @param atTopOfBound Whether this is the bound's outermost position. The relation there is
    /// ASSIGNABILITY, not the invariant identity that is correct at an argument
    /// position, and that distinction is load-bearing rather than defensive: it
    /// was measured, and comparing the two arguments for identity here fails
    /// the legal `Chain[ChBase, ChDerived]` with a false `GS0152`.
    /// Issue #4063: a bare type parameter at the top is therefore routed to
    /// (cref:MatchDependentTopOfBound), which asks assignability of the
    /// symbols, instead of declining to answer at all — declining is what left
    /// `Chain[ChA, ChB]` over two unrelated erased classes accepted.
    /// @param shapePath The printed forms of the shape fragments on the path from the bound's root to this
    /// node.
    /// Review finding (#4068): the previous form of this method stopped at a
    /// fixed depth of eight, which silently turned a legal deeply nested bound
    /// into an indeterminate answer and handed it to the erased comparison —
    /// the very hole this check exists to close, measured at nine levels.
    /// Recursion is bounded by CYCLE detection on this path instead, which
    /// terminates on malformed metadata without capping legal signatures: a
    /// well-formed shape tree is finite and strictly shrinks at every step.
    /// @returns One of the three `DependentShape*` verdicts.
    private func MatchDependentShape(
        shape Type?,
        actual TypeSymbol?,
        typeParams[]Type,
        typeArgSymbols ImmutableArray[TypeSymbol?],
        atTopOfBound bool,
        shapePath List[string]
    ) int32 {
        if shape == nil || actual == nil {
            return DependentShapeIndeterminate
        }
        try {
            // A leaf naming one of the definition's own parameters: compare the
            // symbol supplied for it against the symbol found here. This is the
            // whole point — `A` and `Bee` are distinguishable as symbols and
            // indistinguishable as the `object` both project to.
            if shape.IsGenericParameter {
                let position = IndexOfGenericParameter(typeParams, shape)
                if position < 0 || position >= typeArgSymbols.Length || typeArgSymbols[position] is not{} expected {
                    return DependentShapeIndeterminate
                }
                // Identity is the right relation only at an INVARIANT ARGUMENT
                // position inside a constructed bound. At the TOP of a bound it
                // is ASSIGNABILITY: an imported `where TDerived : TBase` admits
                // any TDerived that derives from TBase, so comparing the two
                // arguments for identity would reject `Chain[ChBase, ChDerived]`
                // outright.
                //
                // Issue #4063: #4041 declined to answer here at all, which left
                // `Chain[ChA, ChB]` over two UNRELATED erased classes accepted —
                // the substituted bound is `object`, and every erased class
                // trivially satisfies it. The relation is now asked of the
                // SYMBOLS, through the very predicate the G#-declared spelling
                // of this bound already uses (#4043's
                // `Binder.SatisfiesDependentBound`), so the imported and
                // G#-declared spellings cannot drift apart.
                if atTopOfBound {
                    return MatchDependentTopOfBound(actual, expected)
                }
                return if TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(actual, expected) {
                    DependentShapeMatches
                } else {
                    DependentShapeDiffers
                }
            }
            if !shape.IsGenericType || !shape.ContainsGenericParameters {
                // A closed fragment carries no erased information of its own; the
                // CLR comparison already answers it correctly.
                return DependentShapeIndeterminate
            }
            let openDefinition = shape.GetGenericTypeDefinition()
            let shapeArguments = shape.GetGenericArguments()
            let ownParameters = openDefinition.GetGenericArguments()
            if shapeArguments.Length == 0 || shapeArguments.Length != ownParameters.Length {
                return DependentShapeIndeterminate
            }
            for var k = 0; k < ownParameters.Length; k++ {
                // Variance makes identity the wrong relation: `List[Derived]`
                // DOES satisfy `IEnumerable[Base]`. Leave those to the CLR.
                if (
                    ownParameters[k].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
                ) != GenericParameterAttributes.None {
                    return DependentShapeIndeterminate
                }
            }
            if !TryGetSymbolicInstantiation(actual, openDefinition, out var actualArguments) ||
                actualArguments.Length != shapeArguments.Length {
                return DependentShapeIndeterminate
            }
            // Review finding (#4068): terminate on an actual cycle rather than
            // at an arbitrary depth. A repeat along THIS path is the only way
            // the descent can fail to shrink; a fragment legitimately recurring
            // at sibling positions (`IDictionary<IList<T>, IList<T>>`) is not a
            // cycle and must still be compared.
            // NOT `IsSameAs`: `Type.FullName` is NULL for an OPEN constructed
            // generic, so that comparison reports every nested `List<...>` as
            // the same type and fires a false cycle at the first argument —
            // measured, it collapsed the catchable nesting from seven levels
            // to one. The shape's printed form is well defined for open types
            // and distinct per level, so it identifies a genuine repeat.
            let shapeKey = shape.ToString()
            for visited in shapePath {
                if string.Equals(visited, shapeKey, StringComparison.Ordinal) {
                    return DependentShapeIndeterminate
                }
            }
            shapePath.Add(shapeKey)
            try {
                var verdict = DependentShapeMatches
                for var k = 0; k < shapeArguments.Length; k++ {
                    let inner = MatchDependentShape(
                        shapeArguments[k],
                        actualArguments[k],
                        typeParams,
                        typeArgSymbols,
                        atTopOfBound: false,
                        shapePath
                    )
                    if inner == DependentShapeDiffers {
                        return DependentShapeDiffers
                    }
                    if inner == DependentShapeIndeterminate {
                        // Keep looking: another position may still disprove the
                        // bound outright, which is a stronger answer than "unsure".
                        verdict = DependentShapeIndeterminate
                    }
                }
                return verdict
            } finally {
                shapePath.RemoveAt(shapePath.Count - 1)
            }
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return DependentShapeIndeterminate
        }
    }

    /// Issue #4063: answers a BARE dependent bound (`where TDerived : TBase`)
    /// at the TOP of the bound, where the relation is ASSIGNABILITY rather than
    /// the invariant identity that is correct at an argument position.
    /// @remarks <b>One predicate, two spellings.</b> The G#-declared spelling of
    /// this exact bound (`func take[TBase, TDerived TBase]()`) has been
    /// answered by `Binder.SatisfiesDependentBound` since #4043, and that
    /// predicate is deliberately reused here rather than reimplemented: an
    /// independent copy would let the imported and G#-declared spellings of the
    /// same rule drift apart, and it is the drift — not the relation — that
    /// produces a false `GS0152`. The reference is a call to one pure
    /// `internal static` method in the same assembly; no binder state is
    /// reachable from here and none is used.
    ///
    /// <b>It only ever REJECTS what it can disprove.</b>
    /// `SatisfiesDependentBound` accepts on every indeterminate answer, so
    /// a `false` from it is a definitive "no". A
    /// `true` is mapped to `Indeterminate` rather than to
    /// `Matches` — it may mean "yes" or "cannot tell", and the CLR
    /// comparison this falls back to accepts an erased vector anyway, so the
    /// outcome is identical and the label stays honest.
    ///
    /// <b>An open side declines outright.</b> When either symbol still
    /// mentions a type parameter the relation has no closed answer, and the
    /// self-substitution `SatisfiesDependentBound` performs for a
    /// self-referential generic interface bound needs the bounded parameter's
    /// own symbol, which the imported path does not have. Refusing to answer
    /// there keeps the missing symbol from ever mattering.
    /// @param actual The symbol supplied for the BOUNDED parameter.
    /// @param expected The symbol supplied for the BOUNDING parameter.
    /// @returns One of the three `DependentShape*` verdicts.
    private func MatchDependentTopOfBound(actual TypeSymbol, expected TypeSymbol) int32 {
        if TypeSymbol.ContainsTypeParameter(actual) || TypeSymbol.ContainsTypeParameter(expected) {
            return DependentShapeIndeterminate
        }
        return if GSharp.Core.CodeAnalysis.Binding.Binder.SatisfiesDependentBound(actual, expected, tp: nil) {
            DependentShapeIndeterminate
        } else {
            DependentShapeDiffers
        }
    }

    /// Issue #4041: the position of [`parameter`](paramref) in
    /// [`typeParams`](paramref), or `-1`. Compared by identity in the
    /// same reflection context rather than by
    /// (cref:Type.GenericParameterPosition), so a parameter belonging to
    /// some OTHER definition is not mistaken for one of these.
    /// @param typeParams The definition's own generic parameters.
    /// @param parameter The parameter to locate.
    /// @returns The index, or `-1`.
    private func IndexOfGenericParameter(typeParams[]?Type, parameter Type) int32 {
        if typeParams == nil {
            return -1
        }
        for var i = 0; i < typeParams.Length; i++ {
            if typeParams[i] is {} candidate && candidate.IsSameAs(parameter) {
                return i
            }
        }
        return -1
    }

    /// Issue #4041: the SYMBOLIC type arguments with which
    /// [`symbol`](paramref) instantiates [`openDefinition`](paramref)
    /// — `[Bee]` for `List[Bee]` against `IList<>`.
    /// @remarks Walks the OPEN definition's own self / base / interface set so each
    /// position can be traced back to one of the open definition's parameters
    /// and then to the symbol's `TypeArguments`. Reading the CLOSED
    /// `ClrType` instead would only re-derive the erased vector this whole
    /// check exists to avoid. A same-compilation class is followed to its
    /// imported base first, which is the
    /// `MyHandler : AuthenticationHandler[MyOptions]` shape.
    /// @param symbol The type argument's symbol.
    /// @param openDefinition The open generic definition sought.
    /// @param arguments The recovered symbolic arguments, on success.
    /// @returns `true` when the instantiation was recovered.
    private func TryGetSymbolicInstantiation(symbol TypeSymbol, openDefinition Type, out arguments[]TypeSymbol?) bool {
        arguments = Array.Empty[TypeSymbol?]()
        // Review finding (#4068): a source type reaches an imported open
        // definition through EVERY imported projection it carries, not only
        // through its imported BASE. `class Impl : IDep[Bee]` implements the
        // imported generic interface DIRECTLY, and reading only
        // `ImportedBaseType` returned "no symbolic answer" for it — after
        // which the erased comparison saw `IDep<object>` on both sides and
        // ACCEPTED `Coupled2[A, Impl]`, which the CLR then refused. That is
        // this PR's own defect reached by a different route, so every
        // projection is enumerated here.
        for projection in EnumerateImportedProjections(symbol) {
            if TryGetSymbolicInstantiationFromImported(projection, openDefinition, out arguments) {
                return true
            }
        }
        arguments = Array.Empty[TypeSymbol?]()
        return false
    }

    /// Review finding (#4068): every imported construction a symbol carries —
    /// itself when it is imported, the CLR interfaces a source aggregate
    /// implements directly, the imported bases of the user interfaces it
    /// implements, and its own imported base chain. Each is a CLOSED symbolic
    /// instantiation, so its `TypeArguments` still distinguish two
    /// same-compilation classes that the CLR projection collapses.
    /// @param symbol The symbol whose imported projections are wanted.
    /// @returns The imported constructions, nearest first.
    private func EnumerateImportedProjections(symbol TypeSymbol?) sequence[ImportedTypeSymbol] {
        if symbol is ImportedTypeSymbol self {
            yield self
        }
        if symbol is StructSymbol aggregate {
            for current in aggregate.GetHierarchy() {
                for implemented in current.ImplementedClrInterfaces {
                    if implemented is ImportedTypeSymbol importedInterface {
                        yield importedInterface
                    }
                }
                for userInterface in current.Interfaces {
                    for projection in EnumerateInterfaceProjections(userInterface) {
                        yield projection
                    }
                }
                if current.ImportedBaseType is ImportedTypeSymbol importedBase {
                    yield importedBase
                }
            }
        }
        if symbol is InterfaceSymbol declaredInterface {
            for projection in EnumerateInterfaceProjections(declaredInterface) {
                yield projection
            }
        }
    }

    /// Review finding (#4068): the imported interfaces a G#-declared interface
    /// and its base interfaces extend.
    /// @param userInterface The declared interface, or `null`.
    /// @returns The imported constructions it carries.
    private func EnumerateInterfaceProjections(userInterface InterfaceSymbol?) sequence[ImportedTypeSymbol] {
        if userInterface == nil {
            yield break
        }
        for candidate in userInterface.SelfAndAllBaseInterfaces() {
            for importedBase in candidate.BaseClrInterfaces {
                if importedBase is ImportedTypeSymbol projection {
                    yield projection
                }
            }
        }
    }

    /// Review finding (#4068): the original single-projection walk, now applied
    /// to each projection (cref:EnumerateImportedProjections) yields.
    /// @param imported One imported construction.
    /// @param openDefinition The open generic definition sought.
    /// @param arguments The recovered symbolic arguments, on success.
    /// @returns `true` when the instantiation was recovered.
    private func TryGetSymbolicInstantiationFromImported(
        imported ImportedTypeSymbol,
        openDefinition Type,
        out arguments[]TypeSymbol?
    ) bool {
        arguments = Array.Empty[TypeSymbol?]()
        if imported.OpenDefinition is not{} symbolOpenDefinition || imported.TypeArguments.IsDefaultOrEmpty {
            return false
        }
        try {
            for candidate in EnumerateSelfBasesAndInterfaces(symbolOpenDefinition) {
                if !candidate.IsGenericType || !SameOpenDefinitionName(candidate, openDefinition) {
                    continue
                }
                let candidateArguments = candidate.GetGenericArguments()
                let recovered = [candidateArguments.Length]TypeSymbol?
                var complete = true
                for var k = 0; k < candidateArguments.Length; k++ {
                    let candidateArgument = candidateArguments[k]
                    if !candidateArgument.IsGenericParameter ||
                        candidateArgument.DeclaringType is not{} owner ||
                        !SameOpenDefinitionName(owner, symbolOpenDefinition) ||
                        candidateArgument.GenericParameterPosition >= imported
                        .TypeArguments
                        .Length {
                        complete = false
                        break
                    }
                    recovered[k] = imported.TypeArguments[candidateArgument.GenericParameterPosition]
                }
                if complete {
                    arguments = recovered
                    return true
                }
            }
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
        return false
    }

    /// Issue #4041: the open definition itself, its base chain, and its
    /// interface set — every place an instantiation of a sought open definition
    /// can be found.
    /// @param openDefinition The open generic definition to walk.
    /// @returns The candidate types.
    private func EnumerateSelfBasesAndInterfaces(openDefinition Type) sequence[Type] {
        yield openDefinition
        for var current Type? = openDefinition.BaseType; current != nil; current = current!!.BaseType {
            yield current
        }
        for interfaceType in openDefinition.GetInterfaces() {
            yield interfaceType
        }
    }

    /// Issue #4041: compares two generic types by their open definition's
    /// metadata full name, so a definition loaded in one reflection context
    /// matches the same definition loaded in another.
    /// @param left One type.
    /// @param right The other.
    /// @returns `true` when they name the same open definition.
    private func SameOpenDefinitionName(left Type?, right Type?) bool {
        if left == nil || right == nil {
            return false
        }
        try {
            let leftDefinition = if left.IsGenericType && !left.IsGenericTypeDefinition {
                left.GetGenericTypeDefinition()
            } else {
                left
            }
            let rightDefinition = if right.IsGenericType && !right.IsGenericTypeDefinition {
                right.GetGenericTypeDefinition()
            } else {
                right
            }
            return string.Equals(
                leftDefinition.FullName ?? leftDefinition.Name,
                rightDefinition.FullName ?? rightDefinition.Name,
                StringComparison.Ordinal
            )
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return false
        }
    }

    private func UserReferenceTypeErasedSymbolSatisfiesBaseConstraint(symbol StructSymbol, constraint Type?) bool {
        if constraint == nil || constraint.IsSameAs(typeof(object)) {
            return true
        }
        for current in symbol.GetHierarchy() {
            let importedBase Type? = current.ImportedBaseType?.ClrType
            if importedBase != nil {
                try {
                    return ClrTypeUtilities.IsAssignableByName(constraint, importedBase)
                } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                    return true
                }
            }
        }
        return false
    }

    private func TryCloseOverUserReferenceTypePlaceholders(
        openDef MethodInfo?,
        typeArgs[]?Type,
        recoveredSymbols ImmutableArray[TypeSymbol?],
        @NotNullWhen(true) out closed MethodInfo?
    ) bool {
        closed = nil
        if openDef == nil ||
            typeArgs == nil ||
            recoveredSymbols.IsDefaultOrEmpty ||
            recoveredSymbols.Length != typeArgs.Length ||
            !SatisfiesGenericConstraints(openDef, typeArgs, recoveredSymbols) {
            return false
        }
        let placeholders = cast[[]Type](typeArgs.Clone())
        var replaced = false
        for var i = 0; i < placeholders.Length; i++ {
            if recoveredSymbols[i] is not StructSymbol{IsClass: true, ClrType: nil} symbol {
                continue
            }
            var importedBase Type? = nil
            for current in symbol.GetHierarchy() {
                importedBase = current.ImportedBaseType?.ClrType
                if importedBase != nil {
                    break
                }
            }
            if importedBase == nil {
                continue
            }
            placeholders[i] = FindReferenceTypeConstraintPlaceholder(importedBase, openDef.GetGenericArguments()[i])
            replaced = true
        }
        if !replaced {
            return false
        }
        try {
            closed = openDef.MakeGenericMethod(placeholders)
            return true
        } catch (ArgumentException) {
            return false
        }
    }

    private func UnwrapArrayElement(type Type?) Type? {
        var type = type
        while type != nil && type.IsArray {
            let elementType Type? = type.GetElementType()
            if elementType == nil {
                return nil
            }
            type = elementType
        }
        return type
    }

    private func FindReferenceTypeConstraintPlaceholder(importedBase Type, genericParameter Type) Type {
        let special = genericParameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask
        if !importedBase.IsAbstract || (special & GenericParameterAttributes.DefaultConstructorConstraint) == 0 {
            return importedBase
        }
        try {
            for type in importedBase.Assembly.GetTypes() {
                if !type.IsAbstract && importedBase.IsAssignableFrom(type) && type.GetConstructor(Type.EmptyTypes) is {
                    IsPublic: true
                } {
                    return type
                }
            }
            return importedBase
        } catch (ex Exception) when IsMetadataLoadFailure(ex) || ex is ReflectionTypeLoadException {
            return importedBase
        }
    }

    /// Issue #1325: attempts to close [`openDef`](paramref) over a value-type
    /// placeholder for every type-argument slot whose CLR type was erased to a
    /// non-value-type placeholder but whose recovered symbol is a user value
    /// type (a non-class (cref:StructSymbol) or an (cref:EnumSymbol)).
    /// Succeeds only when at least one such slot exists, the recovered symbols
    /// satisfy the method's generic constraints, and the placeholder closure is
    /// accepted by (cref:MethodInfo.MakeGenericMethod(Type[])).
    /// @param openDef The open generic method definition.
    /// @param typeArgs The CLR type arguments (with user value types erased).
    /// @param recoveredSymbols The recovered symbolic type-argument vector, or default.
    /// @param closed On success, the method closed over the placeholder.
    /// @returns `true` when a placeholder closure was produced.
    private func TryCloseOverUserValueTypePlaceholders(
        openDef MethodInfo?,
        typeArgs[]?Type,
        recoveredSymbols ImmutableArray[TypeSymbol?],
        @NotNullWhen(true) out closed MethodInfo?
    ) bool {
        closed = nil
        if openDef == nil || typeArgs == nil || recoveredSymbols.IsDefaultOrEmpty {
            return false
        }
        let substituted = cast[[]Type](typeArgs.Clone())
        var anyUserValueType = false
        for var i = 0; i < substituted.Length && i < recoveredSymbols.Length; i++ {
            if substituted[i] != nil &&
                !substituted[i].IsValueType &&
                recoveredSymbols[i] is {} valueTypeSymbol &&
                IsValueTypeErasedSymbol(valueTypeSymbol) {
                substituted[i] = typeof(UserValueTypeConstraintPlaceholder)
                anyUserValueType = true
            }
        }
        if !anyUserValueType || !SatisfiesGenericConstraints(openDef, typeArgs, recoveredSymbols) {
            return false
        }
        try {
            closed = openDef.MakeGenericMethod(substituted)
        } catch (ArgumentException) {
            return false
        }
        return true
    }

    private func RewriteUserValueTypePlaceholder(type Type) Type -> SubstituteClrType(
        type,
        typeof(UserValueTypeConstraintPlaceholder),
        typeof(object)
    )

    /// Issue #1325: structurally rewrites every occurrence of
    /// [`from`](paramref) within [`type`](paramref) to
    /// [`to`](paramref), recursing through by-ref, array and constructed
    /// generic types. Used to map a placeholder-closed parameter type
    /// (e.g. `Span<Placeholder>`) back to the `object`-erased
    /// shape (`Span<object>`) for applicability.
    /// @param type The type to rewrite.
    /// @param from The type to replace.
    /// @param to The replacement type.
    /// @returns The rewritten type, or the original when no occurrence is found.
    private func SubstituteClrType(type Type, from Type, to Type) Type {
        if type == from {
            return to
        }
        if type.IsByRef {
            let elementType Type? = type.GetElementType()
            return if elementType == nil {
                type
            } else {
                SubstituteClrType(elementType, from, to).MakeByRefType()
            }
        }
        if type.IsPointer {
            let elementType Type? = type.GetElementType()
            return if elementType == nil {
                type
            } else {
                SubstituteClrType(elementType, from, to).MakePointerType()
            }
        }
        if type.IsArray {
            let sourceElement Type? = type.GetElementType()
            if sourceElement == nil {
                return type
            }
            let element = SubstituteClrType(sourceElement, from, to)
            let rank = type.GetArrayRank()
            return if rank == 1 {
                element.MakeArrayType()
            } else {
                element.MakeArrayType(rank)
            }
        }
        if type.IsGenericType && !type.IsGenericTypeDefinition {
            let args = type.GetGenericArguments()
            var changed = false
            for var i = 0; i < args.Length; i++ {
                let rewritten = SubstituteClrType(args[i], from, to)
                if !object.ReferenceEquals(rewritten, args[i]) {
                    args[i] = rewritten
                    changed = true
                }
            }
            return if changed {
                type.GetGenericTypeDefinition().MakeGenericType(args)
            } else {
                type
            }
        }
        return type
    }

    /// Issue #750 / ADR-0088: scores a single generic parameter's special
    /// constraints for the constraint-specificity tie-break.
    /// `where T : struct` dominates `where T : class` dominates
    /// no constraint. The two value-axis constraints are disjoint by
    /// construction so a strict ordering between them is well-defined.
    private func ConstraintSpecificityScore(attrs GenericParameterAttributes) int32 {
        let special = attrs & GenericParameterAttributes.SpecialConstraintMask
        if (special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 {
            return 2
        }
        if (special & GenericParameterAttributes.ReferenceTypeConstraint) != 0 {
            return 1
        }
        return 0
    }

    /// Issue #750 / ADR-0088: compares two candidates by the
    /// constraint-specificity ordering described in ADR-0088 §2. Returns
    /// `+1` when [`a`](paramref) is strictly more constrained
    /// than [`b`](paramref) (every type-parameter slot is at least as
    /// constrained on [`a`](paramref) and at least one slot is
    /// strictly more constrained), `-1` in the symmetric case, and
    /// `0` when neither dominates. Non-generic candidates and
    /// arity-mismatched pairs always tie — those are handled by the
    /// non-generic-over-generic phase that runs before this one.
    /// @param a The first candidate.
    /// @param b The second candidate.
    /// @returns +1, -1, or 0 per the description above.
    private func CompareConstraintSpecificity(a MethodBase, b MethodBase) int32 {
        if a is not MethodInfo ma || b is not MethodInfo mb {
            return 0
        }
        if !ma.IsGenericMethod || !mb.IsGenericMethod {
            return 0
        }
        var aOpen MethodInfo
        var bOpen MethodInfo
        try {
            aOpen = if ma.IsGenericMethodDefinition {
                ma
            } else {
                ma.GetGenericMethodDefinition()
            }
            bOpen = if mb.IsGenericMethodDefinition {
                mb
            } else {
                mb.GetGenericMethodDefinition()
            }
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return 0
        }
        var aParams[]Type
        var bParams[]Type
        try {
            aParams = aOpen.GetGenericArguments()
            bParams = bOpen.GetGenericArguments()
        } catch (ex Exception) when IsMetadataLoadFailure(ex) {
            return 0
        }
        if aParams.Length != bParams.Length {
            return 0
        }
        var aMore = false
        var bMore = false
        for var i = 0; i < aParams.Length; i++ {
            var s1 int32
            var s2 int32
            try {
                s1 = ConstraintSpecificityScore(aParams[i].GenericParameterAttributes)
                s2 = ConstraintSpecificityScore(bParams[i].GenericParameterAttributes)
            } catch (ex Exception) when IsMetadataLoadFailure(ex) {
                return 0
            }
            if s1 > s2 {
                aMore = true
            } else if s2 > s1 {
                bMore = true
            }
        }
        if aMore && !bMore {
            return 1
        }
        if bMore && !aMore {
            return -1
        }
        return 0
    }

    private func FormatTypeName(type Type?) string {
        if type == nil {
            return "<null>"
        }
        if type.IsByRef {
            return "ref " + FormatTypeName(type.GetElementType())
        }
        if type.IsArray {
            return FormatTypeName(type.GetElementType()) + "[]"
        }
        if type.IsGenericParameter {
            return type.Name
        }
        if type.IsGenericType {
            let def = type.GetGenericTypeDefinition()
            var defName = def.Name
            let tickIndex = defName.IndexOf('`')
            if tickIndex >= 0 {
                defName = defName.Substring(0, tickIndex)
            }
            let args = type.GetGenericArguments()
            let sb = StringBuilder()
            sb.Append(defName)
            sb.Append('[')
            for var i = 0; i < args.Length; i++ {
                if i > 0 {
                    sb.Append(", ")
                }
                sb.Append(FormatTypeName(args[i]))
            }
            sb.Append(']')
            return sb.ToString()
        }
        return type.Name
    }

    private func IsNumericWidening(source Type, target Type) bool {
        // Issue #1482: query the single authoritative lattice instead of a
        // second local copy. The previous local table lacked all native-int
        // (nint/nuint) rows, so overload "better conversion" ranking disagreed
        // with Conversion.Classify about native-int widening; routing through
        // the shared lattice fixes that divergence by construction.
        return NumericWideningLattice.IsWidening(source, target)
    }

    private func IsNullableWrap(source Type, target Type) bool {
        if !NullableLifting.IsValueTypeNullableClr(target) {
            return false
        }
        let underlying = target.GetGenericArguments()[0]
        return ClrTypeUtilities.AreSame(underlying, source)
    }

    /// Issue #3501 A5: whether [`source`](paramref) converts to
    /// [`target`](paramref) by identity or implicit reference
    /// conversion — the variance C# permits between a method group's
    /// signature and the target delegate's. Value types only convert by
    /// identity (no boxing variance in delegate signatures).
    private func IsVariantAssignable(target Type, source Type) bool {
        if target.IsSameAs(source) {
            return true
        }
        if source.IsValueType || target.IsValueType {
            return false
        }
        // Issue #3705 (family 3): both operands are method-group / delegate
        // signature slots, so one can be a host `typeof(...)` while the other
        // came from the compilation's MetadataLoadContext. Raw
        // IsAssignableFrom answers a silent `false` there, dropping the
        // candidate; the funnel falls back to the by-name walk.
        return ClrLoadContext.IsAssignable(target, source)
    }

    /// Issue #3681: decides whether [`source`](paramref) — one lower bound
    /// collected for a method type parameter — may be absorbed into
    /// [`target`](paramref), the other bound, when fixing that type
    /// parameter (C# §12.6.3.11). Only the <em>standard</em> implicit
    /// conversions C# admits at this point are accepted: identity, implicit
    /// numeric widening, reference upcasts (including interface satisfaction)
    /// and boxing. Deliberately excludes the contextual conversions
    /// (cref:ClassifyImplicit) also classifies (user-defined
    /// `op_Implicit`, interpolated-string handlers, the lambda/delegate
    /// shape conversions), none of which participate in fixing — admitting them
    /// would let genuinely conflicting bounds unify and would widen the
    /// applicable candidate set beyond what C# resolves.
    /// @param target The bound being promoted to.
    /// @param source The bound being absorbed.
    /// @returns `true` when the promotion is valid.
    private func IsInferenceBoundPromotion(target Type, source Type) bool -> switch ClassifyImplicit(target, source) {
        case ImplicitConversionKind.Identity: true
        case ImplicitConversionKind.NumericWidening: true
        case ImplicitConversionKind.Reference: true
        case ImplicitConversionKind.Boxing: true
        // The overload classifier ranks return covariance before reference
        // assignability. Keep actual CLR variance, not shape adapters.
        case ImplicitConversionKind.DelegateReturnCovariance: target.IsGenericType &&
            source.IsGenericType &&
            ClrTypeUtilities.AreSame(target.GetGenericTypeDefinition(), source.GetGenericTypeDefinition()) &&
            OpenExtensionReceiverStandardShapeMayApply(source, target, tupleElementConversions: false) &&
            IsVariantAssignable(target, source)
        default: false
    }

    private func UnifyUpperBoundForInference(
        parameterType Type,
        argumentType Type,
        bounds Dictionary[string, Type]
    ) bool {
        if !parameterType.IsGenericParameter {
            return UnifyForInference(parameterType, argumentType, bounds)
        }
        if !bounds.TryGetValue(parameterType.Name, out var existing) {
            bounds[parameterType.Name] = argumentType
            return true
        }
        if ClrTypeUtilities.AreSame(existing, argumentType) {
            return true
        }
        try {
            // A type still being defined cannot answer `IsAssignableFrom`; leave it to the
            // classifier below without paying for the thrown (cref:NotSupportedException).
            if !ClrTypeUtilities.IsTypeBuilderInstantiation(existing) && !ClrTypeUtilities.IsTypeBuilderInstantiation(
                argumentType
            ) {
                if existing.IsAssignableFrom(argumentType) {
                    bounds[parameterType.Name] = argumentType
                    return true
                }
                if argumentType.IsAssignableFrom(existing) {
                    return true
                }
            }
        } catch (InvalidOperationException) {
            // Cross-context types are compared by the shared classifier below.

        }
        if IsInferenceBoundPromotion(existing, argumentType) {
            bounds[parameterType.Name] = argumentType
            return true
        }
        return IsInferenceBoundPromotion(argumentType, existing)
    }

    private func UnifyForInference(parameterType Type?, argumentType Type?, bounds Dictionary[string, Type]) bool {
        if parameterType == nil || argumentType == nil {
            return true
        }
        if parameterType.IsGenericParameter {
            if bounds.TryGetValue(parameterType.Name, out var existing) {
                if ClrTypeUtilities.AreSame(existing, argumentType) {
                    return true
                }
                // Issue #661: when one bound is T and the other is Nullable<T>
                // (where T is any value type, including enums), promote to
                // Nullable<T> — mirroring C#'s inference rule that picks the
                // nullable form when both T and T? are lower bounds.
                if NullableLifting.IsValueTypeNullableClr(argumentType) {
                    let underlying = argumentType.GetGenericArguments()[0]
                    if ClrTypeUtilities.AreSame(underlying, existing) {
                        bounds[parameterType.Name] = argumentType
                        return true
                    }
                }
                if NullableLifting.IsValueTypeNullableClr(existing) {
                    let underlying = existing.GetGenericArguments()[0]
                    if ClrTypeUtilities.AreSame(underlying, argumentType) {
                        // existing is already Nullable<T>; keep it.
                        return true
                    }
                }
                // Promote toward the common base: keep the more general type
                // when one is assignable from the other. Otherwise the bounds
                // genuinely conflict and inference fails.
                try {
                    // A type still being defined cannot answer `IsAssignableFrom`; leave it
                    // to the classifier below without paying for the thrown
                    // (cref:NotSupportedException).
                    if !ClrTypeUtilities.IsTypeBuilderInstantiation(existing) &&
                        !ClrTypeUtilities
                        .IsTypeBuilderInstantiation(argumentType) {
                        if existing.IsAssignableFrom(argumentType) {
                            return true
                        }
                        if argumentType.IsAssignableFrom(existing) {
                            bounds[parameterType.Name] = argumentType
                            return true
                        }
                    }
                } catch (InvalidOperationException) {
                    // MLC cross-context: fall through to the classifier below,
                    // which compares by name and is safe across contexts.

                }
                // Issue #3681: C# fixing (§12.6.3.11) resolves a type parameter
                // to the unique bound that every other bound converts to
                // *implicitly* — not merely by reference assignment.
                // `Type.IsAssignableFrom` above models neither boxing
                // (`Assert.Equal<T>(TimeSpan, object)`, where C# fixes
                // T = object) nor implicit numeric widening
                // (`Assert.Equal<T>(2, byteValue)`, where C# fixes T = int),
                // and it silently answers false whenever the two bounds were
                // loaded through different reflection contexts — a host
                // `System.Object` against a reference-context `TimeSpan`. Retry
                // through this file's own classifier, which compares by name
                // (cross-context safe) and is restricted here to the standard
                // conversions C# admits when fixing.
                if IsInferenceBoundPromotion(existing, argumentType) {
                    return true
                }
                if IsInferenceBoundPromotion(argumentType, existing) {
                    bounds[parameterType.Name] = argumentType
                    return true
                }
                return false
            }
            bounds[parameterType.Name] = argumentType
            return true
        }
        if parameterType.IsByRef {
            return UnifyForInference(
                parameterType.GetElementType(),
                if argumentType.IsByRef {
                    argumentType.GetElementType()
                } else {
                    argumentType
                },
                bounds
            )
        }
        if parameterType.IsPointer {
            if argumentType.IsPointer {
                return UnifyForInference(parameterType.GetElementType(), argumentType.GetElementType(), bounds)
            }
            return true
        }
        if parameterType.IsArray {
            if argumentType.IsArray {
                UnifyForInference(parameterType.GetElementType(), argumentType.GetElementType(), bounds)
            }
            // If the argument isn't an array, the classifier will reject the
            // candidate later; inference itself doesn't fail.
            return true
        }
        if IsStructurallyInferrableDelegate(parameterType, argumentType) {
            if !ClrLoadContext.TryGetDelegateSignature(
                parameterType,
                out var parameterDelegateParameters,
                out var parameterDelegateReturn
            ) ||
                !ClrLoadContext.TryGetDelegateSignature(
                argumentType,
                out var argumentDelegateParameters,
                out var argumentDelegateReturn
            ) ||
                parameterDelegateParameters.Length != argumentDelegateParameters.Length {
                return true
            }
            for var i = 0; i < parameterDelegateParameters.Length; i++ {
                if !UnifyUpperBoundForInference(parameterDelegateParameters[i], argumentDelegateParameters[i], bounds) {
                    return false
                }
            }
            // Issue #1531: a void-returning source delegate/method-group must not
            // make a value-returning delegate parameter whose return is (or
            // contains) a method type parameter applicable. C# forbids inferring
            // a type argument from a void return, so a `(...)->TResult` overload
            // is not applicable when the supplied delegate returns void. Failing
            // inference here prunes that overload, leaving a `(...)->void`
            // overload as the unique match instead of a spurious GS0266.
            if parameterDelegateReturn != nil && argumentDelegateReturn != nil && string.Equals(
                argumentDelegateReturn.FullName,
                "System.Void",
                StringComparison.Ordinal
            ) &&
                !string.Equals(parameterDelegateReturn.FullName, "System.Void", StringComparison.Ordinal) &&
                parameterDelegateReturn.ContainsGenericParameters {
                return false
            }
            return UnifyForInference(parameterDelegateReturn, argumentDelegateReturn, bounds)
        }
        if parameterType.IsGenericType && !parameterType.IsGenericTypeDefinition {
            let openDef = parameterType.GetGenericTypeDefinition()
            let paramArgs = parameterType.GetGenericArguments()
            // Issue #2142: an expression-tree parameter Expression<TDelegate>
            // never matches a delegate argument's class hierarchy (a Func<…> is
            // not an Expression<…>), so FindClosedGeneric below returns null and
            // any method type parameter mentioned only inside TDelegate (e.g.
            // HasOne<TRelated>(Expression<Func<TEntity, TRelated?>>)) would never
            // be inferred. Unwrap the expression tree and unify its delegate type
            // argument directly against the supplied delegate argument.
            if string.Equals(openDef.FullName, "System.Linq.Expressions.Expression`1", StringComparison.Ordinal) &&
                paramArgs.Length == 1 &&
                ClrTypeUtilities.IsDelegateType(argumentType) {
                return UnifyForInference(paramArgs[0], argumentType, bounds)
            }
            // Find the argument type (or any of its base types or interfaces)
            // matching the parameter's open generic definition. Walk class
            // hierarchy first, then interfaces.
            let matched Type? = FindClosedGeneric(argumentType, openDef)
            // Issue #3877 / ADR-0174 D2: the channel direction lattice is the
            // one implicit conversion G# admits between two *distinct* closed
            // generic CLR types. A `chan[T]` is a `Channel<T>` (or the runtime's
            // `Chan<T>`) and views as `ChannelReader<T>` / `ChannelWriter<T>`
            // through `get_Reader` / `get_Writer` — but no base class or
            // interface links those three, so the hierarchy walk above finds
            // nothing and a method type parameter mentioned only inside the
            // channel formal (`CountSoFar<T>(this ChannelReader<T>)`) received
            // no bound at all. Inference then failed outright and the candidate
            // never reached the applicability pass, which has classified this
            // conversion correctly since #3981. Contribute the element as a
            // bound; whether the DIRECTION is legal is not inference's call —
            // `Conversion` owns the lattice, and applicability
            // (structuralProjectionArgumentCheck) still rejects an `out chan[T]`
            // source against a `ChannelReader<T>` formal.
            if matched == nil &&
                paramArgs.Length == 1 &&
                TryGetChannelViewElement(openDef, argumentType, out var channelElement) {
                return UnifyForInference(paramArgs[0], channelElement, bounds)
            }
            if matched != nil {
                let matchedArgs = matched.GetGenericArguments()
                let genericParameters = openDef.GetGenericArguments()
                for var i = 0; i < paramArgs.Length && i < matchedArgs.Length; i++ {
                    let variance = if i < genericParameters.Length {
                        genericParameters[i].GenericParameterAttributes & GenericParameterAttributes.VarianceMask
                    } else {
                        GenericParameterAttributes.None
                    }
                    let unified = if variance == GenericParameterAttributes.Contravariant {
                        UnifyUpperBoundForInference(paramArgs[i], matchedArgs[i], bounds)
                    } else {
                        UnifyForInference(paramArgs[i], matchedArgs[i], bounds)
                    }
                    if !unified {
                        return false
                    }
                }
            }
            // If no matching closed generic is found we don't fail inference
            // here — the applicability pass will reject the candidate.
            return true
        }
        return true
    }

    /// Issue #3982 / ADR-0174 D2: true when a channel argument reaches a
    /// channel formal through the direction lattice once BOTH sides are read
    /// at the erasure the candidate was closed over.
    /// @remarks Applicability ranks imported candidates on CLR shapes, and an
    /// element declared in the current compilation has none —
    /// `MemberLookup.TryProjectErasedClrType` presents `Pair` as
    /// `object`, so `CountSoFar[T](this ChannelReader[T])` closes to
    /// `ChannelReader<object>`. Every other structural shape
    /// survives that because the CLR relation still holds at the erased level
    /// (`[]Pair` is `object[]`, which really does convert to
    /// `IEnumerable<object>`). A channel's only implicit
    /// non-identity relation is the D2 lattice, which demands element
    /// IDENTITY, so the real `chan[Pair]` compared against the erased
    /// `ChannelReader[object]` was refused and the candidate dropped.
    ///
    /// The lattice is not restated here: `Conversion` is still the
    /// one asked, on the two ERASED shapes rather than on one erased and one
    /// real, so direction and element remain its decisions.
    /// [`argumentType`](paramref) is already the erased source — it is
    /// what `GetEffectiveArgumentClrTypeForOverloadResolution` produced —
    /// so this compares like with like rather than widening anything.
    ///
    /// <b>Why the slot gate.</b> At the erased level an element with no
    /// CLR identity is indistinguishable from a GENUINE `object`. Without
    /// the gate a non-generic `M(ChannelReader<object>)` declared
    /// beside a valid `M[T](ChannelReader[T])` also became applicable,
    /// and betterness prefers the concrete overload — so merely ADDING an
    /// `object` overload to a library turned the repaired call back into
    /// a diagnostic. Only a slot whose OPEN declaration mentions a generic
    /// parameter can have acquired its `object` by erasure, so only such
    /// a slot may be answered here; a non-generic member on a non-generic type
    /// keeps the answer `Conversion` gives on the real types, which is
    /// "no".
    ///
    /// <b>Issue #3989 (review finding 3) corrects what this paragraph
    /// used to say.</b> The declaring-type case was described here as
    /// deliberately slot-BLIND — a constructor on a generic class closed over
    /// the erased placeholder admitting every slot, "because the corresponding
    /// open member is not addressable from a (cref:ConstructorInfo)
    /// across reflection contexts". It IS addressable: #3984's
    /// base-initializer projection locates it by metadata token on the open
    /// definition, and (cref:TryGetOpenParameterType) now does the same
    /// for any (cref:MethodBase). So a slot on a generic class is
    /// answered as precisely as one on a generic method, and a genuine
    /// `ChannelReader[object]` parameter on a generic class is refused at
    /// applicability rather than a few steps later by
    /// `BindClrParameterConversions`. Recorded as ADR-0174 errata 45. Only
    /// a slot the open declaration cannot be found for keeps the old
    /// slot-blind answer.
    /// @param rawCandidate The candidate as declared, before generic closing.
    /// @param parameterIndex The parameter position this argument fills.
    /// @param parameterType The closed parameter type.
    /// @param argumentType The erased argument type.
    /// @returns True when the erased pair is an implicit channel view.
    private func ChannelViewAppliesAtErasedGenericSlot(
        rawCandidate MethodBase?,
        parameterIndex int32,
        parameterType Type?,
        argumentType Type?
    ) bool {
        if rawCandidate == nil ||
            parameterType == nil ||
            argumentType == nil ||
            parameterType.IsByRef ||
            !IsErasedGenericParameterSlot(rawCandidate, parameterIndex) {
            return false
        }
        let argumentSymbol TypeSymbol? = TypeSymbol.FromClrTypeWithoutNullability(
            argumentType,
            NullabilityFreeReason.IdentityComparison
        )
        let parameterSymbol TypeSymbol? = TypeSymbol.FromClrTypeWithoutNullability(
            parameterType,
            NullabilityFreeReason.IdentityComparison
        )
        return argumentSymbol != nil && parameterSymbol != nil && ChannelTypeSymbol.TryGetChannelShape(
            argumentSymbol,
            out _,
            out _,
            out _
        ) &&
            ChannelTypeSymbol.TryGetChannelShape(parameterSymbol, out _, out _, out _) &&
            Conversion
            .ClassifyNonStructural(argumentSymbol, parameterSymbol).IsImplicit
    }

    /// Issue #3982 / #3989: whether the candidate's parameter at
    /// [`parameterIndex`](paramref) could have acquired its closed shape
    /// by type-argument erasure rather than by being declared that way.
    /// @remarks One question, asked by two gates of opposite polarity:
    /// `ChannelViewAppliesAtErasedGenericSlot` ADDS applicability where the
    /// answer is yes, and the #3989 erased-argument check REMOVES it where the
    /// answer is no. Both read the candidate's OPEN declaration through
    /// (cref:TryGetOpenParameterType); a slot whose open declaration
    /// cannot be located stays "possibly erased", which is the permissive
    /// direction for the channel gate and the safe one for #3989's.
    ///
    /// <b>Issue #4026 narrows the "yes" by one case.</b> "Could have
    /// acquired its closed shape by erasure" is false when the call site PINNED
    /// the slot's method type parameters itself, with type arguments that have a
    /// CLR identity of their own. `Probes.CountAny[ImportedBase](List[Derived])`
    /// closes `CountAny[T](List[T])` over a real `ImportedBase`, so the
    /// parameter really is the INVARIANT `List<ImportedBase>` and the
    /// argument's `List<object>` surrogate did not come from erasing
    /// anything on the parameter side. Waving it through emitted a MethodSpec
    /// closed over `ImportedBase` with a raw `List<Derived>`
    /// pushed at it: ILVerify `StackUnexpected`. An explicit type argument
    /// that is itself a SURROGATE (a same-compilation class arriving as its
    /// imported base — #4016) is not genuine and keeps the slot erased, which is
    /// what makes the #4016 rows go on binding.
    ///
    /// The verdict is per SLOT, never per nested position: the question is
    /// whether the open parameter mentions any generic parameter this call did
    /// not genuinely pin, and a class-level parameter never counts as pinned.
    /// Reading the open declaration position by position was implemented and
    /// REVERTED once already (#3989):
    /// `Task.ContinueWith[TResult](Func[Task, TResult])` has one concrete
    /// nested position beside one open one.
    /// @param rawCandidate The candidate as declared, before generic closing.
    /// @param parameterIndex The parameter position.
    /// @param explicitTypeArgIsGenuine Issue #4026: one flag per explicit method type argument, true when
    /// it
    /// names a type with a CLR identity of its own. Null keeps every generic
    /// slot "possibly erased".
    /// @returns True when the slot is generic in the declaration.
    private func IsErasedGenericParameterSlot(
        rawCandidate MethodBase,
        parameterIndex int32,
        explicitTypeArgIsGenuine IReadOnlyList[bool]? = nil
    ) bool {
        let openParameterType Type? = TryGetOpenParameterType(rawCandidate, parameterIndex)
        if openParameterType == nil {
            return true
        }
        if !openParameterType.ContainsGenericParameters {
            return false
        }
        return explicitTypeArgIsGenuine == nil ||
            MentionsUnpinnedGenericParameter(openParameterType, explicitTypeArgIsGenuine)
    }

    /// Issue #4026: whether [`openType`](paramref) mentions any generic
    /// parameter the call site did not pin with a genuine explicit type
    /// argument.
    /// @remarks A CLASS-level parameter (`DeclaringMethod == null`) is never pinned
    /// by a call's explicit METHOD type-argument list, and
    /// (cref:TryGetOpenParameterType) deliberately reads a member on a
    /// constructed generic class through its open declaring type — so
    /// `List[T].Add(T)` stays "possibly erased" whatever the call spelled.
    /// @param openType The open parameter type.
    /// @param explicitTypeArgIsGenuine The per-position genuineness flags.
    /// @returns True when some mentioned parameter is not genuinely pinned.
    private func MentionsUnpinnedGenericParameter(openType Type, explicitTypeArgIsGenuine IReadOnlyList[bool]) bool {
        if openType.IsGenericParameter {
            if openType.DeclaringMethod == nil {
                return true
            }
            let position = openType.GenericParameterPosition
            return uint32(position) >= uint32(explicitTypeArgIsGenuine.Count) || !explicitTypeArgIsGenuine[position]
        }
        if openType.HasElementType {
            let element Type? = openType.GetElementType()
            return element == nil || MentionsUnpinnedGenericParameter(element, explicitTypeArgIsGenuine)
        }
        if openType.IsGenericType {
            for argument in openType.GetGenericArguments() {
                if MentionsUnpinnedGenericParameter(argument, explicitTypeArgIsGenuine) {
                    return true
                }
            }
        }
        return false
    }

    /// Issue #3989: the candidate's parameter type as its DECLARATION spells it,
    /// with the declaring type's and the method's own generic parameters still
    /// present.
    /// @remarks A member on a CONSTRUCTED generic type always goes through the open
    /// declaring type, even when it is itself a generic method definition: on
    /// the constructed type the class-level parameters have already been closed
    /// over the erased placeholder, so `M[U](List[T], List[U])` would read
    /// back as `M[U](List<object>, List<!!U>)` and its first
    /// slot would look concrete when it is not.
    /// @param rawCandidate The candidate as declared, before generic closing.
    /// @param parameterIndex The parameter position.
    /// @returns The open parameter type, or `null` when it cannot be located.
    private func TryGetOpenParameterType(rawCandidate MethodBase, parameterIndex int32) Type? {
        var parameters[]?ParameterInfo
        if rawCandidate.DeclaringType is {
            IsGenericType: true,
            IsGenericTypeDefinition: false
        } constructedDeclaringType {
            // Issue #3989: #3982 answered "possibly erased" for EVERY slot on a
            // constructed generic class, on the belief that the corresponding
            // OPEN member is not addressable from a `ConstructorInfo` across
            // reflection contexts. It is — #3984's base-initializer projection
            // locates it by metadata token on the open definition.
            parameters = TryGetOpenDeclaringTypeMemberParameters(rawCandidate, constructedDeclaringType)
        } else if rawCandidate is MethodInfo{IsGenericMethodDefinition: true} openMethod {
            parameters = openMethod.GetParameters()
        } else {
            parameters = rawCandidate.GetParameters()
        }
        return if parameters != nil && uint32(parameterIndex) < uint32(parameters.Length) {
            parameters[parameterIndex].ParameterType
        } else {
            default(Type?)
        }
    }

    /// Issue #3989: finds [`rawCandidate`](paramref) on its declaring
    /// type's OPEN generic definition, whose parameter types still mention the
    /// type's own generic parameters.
    /// @remarks Matching by (cref:MemberInfo.MetadataToken) plus
    /// (cref:MemberInfo.Module) is what makes this work across a
    /// `MetadataLoadContext` boundary, where the open definition's members
    /// are not reference-equal to the constructed type's. The same technique
    /// `DeclarationBinder.TryGetOpenBaseConstructorParameters` uses.
    /// @param rawCandidate The candidate as declared, on the constructed type.
    /// @param constructedDeclaringType The candidate's constructed declaring type.
    /// @returns The open member's parameters, or `null`.
    private func TryGetOpenDeclaringTypeMemberParameters(
        rawCandidate MethodBase,
        constructedDeclaringType Type
    )[]?ParameterInfo {
        try {
            let openDefinition = constructedDeclaringType.GetGenericTypeDefinition()
            const Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static
            return (
                ClrTypeUtilities.FindMetadataDefinition(
                    openDefinition,
                    rawCandidate,
                    Flags,
                    safeEnumeration: true
                ) as MethodBase
            )?.GetParameters()
        } catch (InvalidOperationException) {
            // A dynamic or otherwise token-less member: fall back to the
            // slot-blind answer above.

        } catch (NotSupportedException) {
            // Same, for a reflection context that refuses metadata tokens.

        }
        return nil
    }

    /// Issue #3877 / ADR-0174 D2: yields a channel-shaped argument's element
    /// type when the formal is itself channel-shaped, so method type inference
    /// can see through the direction lattice's view conversions.
    /// @remarks Deliberately direction-blind. Inference's job is to produce a bound, not
    /// to decide whether the source may flow to the formal; the lattice lives in
    /// `Conversion` and is enforced by the applicability pass, exactly as
    /// C# separates §12.6.3 inference from §12.6.4 applicability.
    /// @param openFormalDefinition The formal parameter's open generic definition.
    /// @param argumentType The supplied argument's CLR type.
    /// @param elementType The argument channel's element type.
    /// @returns True when both sides are channel-shaped.
    private func TryGetChannelViewElement(
        openFormalDefinition Type,
        argumentType Type,
        @NotNullWhen(true) out elementType Type?
    ) bool {
        elementType = nil
        if !ChannelTypeSymbol.IsChannelClrDefinitionName(openFormalDefinition.FullName) ||
            !argumentType.IsGenericType ||
            argumentType.IsGenericTypeDefinition {
            return false
        }
        var argumentDefinition Type
        var argumentArguments[]Type
        try {
            argumentDefinition = argumentType.GetGenericTypeDefinition()
            argumentArguments = argumentType.GetGenericArguments()
        } catch (NotSupportedException) {
            // TypeBuilderInstantiation and other cross-context constructions may
            // refuse to describe themselves; there is simply nothing to infer.
            return false
        }
        if argumentArguments.Length != 1 || !ChannelTypeSymbol.IsChannelClrDefinitionName(argumentDefinition.FullName) {
            return false
        }
        elementType = argumentArguments[0]
        return true
    }

    private func IsStructurallyInferrableDelegate(parameterType Type?, argumentType Type?) bool {
        if parameterType == nil || argumentType == nil {
            return false
        }
        if !parameterType.ContainsGenericParameters || !ClrTypeUtilities.IsDelegateType(parameterType) ||
            !ClrTypeUtilities.IsDelegateType(argumentType) {
            return false
        }
        if parameterType.IsGenericType &&
            argumentType.IsGenericType &&
            MatchesOpenDefinition(
            argumentType.GetGenericTypeDefinition(),
            parameterType.GetGenericTypeDefinition(),
            parameterType.GetGenericTypeDefinition().FullName
        ) {
            return false
        }
        return true
    }

    private func FindClosedGeneric(type Type, openDefinition Type?) Type? {
        if openDefinition == nil {
            return nil
        }
        let openDefName = openDefinition.FullName
        try {
            var current Type? = type
            while current != nil {
                if current.IsGenericType &&
                    MatchesOpenDefinition(current.GetGenericTypeDefinition(), openDefinition, openDefName) {
                    return current
                }
                current = current.BaseType
            }
        } catch (NotSupportedException) {
            // TypeBuilderInstantiation (cross-context constructed generics) may
            // throw on BaseType traversal; fall through to interface walk.

        }
        // Like symbolic hierarchy inference, multiple instantiations contribute
        // no bound: another argument must fix the slot before applicability.
        var matched Type? = nil
        let ifaces = ClrTypeUtilities.SafeGetInterfaces(type)
        for iface in ifaces {
            if iface.IsGenericType &&
                MatchesOpenDefinition(iface.GetGenericTypeDefinition(), openDefinition, openDefName) {
                if matched != nil && !ClrTypeUtilities.AreSame(matched, iface) {
                    return nil
                }
                matched = iface
            }
        }
        return matched ?? FindClosedGenericFromDefinition(type, openDefinition, openDefName)
    }

    private func FindClosedGenericFromDefinition(type Type?, openDefinition Type, openDefinitionName string?) Type? {
        if type == nil || !type.IsGenericType || type.IsGenericTypeDefinition {
            return nil
        }
        try {
            let definition = type.GetGenericTypeDefinition()
            let parameters = definition.GetGenericArguments()
            let arguments = type.GetGenericArguments()
            let Project = func (candidate Type) Type? {
                if !candidate.IsGenericType ||
                    !MatchesOpenDefinition(candidate.GetGenericTypeDefinition(), openDefinition, openDefinitionName) {
                    return nil
                }
                var projected = candidate
                for var i = 0; i < parameters.Length; i++ {
                    projected = SubstituteClrType(projected, parameters[i], arguments[i])
                }
                return projected
            }
            var matched Type? = nil
            for candidate in definition.GetInterfaces() {
                let projected Type? = Project(candidate)
                if projected != nil {
                    if matched != nil && !ClrTypeUtilities.AreSame(matched, projected) {
                        return nil
                    }
                    matched = projected
                }
            }
            for var candidate Type? = definition.BaseType; candidate != nil; candidate = candidate!!.BaseType {
                let projected Type? = Project(candidate)
                if projected != nil {
                    if matched != nil && !ClrTypeUtilities.AreSame(matched, projected) {
                        return nil
                    }
                    matched = projected
                }
            }
            return matched
        } catch (ex Exception) when IsMetadataLoadFailure(ex) || ex is ArgumentException {
            return nil
        }
    }

    /// Issue #666: compares a candidate open generic type definition against
    /// [`openDefinition`](paramref). Uses (cref:object.ReferenceEquals)
    /// first (fast path for same-context types), then falls back to
    /// (cref:Type.FullName) comparison for cross-reflection-context
    /// scenarios (e.g. a host-runtime `Func<,>` vs a
    /// MetadataLoadContext `Func<,>`).
    private func MatchesOpenDefinition(candidateDefinition Type, openDefinition Type, openDefName string?) bool {
        if object.ReferenceEquals(candidateDefinition, openDefinition) {
            return true
        }
        // Cross-context fallback: same FullName implies structural equivalence
        // for open generic definitions.
        return openDefName != nil && string.Equals(candidateDefinition.FullName, openDefName, StringComparison.Ordinal)
    }
}
