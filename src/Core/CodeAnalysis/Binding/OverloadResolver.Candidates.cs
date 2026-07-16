// <copyright file="OverloadResolver.Candidates.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#pragma warning disable SA1611 // Element parameters should be documented
#pragma warning disable SA1615 // Element return value should be documented
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Documentation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis.Binding;

internal sealed partial class OverloadResolver
{
    public FunctionSymbol SelectInstanceOverloadOrReport(
        ImmutableArray<FunctionSymbol> overloads,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        string methodName,
        ImmutableArray<string> argumentNames)
    {
        if (overloads.Length <= 1)
        {
            return overloads.Length == 1 ? overloads[0] : null;
        }

        // Issue #1124: a call may carry an explicit method type-argument list
        // (e.g. `Factory.Make[Box](...)`). Thread its arity into overload
        // selection so generic candidates are filtered for applicability against
        // either the explicit type arguments or, in their absence, type inference.
        var explicitTypeArgCount = ce.TypeArgumentList?.Arguments.Count ?? 0;
        var selected = SelectBestInstanceOverload(overloads, arguments.Length, argumentNames, arguments, out var ambiguous, out var nullSafetyFailure, explicitTypeArgCount);
        if (selected != null)
        {
            return selected;
        }

        if (nullSafetyFailure != null)
        {
            var argLoc = nullSafetyFailure.Index < ce.Arguments.Count
                ? ce.Arguments[nullSafetyFailure.Index].Location
                : ce.Identifier.Location;
            Diagnostics.ReportWrongArgumentType(argLoc, nullSafetyFailure.ParamName, nullSafetyFailure.ParamType, nullSafetyFailure.ArgType);
        }
        else if (ambiguous)
        {
            Diagnostics.ReportAmbiguousOverloadResolution(ce.Identifier.Location, methodName);
        }
        else
        {
            Diagnostics.ReportNoApplicableOverload(ce.Identifier.Location, methodName);
        }

        return null;
    }

    /// <summary>
    /// Issue #1147: builds the <em>unified</em> instance + static (<c>shared</c>)
    /// method group for <paramref name="structSym"/>.<paramref name="methodName"/>
    /// and selects the single best applicable overload across BOTH buckets,
    /// reporting the standard ambiguity / no-applicable-overload diagnostics. This
    /// implements C#'s combined instance+static overload resolution that both the
    /// "Color Color" receiver-disambiguation (ECMA-334 §12.8.7.1) and an
    /// unqualified same-named call inside an instance method reduce to. The
    /// selected method's <see cref="FunctionSymbol.IsStatic"/> tells the caller
    /// whether to finalize the call as an instance or a static dispatch.
    /// </summary>
    /// <param name="structSym">The user struct/class whose method group is searched.</param>
    /// <param name="methodName">The invoked method name.</param>
    /// <param name="arguments">The already-bound call arguments.</param>
    /// <param name="ce">The originating call syntax (for diagnostic locations / type-arg arity).</param>
    /// <param name="argumentNames">The named-argument layout, or default.</param>
    /// <param name="hasCandidates">Set to <see langword="true"/> when the union
    /// was non-empty. When this is <see langword="false"/> the caller should fall
    /// through to its existing not-found path so a genuinely-undefined name still
    /// reports GS0130.</param>
    /// <returns>The selected overload, or <see langword="null"/> (after a
    /// diagnostic) when the non-empty union had no applicable overload.</returns>
    public FunctionSymbol SelectUnifiedInstanceStaticOverload(
        StructSymbol structSym,
        string methodName,
        ImmutableArray<BoundExpression> arguments,
        CallExpressionSyntax ce,
        ImmutableArray<string> argumentNames,
        out bool hasCandidates)
    {
        var instanceGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Instance(MemberKinds.Method));
        var staticGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Static(MemberKinds.Method));
        var unified = instanceGroup.IsDefaultOrEmpty
            ? staticGroup
            : staticGroup.IsDefaultOrEmpty
                ? instanceGroup
                : instanceGroup.AddRange(staticGroup);

        hasCandidates = !unified.IsDefaultOrEmpty;
        if (!hasCandidates)
        {
            return null;
        }

        return SelectInstanceOverloadOrReport(unified, arguments, ce, methodName, argumentNames);
    }

    private FunctionSymbol SelectBestUserOverload(
        ImmutableArray<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<string> argumentNames,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        out bool ambiguous,
        out NullSafetyArgumentMismatch nullSafetyFailure,
        int explicitTypeArgCount = 0)
    {
        return SelectBestUserOverloadCore(candidates, argumentCount, argumentNames, boundArguments, out ambiguous, out nullSafetyFailure, explicitTypeArgCount);
    }

    /// <summary>
    /// ADR-0063 §6: instance-method overload selection. Filters a candidate set
    /// of methods (each may or may not carry an explicit receiver parameter) by
    /// callable arity, named-argument compatibility, and optional-parameter
    /// applicability, then ranks by exact-type matches and defaulted slots.
    /// </summary>
    public FunctionSymbol SelectBestInstanceOverload(
        ImmutableArray<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<string> argumentNames,
        ImmutableArray<BoundExpression> boundArguments,
        out bool ambiguous,
        out NullSafetyArgumentMismatch nullSafetyFailure,
        int explicitTypeArgCount = 0)
    {
        ambiguous = false;
        nullSafetyFailure = null;
        if (candidates.Length == 0)
        {
            return null;
        }

        if (candidates.Length == 1)
        {
            return candidates[0];
        }

        var builder = ImmutableArray.CreateBuilder<BoundExpression>(boundArguments.Length);
        builder.AddRange(boundArguments);
        return SelectBestUserOverloadCore(candidates, argumentCount, argumentNames, builder, out ambiguous, out nullSafetyFailure, explicitTypeArgCount);
    }

    private FunctionSymbol SelectBestUserOverloadCore(
        ImmutableArray<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<string> argumentNames,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        out bool ambiguous,
        out NullSafetyArgumentMismatch nullSafetyFailure,
        int explicitTypeArgCount = 0)
    {
        ambiguous = false;
        nullSafetyFailure = null;

        // Issue #1632: the #1124 applicability filter and the Phase-2 scoring
        // below both infer a generic candidate's method-type-parameter
        // substitution from the SAME (candidate, boundArguments, argumentCount)
        // inputs. Memoize per candidate for this call so unification runs once
        // instead of twice per generic candidate.
        var substitutionCache = new Dictionary<FunctionSymbol, (bool Ok, Dictionary<TypeParameterSymbol, TypeSymbol> Substitution)>();

        // Phase 1: applicability.
        var applicable = new List<FunctionSymbol>();
        foreach (var cand in candidates)
        {
            if (IsApplicableUserCallable(cand, argumentCount, argumentNames))
            {
                applicable.Add(cand);
            }
        }

        // Issue #1124: a generic candidate whose method type parameters cannot be
        // determined for the call is not applicable (C# §11.6.4.2 "if type
        // inference fails, the method is not a candidate"). Without an explicit
        // type-argument list this means every type parameter must be inferable
        // from the argument types; with an explicit list it means the candidate
        // must be generic of matching arity (a non-generic overload cannot accept
        // type arguments). Dropping such candidates here prevents a uninferable
        // generic overload from tying with — and thus being reported ambiguous
        // (GS0266) against — an otherwise-unique non-generic best match.
        if (applicable.Count > 1)
        {
            var filtered = new List<FunctionSymbol>(applicable.Count);
            foreach (var cand in applicable)
            {
                if (explicitTypeArgCount > 0)
                {
                    if (cand.IsGeneric && cand.TypeParameters.Length == explicitTypeArgCount)
                    {
                        filtered.Add(cand);
                    }
                }
                else if (cand.IsGeneric)
                {
                    if (GetCachedCandidateSubstitution(cand, boundArguments, argumentCount, substitutionCache, out _))
                    {
                        filtered.Add(cand);
                    }
                }
                else
                {
                    filtered.Add(cand);
                }
            }

            // Only adopt the filtered set when it leaves at least one candidate;
            // an empty result means the call shape is genuinely unsatisfiable and
            // the pre-existing diagnostics on the unfiltered set are preferable.
            if (filtered.Count > 0)
            {
                applicable = filtered;
            }
        }

        // Issue #1154: arity/name applicability (Phase 1) does not check whether
        // each argument is type-convertible to the corresponding parameter. Per
        // C# §11.6.4.2 a candidate is NOT applicable when any argument has no
        // implicit conversion to its parameter type. Without this filter a
        // wholly-inapplicable overload (e.g. F(string) for a []uint8 argument)
        // can tie — and thus be reported ambiguous (GS0266) — with the unique
        // genuinely-applicable overload that merely needs an implicit
        // nullable/reference widening (e.g. []uint8 -> []?uint8). Drop such
        // non-convertible candidates here, conservatively (see skips below), so
        // the unique applicable overload is selected without a spurious GS0266.
        if (applicable.Count > 1 && !HasNamedArguments(argumentNames))
        {
            var convertible = new List<FunctionSymbol>(applicable.Count);
            foreach (var cand in applicable)
            {
                if (IsConvertibilityApplicable(cand, argumentCount, boundArguments))
                {
                    convertible.Add(cand);
                }
            }

            // Mirror the #1124 pattern: only adopt the narrowed set when it
            // leaves at least one candidate. An empty result means the call is
            // genuinely unsatisfiable; keep the prior list so the pre-existing
            // diagnostics (no-applicable-overload / ambiguity) are preserved.
            if (convertible.Count > 0)
            {
                applicable = convertible;
            }
            else
            {
                // Issue #1552: every arity-applicable candidate was filtered
                // out. When the reason is the Kotlin-model null-safety gate — a
                // nullable REFERENCE argument `S?` reaching a non-nullable,
                // non-`object` reference parameter — surface the SAME GS0154
                // the single-candidate path emits, rather than falling through
                // to a spurious GS0266 ambiguity or a generic
                // no-applicable-overload. This preserves null safety: the user
                // is prompted to write `!!` (or narrow) exactly as the
                // single-overload call already requires.
                nullSafetyFailure = TryFindNullSafetyArgumentMismatch(applicable, argumentCount, boundArguments);
                if (nullSafetyFailure != null)
                {
                    return null;
                }
            }
        }

        if (applicable.Count == 0)
        {
            return null;
        }

        if (applicable.Count == 1)
        {
            return applicable[0];
        }

        // Phase 2 (issue #1631): rank by C# §7.5.3.2 "better function member"
        // pairwise domination over per-argument conversion kind, reusing the
        // SAME OverloadResolution.ImplicitConversionKind ranking (and numeric "better conversion
        // target" tie-break) the CLR-reflection resolver
        // (OverloadResolution.RankApplicable/CompareConversions) uses for
        // imported-method overloads. This replaces the previous ad-hoc linear
        // score, under which any two candidates that both needed an implicit
        // conversion tied at score 0 (e.g. F(int64) / F(float64) called with an
        // int32 constant) and reported a spurious GS0266 — even though one
        // conversion is strictly "better" per C#. Only after the per-argument
        // pairwise pass survivors are narrowed do the arity tie-breakers
        // (fewest defaulted parameters, then non-variadic, then non-generic)
        // run, matching the CLR path's phase ordering.
        var data = new List<UserCandidateRankData>(applicable.Count);
        foreach (var cand in applicable)
        {
            var parameterOffset = cand.ExplicitReceiverParameter == null ? 0 : 1;
            var paramLen = cand.Parameters.Length - parameterOffset;
            var isVariadic = paramLen > 0 && cand.Parameters[cand.Parameters.Length - 1].IsVariadic;
            var paramCountForScore = isVariadic ? paramLen - 1 : paramLen;
            var defaultsUsed = paramCountForScore - argumentCount;
            if (defaultsUsed < 0)
            {
                defaultsUsed = 0;
            }

            // For generic candidates, compute the inferred method-type
            // substitution so delegate parameter return types can be closed
            // when classifying the value-return discard case below.
            Dictionary<TypeParameterSymbol, TypeSymbol> candSubstitution = null;
            if (cand.IsGeneric)
            {
                GetCachedCandidateSubstitution(cand, boundArguments, argumentCount, substitutionCache, out candSubstitution);
            }

            // Classify each supplied argument's conversion to its ACTUAL
            // target slot. Issue #1628: boundArguments[i] is source order,
            // not parameter order — under named arguments the source-order
            // index does not necessarily line up with the parameter it binds
            // to (e.g. a named arg reorders a permutation-overload's
            // parameters). Map each argument to its real slot before
            // classifying, so a named call still ranks against the correct
            // parameter type.
            var kinds = new OverloadResolution.ImplicitConversionKind[boundArguments.Count];
            var paramTypes = new TypeSymbol[boundArguments.Count];
            var isTailSlot = new bool[boundArguments.Count];
            var elementType = isVariadic && cand.Parameters[cand.Parameters.Length - 1].Type is SliceTypeSymbol variadicSlice
                ? variadicSlice.ElementType
                : null;
            for (var i = 0; i < boundArguments.Count; i++)
            {
                var slot = MapArgumentIndexToParameterSlot(cand, argumentNames, i, parameterOffset, paramLen);
                if (slot < 0)
                {
                    // Unmapped (shouldn't happen for an applicable candidate) —
                    // neutral: contributes no per-argument preference.
                    kinds[i] = OverloadResolution.ImplicitConversionKind.Identity;
                    continue;
                }

                if (slot >= paramCountForScore)
                {
                    // Issue #1631 (B1): variadic params-array tail argument.
                    // Classify against the params ELEMENT type (so a genuine
                    // widening in the tail is still visible) but flag the
                    // slot as expanded-form. IsUserCandidateAtLeastAsGoodAs
                    // below ranks an expanded-form slot strictly worse than a
                    // normal-form slot on the SAME argument regardless of
                    // conversion kind — C#'s "non-expanded form is preferred
                    // over expanded form" rule (§7.5.3.2) — so a variadic
                    // sibling can never dominate an applicable non-variadic
                    // one purely because its tail was compared favourably.
                    // Between two variadic candidates (both expanded), the
                    // element-type kind still decides genuine betterness.
                    isTailSlot[i] = true;
                    var tailArgType = boundArguments[i]?.Type;
                    kinds[i] = elementType == null
                        ? OverloadResolution.ImplicitConversionKind.Identity
                        : ClassifyUserArgumentConversionKind(tailArgType, elementType);
                    continue;
                }

                var argType = boundArguments[i]?.Type;
                var paramType = cand.Parameters[slot + parameterOffset].Type;
                paramTypes[i] = paramType;

                // Issue #1531 control: a value-returning delegate/method-group
                // argument that maps onto a `(...)->void` delegate parameter
                // discards its result. Classify it as C#'s worst-ranked
                // "lambda to void delegate" conversion so a sibling
                // `(...)->TResult` overload (whose delegate return closes to
                // the argument's actual return type) is preferred — matching
                // C#'s "better conversion from a method group" rule — instead
                // of tying and reporting a spurious GS0266.
                kinds[i] = IsValueReturnDiscardedToVoidDelegate(argType, paramType, candSubstitution)
                    ? OverloadResolution.ImplicitConversionKind.LambdaToVoidDelegate
                    : ClassifyUserArgumentConversionKind(argType, paramType);
            }

            data.Add(new UserCandidateRankData(cand, kinds, paramTypes, isTailSlot, defaultsUsed, isVariadic));
        }

        // Phase 2a: pairwise domination. A candidate survives when no other
        // candidate is "at least as good on every argument, and strictly
        // better on at least one" (C# §7.5.3.2). Two candidates whose
        // per-argument conversions are pairwise incomparable both survive —
        // exactly the non-generic-vs-generic tie the previous strict-
        // dominance-over-all-others requirement rejected.
        var argTypes = new TypeSymbol[boundArguments.Count];
        for (var i = 0; i < boundArguments.Count; i++)
        {
            argTypes[i] = boundArguments[i]?.Type;
        }

        var survivors = new List<UserCandidateRankData>(data.Count);
        foreach (var c in data)
        {
            var dominated = false;
            foreach (var o in data)
            {
                if (ReferenceEquals(c.Candidate, o.Candidate))
                {
                    continue;
                }

                if (IsUserCandidateAtLeastAsGoodAs(o, c, argTypes))
                {
                    dominated = true;
                    break;
                }
            }

            if (!dominated)
            {
                survivors.Add(c);
            }
        }

        // Domination is a strict partial order over a finite non-empty set
        // (applicable.Count > 1 here), so a maximal element always survives —
        // survivors is never empty; the old "fall back to data" branch was
        // dead code.
        System.Diagnostics.Debug.Assert(survivors.Count > 0, "pairwise domination must leave at least one survivor");
        var pool = survivors;

        // Phase 2b: prefer the fewest defaulted parameters (an exact-arity
        // overload beats one that relies on defaults).
        if (pool.Count > 1)
        {
            var minDefaults = pool.Min(w => w.DefaultsUsed);
            var fewestDefaults = pool.Where(w => w.DefaultsUsed == minDefaults).ToList();
            if (fewestDefaults.Count > 0 && fewestDefaults.Count < pool.Count)
            {
                pool = fewestDefaults;
            }
        }

        // Phase 2c: prefer a non-variadic candidate over a variadic one (per
        // ADR §6.6 — the normal-form / non-expanded-params preference).
        if (pool.Count > 1)
        {
            var nonVariadic = pool.Where(w => !w.IsVariadic).ToList();
            if (nonVariadic.Count > 0 && nonVariadic.Count < pool.Count)
            {
                pool = nonVariadic;
            }
        }

        // Phase 2d: prefer a non-generic candidate over a generic one when
        // otherwise tied (C# §7.5.3.2's non-generic-over-generic tie-break).
        if (pool.Count > 1)
        {
            var nonGeneric = pool.Where(w => !w.Candidate.IsGeneric).ToList();
            if (nonGeneric.Count > 0 && nonGeneric.Count < pool.Count)
            {
                pool = nonGeneric;
            }
        }

        // Phase 2e — issue #2172: when an argument is a task-returning lambda
        // (its natural function type returns Task/Task<T>), prefer a candidate
        // whose delegate parameter is shaped `(...) -> Task[TResult]` (binding
        // the whole task to a Task-typed delegate result) over one shaped
        // `(...) -> TResult` (binding the whole task to a bare method type
        // parameter). Both close to the same `(...) -> Task[X]` after inference,
        // so neither dominates on conversion kind and the earlier tie-breaks
        // cannot choose. Mirrors C#'s preference for the task-returning delegate
        // overload for an async/task-returning lambda argument, and the parallel
        // rule in OverloadResolution.RankApplicable for imported (BCL) overloads.
        // Generalised: fires for ANY user overload set differing by `(...) -> X`
        // vs `(...) -> Task[X]` at a task-returning-lambda argument slot.
        if (pool.Count > 1)
        {
            pool = PreferTaskShapedDelegateForTaskLambda(pool, boundArguments);
        }

        if (pool.Count == 1)
        {
            return pool[0].Candidate;
        }

        ambiguous = true;
        return null;
    }

    /// <summary>
    /// Issue #2172: narrows <paramref name="pool"/> to prefer, for each argument
    /// slot whose argument is a task-returning lambda (its function type returns
    /// <c>Task</c>/<c>Task&lt;T&gt;</c>), the candidates whose OPEN delegate
    /// parameter at that slot is shaped <c>(...) -&gt; Task[TResult]</c> over
    /// those shaped <c>(...) -&gt; TResult</c>. Only narrows when the pool
    /// genuinely splits into both shapes at such a slot, so non-task-lambda calls
    /// and single-shape overload sets are unaffected.
    /// </summary>
    private static List<UserCandidateRankData> PreferTaskShapedDelegateForTaskLambda(
        List<UserCandidateRankData> pool,
        ImmutableArray<BoundExpression>.Builder boundArguments)
    {
        var current = pool;
        for (var argIndex = 0; argIndex < boundArguments.Count; argIndex++)
        {
            if (current.Count <= 1)
            {
                break;
            }

            // The argument must itself be a task-returning function value (an
            // async / task-returning lambda's natural function type).
            if (!(boundArguments[argIndex]?.Type is FunctionTypeSymbol argFn)
                || !IsTaskReturnTypeSymbol(argFn.ReturnType))
            {
                continue;
            }

            var taskShaped = new List<UserCandidateRankData>(current.Count);
            var bareTypeParam = false;
            foreach (var w in current)
            {
                var openParam = argIndex < w.ParamTypes.Length ? w.ParamTypes[argIndex] : null;
                if (openParam is FunctionTypeSymbol paramFn)
                {
                    if (IsTaskReturnTypeSymbol(paramFn.ReturnType))
                    {
                        taskShaped.Add(w);
                        continue;
                    }

                    if (paramFn.ReturnType is TypeParameterSymbol)
                    {
                        bareTypeParam = true;
                        continue;
                    }
                }

                // Neither shape — keep it eligible so an unrelated sibling
                // overload is never silently dropped.
                taskShaped.Add(w);
            }

            if (bareTypeParam && taskShaped.Count >= 1 && taskShaped.Count < current.Count)
            {
                current = taskShaped;
            }
        }

        return current;
    }

    /// <summary>
    /// Issue #2172: whether <paramref name="type"/> is
    /// <c>System.Threading.Tasks.Task</c>/<c>Task&lt;T&gt;</c> (or the
    /// <c>ValueTask</c> equivalents). Detected via the erased CLR type so it
    /// also matches an open construction like <c>Task[T]</c> (whose closed CLR
    /// form is <c>Task&lt;object&gt;</c>).
    /// </summary>
    private static bool IsTaskReturnTypeSymbol(TypeSymbol type)
    {
        var clr = type?.ClrType;
        if (clr == null)
        {
            return false;
        }

        if (clr.IsSameAs(typeof(System.Threading.Tasks.Task))
            || clr.IsSameAs(typeof(System.Threading.Tasks.ValueTask)))
        {
            return true;
        }

        if (clr.IsGenericType)
        {
            var definition = clr.GetGenericTypeDefinition();
            if (definition.IsSameAs(typeof(System.Threading.Tasks.Task<>))
                || definition.IsSameAs(typeof(System.Threading.Tasks.ValueTask<>)))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Per-candidate data accumulated during Phase 2 user-overload ranking
    /// (issue #1631): the per-argument conversion classification plus the
    /// arity axes (defaulted-parameter count, variadic-ness) used by the
    /// tie-breakers that run after pairwise domination.
    /// </summary>
    private readonly struct UserCandidateRankData
    {
        public UserCandidateRankData(FunctionSymbol candidate, OverloadResolution.ImplicitConversionKind[] kinds, TypeSymbol[] paramTypes, bool[] isTailSlot, int defaultsUsed, bool isVariadic)
        {
            Candidate = candidate;
            Kinds = kinds;
            ParamTypes = paramTypes;
            IsTailSlot = isTailSlot;
            DefaultsUsed = defaultsUsed;
            IsVariadic = isVariadic;
        }

        public FunctionSymbol Candidate { get; }

        public OverloadResolution.ImplicitConversionKind[] Kinds { get; }

        public TypeSymbol[] ParamTypes { get; }

        /// <summary>
        /// Gets per-argument flags set when the argument at that index bound
        /// to this candidate's variadic params-array tail (as opposed to a
        /// normal fixed parameter slot) (issue #1631, B1).
        /// </summary>
        public bool[] IsTailSlot { get; }

        public int DefaultsUsed { get; }

        public bool IsVariadic { get; }
    }

    /// <summary>
    /// Issue #1631: C# §7.5.3.2 "better function member" pairwise comparison —
    /// mirrors <c>OverloadResolution.IsAtLeastAsGoodAs</c> for user-symbolic
    /// candidates. Returns <see langword="true"/> when <paramref name="a"/> is
    /// not worse than <paramref name="b"/> on any argument and strictly better
    /// on at least one.
    /// </summary>
    private static bool IsUserCandidateAtLeastAsGoodAs(UserCandidateRankData a, UserCandidateRankData b, TypeSymbol[] argTypes)
    {
        var hasStrictlyBetter = false;
        for (var i = 0; i < a.Kinds.Length; i++)
        {
            var cmp = CompareUserConversions(a.Kinds[i], a.ParamTypes[i], a.IsTailSlot[i], b.Kinds[i], b.ParamTypes[i], b.IsTailSlot[i], argTypes[i]);
            if (cmp > 0)
            {
                return false;
            }

            if (cmp < 0)
            {
                hasStrictlyBetter = true;
            }
        }

        return hasStrictlyBetter;
    }

    /// <summary>
    /// Issue #1631: compares two candidate conversions for the SAME argument,
    /// mirroring <c>OverloadResolution.CompareConversions</c>. Different
    /// <see cref="OverloadResolution.ImplicitConversionKind"/>s rank by their declared ordinal
    /// (lower is better); same-kind numeric widenings tie-break via the
    /// shared <see cref="OverloadResolution.CompareNumericTargets"/> "better
    /// conversion target" rule (C# §7.5.3.4), reusing the exact CLR-path
    /// helper rather than reimplementing the numeric/signed-vs-unsigned
    /// lattice a second time.
    /// </summary>
    private static int CompareUserConversions(OverloadResolution.ImplicitConversionKind ka, TypeSymbol paramA, bool tailA, OverloadResolution.ImplicitConversionKind kb, TypeSymbol paramB, bool tailB, TypeSymbol source)
    {
        // Issue #1631 (B1'): per C# §7.5.3.2, "non-expanded form preferred
        // over expanded form" is a LATE tie-break applied only when per-arg
        // betterness is otherwise tied across every argument — it is not a
        // per-arg override. Per-arg comparison must rank purely on each
        // side's own conversion kind (e.g. an exact element-type match on a
        // variadic tail slot legitimately beats a widening conversion on a
        // normal-form slot). Phase 2c (prefer non-variadic) applies the
        // actual tie-break once all per-arg comparisons agree.
        if (ka != kb)
        {
            return ((int)ka).CompareTo((int)kb);
        }

        if (ka == OverloadResolution.ImplicitConversionKind.NumericWidening)
        {
            return OverloadResolution.CompareNumericTargets(paramA?.ClrType, paramB?.ClrType, source?.ClrType);
        }

        // Issue #2146: reference "better conversion target" tie-break
        // (C# §7.5.3.2 / §7.5.3.4). When both conversions for the same argument
        // fold into the Reference bucket (both are non-identity implicit
        // reference/boxing/interface conversions, e.g. Dog->object vs
        // Dog->Animal, or Type->object vs Type->Type?), the previous code tied
        // (returned 0) and the call was reported ambiguous (GS0266) even though
        // C# prefers the MORE DERIVED target. Apply the reference-type rule:
        // target T1 is a better conversion target than T2 when an implicit
        // conversion exists from T1 to T2 but not from T2 to T1. That makes the
        // more-derived reference parameter win (Animal over object; Type? over
        // object). If neither target converts to the other (genuinely unrelated
        // reference types), leave the tie (0) so real ambiguity is preserved.
        if (ka == OverloadResolution.ImplicitConversionKind.Reference && paramA != null && paramB != null && !ReferenceEquals(paramA, paramB))
        {
            return CompareReferenceTargets(paramA, paramB);
        }

        return 0;
    }

    /// <summary>
    /// Issue #2146: implements the C# §7.5.3.4 "better conversion target" rule
    /// for reference-type targets. Returns a negative value when
    /// <paramref name="targetA"/> is the better (more-derived) target, positive
    /// when <paramref name="targetB"/> is, and 0 when the two targets are
    /// unrelated (neither implicitly converts to the other) — preserving genuine
    /// ambiguity. Convertibility is probed one-directionally via
    /// <see cref="Conversion.Classify"/> rather than hand-rolled type checks so
    /// user classes, interfaces, and imported/BCL reference types are all
    /// handled uniformly.
    /// </summary>
    private static int CompareReferenceTargets(TypeSymbol targetA, TypeSymbol targetB)
    {
        var aToB = Conversion.Classify(targetA, targetB);
        var bToA = Conversion.Classify(targetB, targetA);

        var aToBImplicit = aToB.IsImplicit && !aToB.IsIdentity;
        var bToAImplicit = bToA.IsImplicit && !bToA.IsIdentity;

        if (aToBImplicit && !bToAImplicit)
        {
            // A converts to B but not vice versa => A is more derived => A better.
            return -1;
        }

        if (bToAImplicit && !aToBImplicit)
        {
            return 1;
        }

        return 0;
    }

    /// <summary>
    /// Issue #1631: classifies the implicit conversion from a user-symbolic
    /// argument type to a user-symbolic parameter type using the SAME
    /// <see cref="OverloadResolution.ImplicitConversionKind"/> ranking the CLR-reflection
    /// resolver (<see cref="OverloadResolution.ClassifyImplicit"/>) uses for
    /// imported-method overloads, so both resolvers agree on which conversion
    /// is "better". Bounded to the conversion shapes the user-symbolic
    /// <see cref="Conversion"/> classifier actually distinguishes: identity,
    /// nullable-wrap (<c>T -&gt; T?</c>), and numeric widening (via the
    /// shared <see cref="NumericWideningLattice"/>). Every other implicit
    /// conversion (reference upcast, interface satisfaction, boxing,
    /// user-defined <c>op_Implicit</c>, …) folds into
    /// <see cref="OverloadResolution.ImplicitConversionKind.Reference"/> — the user-symbolic type
    /// model does not carry enough structure to rank those sub-kinds
    /// separately, but they still rank strictly better than the numeric/
    /// delegate special cases ranked worse below.
    /// </summary>
    private OverloadResolution.ImplicitConversionKind ClassifyUserArgumentConversionKind(TypeSymbol argType, TypeSymbol paramType)
    {
        if (argType == null || paramType == null)
        {
            return OverloadResolution.ImplicitConversionKind.None;
        }

        if (argType == paramType)
        {
            return OverloadResolution.ImplicitConversionKind.Identity;
        }

        if (Conversion.Classify(argType, paramType).IsStructuralProjection)
        {
            return conversions.HasUserDefinedImplicitConversion(argType, paramType)
                ? OverloadResolution.ImplicitConversionKind.UserDefinedImplicit
                : OverloadResolution.ImplicitConversionKind.StructuralProjection;
        }

        if (paramType is NullableTypeSymbol nullableParam && argType == nullableParam.UnderlyingType)
        {
            // Issue #2146: `T -> T?` is a genuine value-type nullable WRAP only
            // when the underlying is a value type. For a REFERENCE-type nullable
            // (e.g. `Type -> Type?`) the wrap carries no runtime cost — it is a
            // reference conversion (a nullability annotation) — and ranking it as
            // NullableWrap (worse than Reference) would make an unrelated
            // `object` reference upcast spuriously win. Classify it as Reference
            // so the reference "better conversion target" tie-break (below, in
            // CompareUserConversions) correctly prefers the more-derived `T?`
            // target over `object`.
            if (NullableLifting.IsValueTypeNullable(nullableParam))
            {
                return OverloadResolution.ImplicitConversionKind.NullableWrap;
            }

            return OverloadResolution.ImplicitConversionKind.Reference;
        }

        // ponytail: widening-then-wrap (e.g. int32 -> int64?) is not caught by
        // the identity-underlying check above (argType != nullableParam.UnderlyingType)
        // and falls through to the Reference bucket below instead of a rank
        // between NumericWidening and Reference. No ImplicitConversionKind slot
        // exists for it today; add one (and a matching CompareNumericTargets
        // path against nullableParam.UnderlyingType) if a real ambiguity shows up.
        var argClr = argType.ClrType;
        var paramClr = paramType.ClrType;
        if (argClr != null && paramClr != null
            && NumericWideningLattice.IsNumericPrimitive(argClr.FullName)
            && NumericWideningLattice.IsNumericPrimitive(paramClr.FullName)
            && NumericWideningLattice.IsWidening(argClr, paramClr))
        {
            return OverloadResolution.ImplicitConversionKind.NumericWidening;
        }

        // ponytail: object vs. an implemented interface (e.g. f(object) vs.
        // f(IInterface) for a class arg) both fold into Reference here, so
        // they tie and report GS0266 where C# would prefer the interface.
        // Pre-existing ceiling (parity with the old linear score), not a
        // #1631 regression. Upgrade path: split Reference into sub-kinds
        // (exact-interface-satisfaction vs. base-class/object upcast) sharing
        // more of Conversion.Classify's structure, if this surfaces in practice.
        return OverloadResolution.ImplicitConversionKind.Reference;
    }

    /// <summary>
    /// Issue #1154: returns <see langword="true"/> when <paramref name="argumentNames"/>
    /// carries any non-null positional name. When named arguments are present the
    /// positional index→parameter mapping used by the convertibility filter is
    /// unreliable, so the filter is skipped entirely for that call.
    /// </summary>
    private static bool HasNamedArguments(ImmutableArray<string> argumentNames)
    {
        if (argumentNames.IsDefault)
        {
            return false;
        }

        for (var i = 0; i < argumentNames.Length; i++)
        {
            if (argumentNames[i] != null)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Issue #1154: convertibility-aware applicability. Returns
    /// <see langword="true"/> when every positional argument actually supplied
    /// is implicitly convertible to the corresponding parameter type of
    /// <paramref name="candidate"/>. Conservatively treats a candidate as
    /// convertible (does NOT reject) for situations where the positional
    /// index→parameter mapping or the parameter type is unreliable: generic
    /// candidates (their parameter types may contain unsubstituted method type
    /// parameters — handled by the #1124 inference filter), the variadic tail,
    /// by-ref/out/in parameters, and unknown argument/parameter types.
    /// </summary>
    private bool IsConvertibilityApplicable(
        FunctionSymbol candidate,
        int argumentCount,
        ImmutableArray<BoundExpression>.Builder boundArguments)
    {
        // Generic candidates may carry unsubstituted method type parameters in
        // their signature; rely on the existing #1124 inference filter instead.
        if (candidate.IsGeneric)
        {
            return true;
        }

        var parameterOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
        var paramLen = candidate.Parameters.Length - parameterOffset;
        var isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? paramLen - 1 : paramLen;

        var count = Math.Min(argumentCount, paramLen);
        for (var i = 0; i < count && i < boundArguments.Count; i++)
        {
            // The variadic tail binds its element(s) elsewhere; do not reject.
            if (isVariadic && i >= fixedParamCount)
            {
                continue;
            }

            var parameter = candidate.Parameters[i + parameterOffset];

            // By-ref/out/in parameters have their own exact-type rules.
            if (parameter.RefKind != RefKind.None)
            {
                continue;
            }

            var argType = boundArguments[i]?.Type;
            var paramType = parameter.Type;

            // Unknown argument or parameter type — be conservative, do not reject.
            if (argType == null || paramType == null)
            {
                continue;
            }

            // Issue #1627: the #1552 point-fix gate that used to live here
            // (calling IsNullableReferenceGateRejected before classification)
            // has been removed. Conversion.Classify now rejects an imported
            // nullable-REFERENCE argument `S?` against a non-null-tolerant
            // reference parameter `S` at the classification source (see the
            // `#1627` comment in Conversion.Classify), so the general
            // convertibility check below already reports it as non-applicable
            // — consistently, in every BindConversion position, not just this
            // multi-candidate positional filter.
            var conversion = Conversion.Classify(argType, paramType);
            if (conversion.Exists && (conversion.IsImplicit || conversion.IsIdentity))
            {
                continue;
            }

            // Issue #1281: a constant integer argument that fits a narrower /
            // cross-sign integer parameter is implicitly convertible there
            // (C# §10.2.11), so it must not disqualify the candidate.
            if (ExpressionBinder.IsImplicitConstantNarrowingArgument(boundArguments[i], paramType))
            {
                continue;
            }

            if (conversions.TryApplyUserDefinedImplicitArgumentConversion(boundArguments[i], paramType, out _))
            {
                continue;
            }

            return false;
        }

        // Issue #1493: validate the variadic tail too, so a non-generic
        // variadic candidate is only applicable when each trailing argument
        // implicitly converts to the variadic element type — keeping
        // applicability/ranking in agreement with the final element coercion.
        if (isVariadic
            && candidate.Parameters[candidate.Parameters.Length - 1].Type is SliceTypeSymbol variadicSlice)
        {
            var elementType = variadicSlice.ElementType;
            var tailStart = fixedParamCount;

            // A single trailing argument already typed as the slice itself is a
            // pass-through (`f(existingSlice)`); accept it as-is.
            var isSlicePassThrough = argumentCount - tailStart == 1
                && tailStart < boundArguments.Count
                && boundArguments[tailStart]?.Type == candidate.Parameters[candidate.Parameters.Length - 1].Type;

            if (!isSlicePassThrough && !(elementType is TypeParameterSymbol))
            {
                for (var i = tailStart; i < argumentCount && i < boundArguments.Count; i++)
                {
                    var argType = boundArguments[i]?.Type;
                    if (argType == null)
                    {
                        continue;
                    }

                    var conversion = Conversion.Classify(argType, elementType);
                    if (conversion.Exists && (conversion.IsImplicit || conversion.IsIdentity))
                    {
                        continue;
                    }

                    if (ExpressionBinder.IsImplicitConstantNarrowingArgument(boundArguments[i], elementType))
                    {
                        continue;
                    }

                    if (conversions.TryApplyUserDefinedImplicitArgumentConversion(boundArguments[i], elementType, out _))
                    {
                        continue;
                    }

                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1552: the Kotlin-model null-safety gate used by overload
    /// applicability. Returns <see langword="true"/> when a nullable REFERENCE
    /// argument <paramref name="argType"/> (<c>S?</c>) must NOT be accepted by
    /// the (non-nullable, non-<c>object</c>) reference parameter
    /// <paramref name="paramType"/>. Passing a nullable reference where a
    /// non-nullable reference is required is an error in G# (the user must write
    /// <c>!!</c> or rely on smart-cast narrowing); this mirrors that rule during
    /// overload resolution so the ambiguity/leak paths cannot silently drop the
    /// <c>?</c>. The gate deliberately fires ONLY for reference-like nullable
    /// underlyings, so value-type nullables and nullable type-parameter
    /// underlyings are unaffected.
    /// </summary>
    private static bool IsNullableReferenceGateRejected(TypeSymbol argType, TypeSymbol paramType)
    {
        if (argType is not NullableTypeSymbol argNullable)
        {
            return false;
        }

        // Only a REFERENCE-like nullable underlying is subject to the gate.
        if (!IsReferenceLikeType(argNullable.UnderlyingType))
        {
            return false;
        }

        // A null-tolerant parameter (`object`/`object?` or any nullable target)
        // accepts null, so the gate does not fire.
        if (IsNullTolerantParameter(paramType))
        {
            return false;
        }

        // Only reference parameters are gated; a nullable-reference argument to
        // a value-type parameter is already non-convertible via Conversion.
        return IsReferenceLikeType(paramType);
    }

    /// <summary>
    /// Issue #1552: a parameter is null-tolerant when it accepts a null
    /// reference: the top type <c>object</c>/<c>object?</c> or any nullable
    /// target (<c>T?</c>).
    /// </summary>
    private static bool IsNullTolerantParameter(TypeSymbol paramType)
    {
        if (paramType is NullableTypeSymbol)
        {
            return true;
        }

        if (paramType == TypeSymbol.Object)
        {
            return true;
        }

        return paramType?.ClrType?.IsSameAs(typeof(object)) == true;
    }

    /// <summary>
    /// Issue #1552: the reference-like notion used by the null-safety gate,
    /// mirroring <c>Conversion.IsReferenceLikeTarget</c>. A type is reference-
    /// like when it is a user interface, a user <c>class</c> (StructSymbol with
    /// IsClass), the built-in <c>string</c>, or an imported/CLR-backed type
    /// whose backing is a class/interface. User classes/interfaces carry a null
    /// ClrType during binding and are matched by their symbol kind.
    /// </summary>
    private static bool IsReferenceLikeType(TypeSymbol type)
    {
        if (type is InterfaceSymbol)
        {
            return true;
        }

        if (type is StructSymbol { IsClass: true })
        {
            return true;
        }

        if (type == TypeSymbol.String)
        {
            return true;
        }

        if (type?.ClrType is { } clrBacking)
        {
            return !clrBacking.IsValueType && !clrBacking.IsPointer && !clrBacking.IsByRef;
        }

        return false;
    }

    /// <summary>
    /// Issue #1552: when every arity-applicable candidate was filtered out by
    /// the convertibility pass, locate the first supplied argument whose
    /// nullable-reference type is rejected by the null-safety gate against at
    /// least one candidate's parameter at that position. Returns the mismatch so
    /// the caller can emit the same GS0154 the single-candidate path produces
    /// (pointing at the argument), or <see langword="null"/> when the empty set
    /// is not attributable to the null-safety gate.
    /// </summary>
    private static NullSafetyArgumentMismatch TryFindNullSafetyArgumentMismatch(
        List<FunctionSymbol> candidates,
        int argumentCount,
        ImmutableArray<BoundExpression>.Builder boundArguments)
    {
        var count = Math.Min(argumentCount, boundArguments.Count);
        for (var i = 0; i < count; i++)
        {
            var argType = boundArguments[i]?.Type;
            if (argType is not NullableTypeSymbol argNullable || !IsReferenceLikeType(argNullable.UnderlyingType))
            {
                continue;
            }

            foreach (var candidate in candidates)
            {
                if (candidate.IsGeneric)
                {
                    continue;
                }

                var parameterOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
                var paramIndex = i + parameterOffset;
                if (paramIndex < 0 || paramIndex >= candidate.Parameters.Length)
                {
                    continue;
                }

                var parameter = candidate.Parameters[paramIndex];
                if (parameter.RefKind != RefKind.None || parameter.IsVariadic)
                {
                    continue;
                }

                if (IsNullableReferenceGateRejected(argType, parameter.Type))
                {
                    return new NullSafetyArgumentMismatch(i, argType, parameter.Type, parameter.Name);
                }
            }
        }

        return null;
    }

    /// <summary>
    /// Issue #1552: describes a null-safety overload-resolution failure — a
    /// nullable-reference argument at <see cref="Index"/> that no applicable
    /// overload can accept without dropping the <c>?</c>. Carries the argument
    /// and parameter types so the call site can emit GS0154 at the argument.
    /// </summary>
    internal sealed class NullSafetyArgumentMismatch
    {
        public NullSafetyArgumentMismatch(int index, TypeSymbol argType, TypeSymbol paramType, string paramName)
        {
            Index = index;
            ArgType = argType;
            ParamType = paramType;
            ParamName = paramName;
        }

        public int Index { get; }

        public TypeSymbol ArgType { get; }

        public TypeSymbol ParamType { get; }

        public string ParamName { get; }
    }

    /// <summary>
    /// ADR-0063: returns true when the supplied argument count + names could
    /// reach the parameter list of the candidate.
    /// </summary>
    /// <summary>
    /// Issue #1628: maps a source-order argument index to the parameter slot
    /// (0-based, excluding <paramref name="parameterOffset"/>) it actually
    /// binds to on <paramref name="candidate"/>. A named argument binds to
    /// whichever parameter shares its name — not necessarily its source
    /// position — while an unnamed argument binds positionally. Mirrors the
    /// name→slot resolution <see cref="IsApplicableUserCallable"/> already
    /// validates and <c>TryReorderUserCallArguments</c> already performs, so
    /// Phase-2 exact-match scoring ranks the candidate against the parameter
    /// it will really receive the argument on. Returns -1 if the name (already
    /// validated applicable) is not found, which should not happen in practice.
    /// </summary>
    private static int MapArgumentIndexToParameterSlot(
        FunctionSymbol candidate,
        ImmutableArray<string> argumentNames,
        int argumentIndex,
        int parameterOffset,
        int paramLen)
    {
        var name = argumentNames.IsDefault || argumentIndex >= argumentNames.Length ? null : argumentNames[argumentIndex];
        if (name == null)
        {
            return argumentIndex;
        }

        for (var p = 0; p < paramLen; p++)
        {
            if (candidate.Parameters[p + parameterOffset].Name == name)
            {
                return p;
            }
        }

        return -1;
    }

    private static bool IsApplicableUserCallable(FunctionSymbol candidate, int argumentCount, ImmutableArray<string> argumentNames)
    {
        var parameterOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
        var paramLen = candidate.Parameters.Length - parameterOffset;
        var isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? paramLen - 1 : paramLen;

        // Compute required (non-optional) leading-parameter count.
        var requiredParamCount = paramLen;
        for (var i = paramLen - 1; i >= 0; i--)
        {
            if (candidate.Parameters[i + parameterOffset].HasExplicitDefaultValue)
            {
                requiredParamCount = i;
            }
            else
            {
                break;
            }
        }

        if (isVariadic)
        {
            if (argumentCount < fixedParamCount)
            {
                return false;
            }
        }
        else if (argumentCount < requiredParamCount || argumentCount > paramLen)
        {
            return false;
        }

        // Named-argument names must each correspond to a parameter.
        if (!argumentNames.IsDefault)
        {
            for (var i = 0; i < argumentNames.Length; i++)
            {
                var n = argumentNames[i];
                if (n == null)
                {
                    continue;
                }

                var found = false;
                for (var p = 0; p < paramLen; p++)
                {
                    if (candidate.Parameters[p + parameterOffset].Name == n)
                    {
                        found = true;
                        break;
                    }
                }

                if (!found)
                {
                    return false;
                }
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1632: memoizing wrapper over <see cref="TryInferCandidateSubstitution"/>,
    /// keyed by candidate. Within a single <see cref="SelectBestUserOverloadCore"/>
    /// call the #1124 applicability filter and the Phase-2 scoring pass both
    /// infer the same generic candidate's substitution from the identical
    /// <paramref name="boundArguments"/>/<paramref name="argumentCount"/> inputs;
    /// caching here runs unification once per candidate instead of twice.
    /// </summary>
    private bool GetCachedCandidateSubstitution(
        FunctionSymbol candidate,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        int argumentCount,
        Dictionary<FunctionSymbol, (bool Ok, Dictionary<TypeParameterSymbol, TypeSymbol> Substitution)> cache,
        out Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        if (cache.TryGetValue(candidate, out var cached))
        {
            substitution = cached.Substitution;
            return cached.Ok;
        }

        var ok = TryInferCandidateSubstitution(candidate, boundArguments, argumentCount, out substitution);
        cache[candidate] = (ok, substitution);
        return ok;
    }

    /// <summary>
    /// Computes the method-type-parameter substitution inferred from the
    /// supplied argument types for a generic <paramref name="candidate"/>, and
    /// reports whether every type parameter received a binding. Shared by the
    /// #1124 applicability filter (<see cref="GetCachedCandidateSubstitution"/>)
    /// and the Phase-2 exact-match scoring, which substitutes the inferred
    /// bindings into each open delegate parameter type so a value-returning
    /// delegate/method-group argument prefers the `(...)->TResult` overload over
    /// the `(...)->void` one (issue #1531 control).
    /// </summary>
    private bool TryInferCandidateSubstitution(
        FunctionSymbol candidate,
        ImmutableArray<BoundExpression>.Builder boundArguments,
        int argumentCount,
        out Dictionary<TypeParameterSymbol, TypeSymbol> substitution)
    {
        substitution = new Dictionary<TypeParameterSymbol, TypeSymbol>();
        if (!candidate.IsGeneric)
        {
            return true;
        }

        var parameterOffset = candidate.ExplicitReceiverParameter == null ? 0 : 1;
        var paramLen = candidate.Parameters.Length - parameterOffset;
        var isVariadic = paramLen > 0 && candidate.Parameters[candidate.Parameters.Length - 1].IsVariadic;
        var fixedParamCount = isVariadic ? paramLen - 1 : paramLen;

        var inferenceLimit = isVariadic ? fixedParamCount : Math.Min(argumentCount, paramLen);
        for (var i = 0; i < inferenceLimit && i < boundArguments.Count; i++)
        {
            var argType = boundArguments[i]?.Type;
            if (argType == null)
            {
                continue;
            }

            inferTypeArguments(candidate.Parameters[i + parameterOffset].Type, argType, substitution);
        }

        if (isVariadic && candidate.Parameters[candidate.Parameters.Length - 1].Type is SliceTypeSymbol variadicSlice)
        {
            for (var i = fixedParamCount; i < argumentCount && i < boundArguments.Count; i++)
            {
                var argType = boundArguments[i]?.Type;
                if (argType == null)
                {
                    continue;
                }

                var source = argType is SliceTypeSymbol argSlice ? argSlice.ElementType : argType;
                inferTypeArguments(variadicSlice.ElementType, source, substitution);
            }
        }

        foreach (var tp in candidate.TypeParameters)
        {
            if (!substitution.ContainsKey(tp))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Issue #1531 control: returns <see langword="true"/> when
    /// <paramref name="argType"/> is a value-returning delegate/function type
    /// and <paramref name="paramType"/> is a delegate parameter whose return
    /// type is (or, via <paramref name="candSubstitution"/>, closes to)
    /// <c>void</c> — i.e. the argument's result would be discarded. Used to
    /// prefer a sibling <c>(...)-&gt;TResult</c> overload over a
    /// <c>(...)-&gt;void</c> one when a value-returning argument is supplied.
    /// </summary>
    private bool IsValueReturnDiscardedToVoidDelegate(
        TypeSymbol argType,
        TypeSymbol paramType,
        Dictionary<TypeParameterSymbol, TypeSymbol> candSubstitution)
    {
        if (argType is not FunctionTypeSymbol argFn
            || paramType is not FunctionTypeSymbol paramFn
            || argFn.ParameterTypes.Length != paramFn.ParameterTypes.Length)
        {
            return false;
        }

        var argReturn = argFn.ReturnType;
        if (argReturn == null || argReturn == TypeSymbol.Void || argReturn == TypeSymbol.Error)
        {
            return false;
        }

        var paramReturn = paramFn.ReturnType;
        if (candSubstitution != null && paramReturn != null && TypeSymbol.ContainsTypeParameter(paramReturn))
        {
            paramReturn = substituteType(paramReturn, candSubstitution) ?? paramReturn;
        }

        return paramReturn == TypeSymbol.Void;
    }
}
