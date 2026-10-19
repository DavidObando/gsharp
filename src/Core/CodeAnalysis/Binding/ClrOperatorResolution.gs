// <copyright file="ClrOperatorResolution.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Stream C helper: resolves binary and unary operator (cref:SyntaxKind)
/// values to CLR operator method names (`op_Addition`, `op_Equality`,
/// `op_UnaryNegation`, ...) and performs the actual public-static lookup
/// across the two operand types. The "better function member" tie-break is
/// delegated to (cref:ClrOverloadResolution.Resolve{T}) so user-defined
/// operators participate in the same conversion ranking as method calls and
/// constructors (Stream A).
internal shared class ClrOperatorResolution {
    private struct ConversionProbeResult {
        init(found bool, method MethodInfo?, isExplicit bool) {
            this.Found = found
            this.Method = method
            this.IsExplicit = isExplicit
        }

        prop Found bool {
            get;
        }

        prop Method MethodInfo? {
            get;
        }

        prop IsExplicit bool {
            get;
        }
    }

    private let BinaryNames Dictionary[SyntaxKind, string] = Dictionary[SyntaxKind, string]{
        [SyntaxKind.PlusToken] = "op_Addition",
        [SyntaxKind.MinusToken] = "op_Subtraction",
        [SyntaxKind.StarToken] = "op_Multiply",
        [SyntaxKind.SlashToken] = "op_Division",
        [SyntaxKind.PercentToken] = "op_Modulus",
        [SyntaxKind.AmpersandToken] = "op_BitwiseAnd",
        [SyntaxKind.PipeToken] = "op_BitwiseOr",
        [SyntaxKind.HatToken] = "op_ExclusiveOr",
        [SyntaxKind.ShiftLeftToken] = "op_LeftShift",
        [SyntaxKind.ShiftRightToken] = "op_RightShift",
        [SyntaxKind.UnsignedShiftRightToken] = "op_UnsignedRightShift",
        [SyntaxKind.EqualsEqualsToken] = "op_Equality",
        [SyntaxKind.BangEqualsToken] = "op_Inequality",
        [SyntaxKind.LessToken] = "op_LessThan",
        [SyntaxKind.LessOrEqualsToken] = "op_LessThanOrEqual",
        [SyntaxKind.GreaterToken] = "op_GreaterThan",
        [SyntaxKind.GreaterOrEqualsToken] = "op_GreaterThanOrEqual"
    }
    private let UnaryNames Dictionary[SyntaxKind, string] = Dictionary[SyntaxKind, string]{
        [SyntaxKind.PlusToken] = "op_UnaryPlus",
        [SyntaxKind.MinusToken] = "op_UnaryNegation",
        [SyntaxKind.BangToken] = "op_LogicalNot",
        [SyntaxKind.TildeToken] = "op_OnesComplement"
    }

    /// Issue #1632: memoizes (cref:TryResolveConversion) per
    /// `(sourceType, targetType, allowExplicit)`. Overload resolution
    /// probes user-defined conversions for every candidate × argument pair
    /// that fails direct classification (`IsConvertibilityApplicable` in
    /// `OverloadResolver`), and each probe used to re-walk
    /// (cref:TryFind)'s uncached `GetMethods` reflection scan on
    /// both the source and target declaring types. Keyed purely on the CLR
    /// (cref:Type) pair (interned per (cref:System.Reflection.MetadataLoadContext)),
    /// so the cache is safe to share process-wide. Cleared by
    /// (cref:ClearCache) — wired into
    /// (cref:GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.Dispose)
    /// (mirroring #1678/#1622) — so entries keyed on a disposed context's
    /// (cref:Type) instances do not pin that context's memory.
    private let ConversionCache ConcurrentDictionary[
        (Source Type, Target Type, AllowExplicit bool),
        ConversionProbeResult
    ] = ConcurrentDictionary[(Source Type, Target Type, AllowExplicit bool), ConversionProbeResult]()

    /// Looks up the CLR operator name for a binary operator token.
    /// @param kind The operator syntax kind.
    /// @returns The CLR method name (e.g. `op_Addition`) or `null`.
    func TryGetBinaryName(kind SyntaxKind) string? -> if BinaryNames.TryGetValue(kind, out var name) {
        name
    } else {
        default(string?)
    }

    /// Looks up the CLR operator name for a unary operator token.
    /// @param kind The operator syntax kind.
    /// @returns The CLR method name (e.g. `op_UnaryNegation`) or `null`.
    func TryGetUnaryName(kind SyntaxKind) string? -> if UnaryNames.TryGetValue(kind, out var name) {
        name
    } else {
        default(string?)
    }

    /// Resolves a binary operator overload on the union of operand types.
    /// @param kind The operator token.
    /// @param leftType The left operand's GSharp type.
    /// @param rightType The right operand's GSharp type.
    /// @param method The resolved method on success.
    /// @param isAmbiguous Whether multiple candidates were equally good.
    /// @returns `true` if a unique operator was found.
    func TryResolveBinary(
        kind SyntaxKind,
        leftType TypeSymbol?,
        rightType TypeSymbol?,
        @NotNullWhen(true) out method MethodInfo?,
        out isAmbiguous bool
    ) bool {
        method = nil
        isAmbiguous = false
        let name string? = TryGetBinaryName(kind)
        if name == nil {
            return false
        }
        let candidates = List[MethodInfo]()
        CollectOperators(leftType?.ClrType, name, candidates)
        CollectOperators(rightType?.ClrType, name, candidates)
        if candidates.Count == 0 {
            return false
        }
        // Issue #1812: no interpolatedStringArgs flag is passed (or possible)
        // here — this overload resolves purely from the operands' GSharp
        // TypeSymbols (leftType/rightType), never from the originating
        // expression's syntax tree, so there is no ExpressionSyntax available
        // to test for InterpolatedStringExpressionSyntax in the first place.
        // An interpolated-string operand already collapses to its natural
        // `string` type before reaching this operator lookup.
        // Constant-narrowing likewise is not applied here: this helper receives
        // only operand types, not the bound operand expressions needed to prove
        // an integer value is a compile-time constant and in range.
        let argTypes = []Type? {leftType?.ClrType, rightType?.ClrType}
        let outcome = ClrOverloadResolution.Resolve(candidates, argTypes)
        if outcome.Outcome == ClrOverloadResolution.ResolutionOutcome.Resolved && outcome.Best is {} best {
            method = best
            return true
        }
        if outcome.Outcome == ClrOverloadResolution.ResolutionOutcome.Ambiguous {
            isAmbiguous = true
        }
        return false
    }

    /// Resolves a unary operator overload on an operand type.
    /// @param kind The operator token.
    /// @param operandType The operand's GSharp type.
    /// @param method The resolved method on success.
    /// @param isAmbiguous Whether multiple candidates were equally good.
    /// @returns `true` if a unique operator was found.
    func TryResolveUnary(
        kind SyntaxKind,
        operandType TypeSymbol?,
        @NotNullWhen(true) out method MethodInfo?,
        out isAmbiguous bool
    ) bool {
        method = nil
        isAmbiguous = false
        let name string? = TryGetUnaryName(kind)
        if name == nil || operandType?.ClrType == nil {
            return false
        }
        let candidates = List[MethodInfo]()
        CollectOperators(operandType!!.ClrType, name, candidates)
        if candidates.Count == 0 {
            return false
        }
        // Issue #1812: same rationale as TryResolveBinary above — resolved
        // purely from the operand's TypeSymbol, no ExpressionSyntax available
        // to classify as an interpolated string.
        // Constant-narrowing is also unavailable for the same reason: the
        // literal value is not present in this type-only helper.
        let argTypes = []Type{operandType!!.ClrType!!}
        let outcome = ClrOverloadResolution.Resolve(candidates, argTypes)
        if outcome.Outcome == ClrOverloadResolution.ResolutionOutcome.Resolved && outcome.Best is {} best {
            method = best
            return true
        }
        if outcome.Outcome == ClrOverloadResolution.ResolutionOutcome.Ambiguous {
            isAmbiguous = true
        }
        return false
    }

    /// Resolves the actual operand signature before considering its underlying
    /// lifted conversion. A nullable-value parameter accepts the whole operand
    /// and must take precedence over an operator accepting its underlying value.
    /// @param sourceType The source operand type.
    /// @param targetType The requested result type.
    /// @param allowExplicit Whether explicit operators are acceptable.
    /// @param method The resolved operator.
    /// @param isExplicit Whether the operator is explicit.
    /// @returns Whether a matching operator exists.
    func TryResolveConversionForTypes(
        sourceType TypeSymbol?,
        targetType TypeSymbol?,
        allowExplicit bool,
        @NotNullWhen(true) out method MethodInfo?,
        out isExplicit bool
    ) bool -> TryResolveConversion(
        NullableLifting.GetEffectiveClrType(sourceType),
        targetType?.ClrType,
        allowExplicit,
        out method,
        out isExplicit
    ) ||
        TryResolveConversion(sourceType?.ClrType, targetType?.ClrType, allowExplicit, out method, out isExplicit)

    internal func CollectOperators(type Type?, name string, sink List[MethodInfo]) {
        if type == nil {
            return
        }
        for var t Type? = type; t != nil; t = SafeBaseType(t!!) {
            var candidates[]MethodInfo
            try {
                candidates = t.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
            } catch {
                break
            }
            for m in candidates {
                if !m.IsSpecialName || !string.Equals(m.Name, name, StringComparison.Ordinal) {
                    continue
                }
                if !ContainsByIdentity(sink, m) {
                    sink.Add(m)
                }
            }
        }
    }

    private func ContainsByIdentity(sink List[MethodInfo], candidate MethodInfo) bool {
        // De-dup by declaring-type + signature so the cross-reflection-context
        // safe collector doesn't add the same operator twice when both operand
        // types funnel through the same chain (`TimeSpan + TimeSpan`).
        let candidateParams = candidate.GetParameters()
        for existing in sink {
            if !string.Equals(existing.Name, candidate.Name, StringComparison.Ordinal) {
                continue
            }
            if !ClrTypeUtilities.AreSame(existing.DeclaringType, candidate.DeclaringType) {
                continue
            }
            let existingParams = existing.GetParameters()
            if existingParams.Length != candidateParams.Length {
                continue
            }
            var same = true
            for var i = 0; i < existingParams.Length; i++ {
                if !ClrTypeUtilities.AreSame(existingParams[i].ParameterType, candidateParams[i].ParameterType) {
                    same = false
                    break
                }
            }
            if same {
                return true
            }
        }
        return false
    }

    private func SafeBaseType(t Type) Type? {
        try {
            return t.BaseType
        } catch {
            return nil
        }
    }

    /// Resolves a user-defined conversion (`op_Implicit` and optionally
    /// `op_Explicit`) from [`sourceType`](paramref) to
    /// [`targetType`](paramref). Searches both the source and target
    /// declaring types as C# does, with implicits preferred over explicits.
    /// @param sourceType CLR type of the value being converted.
    /// @param targetType CLR type the value is being converted to.
    /// @param allowExplicit Whether `op_Explicit` is acceptable.
    /// @param method The resolved conversion method on success.
    /// @param isExplicit Whether the resolved method is an explicit conversion.
    /// @returns `true` if a conversion was found.
    func TryResolveConversion(
        sourceType Type?,
        targetType Type?,
        allowExplicit bool,
        @NotNullWhen(true) out method MethodInfo?,
        out isExplicit bool
    ) bool {
        method = nil
        isExplicit = false
        if sourceType == nil || targetType == nil {
            return false
        }
        let key = (sourceType, targetType, allowExplicit)
        if !ConversionCache.TryGetValue(key, out var cached) {
            cached = ResolveConversionUncached(sourceType, targetType, allowExplicit)
            ConversionCache[key] = cached
        }
        method = cached.Method
        isExplicit = cached.IsExplicit
        return cached.Found
    }

    /// Removes every entry from (cref:ConversionCache). Called by
    /// (cref:GSharp.Core.CodeAnalysis.Symbols.ReferenceResolver.Dispose)
    /// alongside (cref:GSharp.Core.CodeAnalysis.Symbols.ClrTypeUtilities.ClearCache)
    /// and (cref:MemberLookup.ClearCache) (#1632, mirroring #1678/#1622).
    internal func ClearCache() -> ConversionCache.Clear()

    private func ResolveConversionUncached(sourceType Type, targetType Type, allowExplicit bool) ConversionProbeResult {
        let sourceOwner = NullableLifting.GetValueTypeNullableUnderlyingClr(sourceType) ?? sourceType
        let targetOwner = NullableLifting.GetValueTypeNullableUnderlyingClr(targetType) ?? targetType
        // Pass 1: implicits on source then target.
        if TryFind(sourceOwner, "op_Implicit", sourceType, targetType, out var method) ||
            TryFind(targetOwner, "op_Implicit", sourceType, targetType, out method) {
            return ConversionProbeResult(found: true, method, isExplicit: false)
        }
        if !allowExplicit {
            return ConversionProbeResult(found: false, method: nil, isExplicit: false)
        }
        // Pass 2: explicits on source then target.
        if TryFind(sourceOwner, "op_Explicit", sourceType, targetType, out method) ||
            TryFind(targetOwner, "op_Explicit", sourceType, targetType, out method) {
            return ConversionProbeResult(found: true, method, isExplicit: true)
        }
        return ConversionProbeResult(found: false, method: nil, isExplicit: false)
    }

    private func TryFind(
        declaring Type?,
        name string,
        src Type,
        tgt Type,
        @NotNullWhen(true) out method MethodInfo?
    ) bool {
        method = nil
        if declaring == nil {
            return false
        }
        var candidates[]MethodInfo
        try {
            candidates = declaring.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
        } catch {
            return false
        }
        for m in candidates {
            if !m.IsSpecialName || !string.Equals(m.Name, name, StringComparison.Ordinal) {
                continue
            }
            let ps = m.GetParameters()
            if ps.Length != 1 {
                continue
            }
            if ClrTypeUtilities.AreSame(ps[0].ParameterType, src) && ClrTypeUtilities.AreSame(m.ReturnType, tgt) {
                method = m
                return true
            }
        }
        return false
    }
}
