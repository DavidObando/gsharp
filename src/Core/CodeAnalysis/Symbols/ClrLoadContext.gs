// <copyright file="ClrLoadContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Issue #3705 (family 3): the single place that answers "does this CLR type —
/// which may have been materialised through a
/// (cref:System.Reflection.MetadataLoadContext) — satisfy a well-known
/// shape the compiler cares about?".
///
/// `gsc` creates one `MetadataLoadContext` per compilation
/// ((cref:ImportedAssemblySemantics)) and never normalises the
/// (cref:Type)s it hands back to host `RuntimeType`s. A
/// `typeof(X).IsAssignableFrom(importedType)` in the binder, lowerer or
/// emitter is therefore not merely imprecise: it is <em>unconditionally
/// false</em>, silently, for every program compiled with `/reference:` —
/// which is every production compile. That is what produced #3708 (a `for`
/// loop over an imported enumerable emitted no `Dispose`) and the
/// `Delegate` arm of #3697.
///
/// The rule this type exists to enforce: a load-context-crossing question is
/// asked here, never hand-rolled at the call site. The guard-rail test
/// `Issue3705LoadContextFunnelGuardTests` fails the build when a new
/// `typeof(X).IsAssignableFrom(…)` appears in `Binding/`,
/// `Lowering/`, `Emit/` or `Symbols/`.
shared class ClrLoadContext {
    /// Cross-reflection-context replacement for
    /// `typeof(WellKnown).IsAssignableFrom(candidate)`: returns whether
    /// [`candidate`](paramref) <em>is</em>, derives from, or implements
    /// [`wellKnown`](paramref), comparing by logical CLR identity rather
    /// than by reference.
    /// @remarks [`wellKnown`](paramref) is expected to be a host `typeof(…)`
    /// literal for a BCL type whose (cref:Type.FullName) is stable
    /// across contexts (`System.IDisposable`,
    /// `System.Collections.IEnumerable`, …). Constructed generics are
    /// compared structurally by (cref:ClrTypeUtilities.IsSameAs), so
    /// `Satisfies(x, typeof(IEnumerable<string>))` is meaningful;
    /// an <em>open</em> definition is not a shape any concrete type satisfies
    /// and always answers `false`.
    /// @param candidate The candidate type, typically drawn from imported metadata. May be `null`.
    /// @param wellKnown The well-known target shape, typically a host `typeof(…)` literal.
    /// @returns `true` when [`candidate`](paramref) satisfies [`wellKnown`](paramref).
    func Satisfies(candidate Type?, wellKnown Type?) bool {
        if candidate == nil || wellKnown == nil {
            return false
        }
        if candidate.IsSameAs(wellKnown) {
            return true
        }
        // Every type is (or boxes to) System.Object, including interfaces —
        // whose Type.BaseType is null, so the base walk below cannot see it.
        if string.Equals(wellKnown.FullName, "System.Object", StringComparison.Ordinal) {
            return true
        }
        if wellKnown.IsInterface {
            return ClrTypeUtilities.ImplementsInterfaceByName(candidate, wellKnown)
        }
        for var baseType Type? = SafeBaseType(candidate); baseType != nil; baseType = SafeBaseType(baseType!!) {
            if baseType.IsSameAs(wellKnown) {
                return true
            }
        }
        return false
    }

    /// Cross-reflection-context replacement for
    /// `target.IsAssignableFrom(source)` where <em>either</em> operand may
    /// have come from a `MetadataLoadContext`. Uses the same-context
    /// (cref:Type.IsAssignableFrom) fast path when it is trustworthy and
    /// falls back to the reference-context-independent by-name walk otherwise.
    /// @param target The assignment target type.
    /// @param source The assignment source type.
    /// @returns `true` when a reference assignment is permissible.
    func IsAssignable(target Type?, source Type?) bool -> ClrTypeUtilities.IsAssignableByName(target, source)

    /// Issue #932 / #3697: reads a delegate type's `Invoke` signature in a
    /// way that survives every reflection context the compiler can produce one
    /// in.
    ///
    /// The direct `GetMethod("Invoke")` is tried first, then two
    /// fallbacks: the `System.Func`n` / `System.Action`n`
    /// generic-argument decomposition, and — for any other closed generic
    /// delegate (`Predicate<T>`, `Comparison<T>`,
    /// `Converter<TIn,TOut>`, an imported user delegate) — reading
    /// `Invoke` off the <em>open</em> definition, which is always in
    /// metadata, and substituting the closed type arguments. The direct probe
    /// fails whenever the closed type is a
    /// `System.Reflection.Emit.TypeBuilderInstantiation` (a structural
    /// function type closed over an in-flight `TypeBuilder`, or over a
    /// `MetadataLoadContext`-loaded argument), which throws
    /// (cref:NotSupportedException).
    /// @param delegateType The delegate type whose signature to read.
    /// @param parameterTypes On success, the `Invoke` parameter types with by-ref slots reduced to their
    /// pointee.
    /// @param returnType On success, the `Invoke` return type.
    /// @returns `true` when the signature was recovered.
    func TryGetDelegateSignature(
        delegateType Type?,
        out parameterTypes[]Type,
        @NotNullWhen(true) out returnType Type?
    ) bool {
        parameterTypes = Array.Empty[Type]()
        returnType = nil
        if delegateType == nil {
            return false
        }
        try {
            let invoke MethodInfo? = delegateType.GetMethodSafe("Invoke")
            if invoke != nil {
                let ps = invoke.GetParameters()
                let result = [ps.Length]Type
                for var i = 0; i < ps.Length; i++ {
                    let parameterType Type? = GetDelegateCompatibilityParameterType(ps[i])
                    if parameterType == nil {
                        return false
                    }
                    result[i] = parameterType
                }
                parameterTypes = result
                returnType = invoke.ReturnType
                return true
            }
        } catch (Exception) {
            // Cross-context constructed Func<>/Action<> — fall back to the
            // generic-argument decomposition below.

        }
        let fullName string? = delegateType.FullName
        if fullName == nil || !delegateType.IsGenericType {
            return false
        }
        var genericArgs[]Type
        try {
            genericArgs = delegateType.GetGenericArguments()
        } catch (Exception) {
            return false
        }
        if fullName.StartsWith("System.Func`", StringComparison.Ordinal) && genericArgs.Length >= 1 {
            // Func<T1,...,Tn,TResult>: trailing argument is the return type.
            let ps = [genericArgs.Length - 1]Type
            Array.Copy(genericArgs, ps, ps.Length)
            parameterTypes = ps
            returnType = genericArgs[genericArgs.Length - 1]
            return true
        }
        if fullName.StartsWith("System.Action`", StringComparison.Ordinal) {
            // Action<T1,...,Tn>: void return, all generic arguments are parameters.
            parameterTypes = genericArgs
            returnType = typeof(Void)
            return true
        }
        // Issue #932: any other closed generic delegate whose constructed
        // Invoke is unreachable across reflection contexts. Read the Invoke
        // signature off the open generic definition — which is always in
        // metadata — then substitute the closed type arguments into each
        // generic-parameter slot.
        try {
            let definition = delegateType.GetGenericTypeDefinition()
            let defInvoke MethodInfo? = definition.GetMethodSafe("Invoke")
            if defInvoke == nil {
                return false
            }
            let defParams = defInvoke.GetParameters()
            let resolvedParams = [defParams.Length]Type
            for var i = 0; i < defParams.Length; i++ {
                let resolved Type? = SubstituteGenericParameter(
                    GetDelegateCompatibilityParameterType(defParams[i]),
                    genericArgs
                )
                if resolved == nil {
                    return false
                }
                resolvedParams[i] = resolved
            }
            parameterTypes = resolvedParams
            let resolvedReturn Type? = SubstituteGenericParameter(defInvoke.ReturnType, genericArgs)
            if resolvedReturn == nil {
                return false
            }
            returnType = resolvedReturn
            return true
        } catch (Exception) {
            return false
        }
    }

    /// Issue #2802: a by-ref slot's function shape is its pointee type;
    /// `ref`/`out`/`in` remain parameter metadata, not managed-
    /// pointer value types.
    /// @param parameter The `Invoke` parameter.
    /// @returns The parameter's function-shape type.
    private func GetDelegateCompatibilityParameterType(parameter ParameterInfo) Type? {
        let parameterType = parameter.ParameterType
        return if parameterType.IsByRef {
            parameterType.GetElementType()
        } else {
            parameterType
        }
    }

    /// Issue #932: maps a (possibly generic-parameter) type drawn from a
    /// delegate's open-definition `Invoke` signature to the corresponding
    /// closed type argument. A bare generic parameter `T` is replaced by
    /// [`genericArgs`](paramref) at its
    /// (cref:Type.GenericParameterPosition); every other type is
    /// returned unchanged.
    /// @param type The open-definition signature type.
    /// @param genericArgs The closed type arguments.
    /// @returns The substituted type.
    private func SubstituteGenericParameter(type Type?, genericArgs[]Type) Type? {
        if type != nil &&
            type.IsGenericParameter &&
            type.GenericParameterPosition >= 0 &&
            type.GenericParameterPosition < genericArgs.Length {
            return genericArgs[type.GenericParameterPosition]
        }
        return type
    }

    /// Reads (cref:Type.BaseType), tolerating the metadata-load
    /// failures a reference-only context can raise when the base type lives in
    /// an assembly that was not supplied via `/r:`.
    /// @param type The type whose base to read.
    /// @returns The base type, or `null`.
    private func SafeBaseType(type Type) Type? {
        try {
            return type.BaseType
        } catch (ex Exception) when ClrTypeUtilities.IsMetadataLoadFailure(ex) {
            return nil
        }
    }
}
