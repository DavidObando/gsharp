// <copyright file="DefaultInterpolatedStringHandlerShape.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Lowering

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Diagnostics.CodeAnalysis
import System.Reflection

/// Issue #3730 (issue #3705, family 3 — the load-context family): the
/// `System.Runtime.CompilerServices.DefaultInterpolatedStringHandler`
/// surface that (cref:InterpolatedStringHandlerLowerer) lowers onto,
/// resolved from the <em>compilation's reference closure</em> rather than from
/// the SDK hosting `gsc`.
///
/// The lowerer used to hold `static readonly Type HandlerType =
/// typeof(DefaultInterpolatedStringHandler)` and reflect the constructor,
/// `AppendLiteral`, `ToStringAndClear` and the four
/// `AppendFormatted<T>` overloads off it. That is a live host
/// `typeof`, so it answers for the framework `gsc` is <em>running
/// on</em>, never for the framework it is <em>compiling against</em>. Two
/// silent divergences follow, both of the kind #3705 catalogues:
///
/// - an overload present on the host but absent from the target is accepted, and the emitted call
/// cannot resolve at the target's runtime;
/// - when the target closure does not declare the handler <em>at all</em> (any `netstandard2.x` target,
/// for instance), #3729's `ImportedMemberRefFactory.GetTypeReference` projection has nothing to project
/// onto and falls back to the host type — so the compiled assembly silently acquired a `TypeRef` scoped
/// to `System.Private.CoreLib, 10.0.0.0`, the very leak #3729 closed, and the compile reported success.
///
/// Resolution therefore goes through (cref:ReferenceResolver.TryResolveType(string, out Type)) —
/// the established funnel for "give me a well-known type in <em>this</em>
/// compilation's reflection context" — and every member probe compares
/// parameter types with (cref:ClrTypeUtilities.IsSameAs) rather than
/// reference identity against a host `typeof`, because the resolved
/// members are (cref:System.Reflection.MetadataLoadContext) types on
/// every real `/reference:` compile.
internal class DefaultInterpolatedStringHandlerShape {
    private init(
        handlerType Type,
        constructor ConstructorInfo,
        appendLiteral MethodInfo,
        toStringAndClear MethodInfo,
        appendFormattedValue MethodInfo?,
        appendFormattedAlign MethodInfo?,
        appendFormattedFormat MethodInfo?,
        appendFormattedAlignFormat MethodInfo?
    ) {
        this.HandlerType = handlerType
        this.HandlerTypeSymbol = TypeSymbol.FromClrTypeWithoutNullability(
            handlerType,
            NullabilityFreeReason.TypeLiteral
        )
        this.Constructor = constructor
        this.AppendLiteral = appendLiteral
        this.ToStringAndClear = toStringAndClear
        this.AppendFormattedValue = appendFormattedValue
        this.AppendFormattedAlign = appendFormattedAlign
        this.AppendFormattedFormat = appendFormattedFormat
        this.AppendFormattedAlignFormat = appendFormattedAlignFormat
    }

    /// Gets the target framework's handler type.
    prop HandlerType Type {
        get;
    }

    /// Gets the symbol wrapping (cref:HandlerType).
    prop HandlerTypeSymbol TypeSymbol {
        get;
    }

    /// Gets the target's `(literalLength, formattedCount)` constructor.
    prop Constructor ConstructorInfo {
        get;
    }

    /// Gets the target's `void AppendLiteral(string)`.
    prop AppendLiteral MethodInfo {
        get;
    }

    /// Gets the target's `string ToStringAndClear()`.
    prop ToStringAndClear MethodInfo {
        get;
    }

    /// Gets the target's `void AppendFormatted<T>(T)`, when it declares one.
    prop AppendFormattedValue MethodInfo? {
        get;
    }

    /// Gets the target's `void AppendFormatted<T>(T, int)`, when it declares one.
    prop AppendFormattedAlign MethodInfo? {
        get;
    }

    /// Gets the target's `void AppendFormatted<T>(T, string)`, when it declares one.
    prop AppendFormattedFormat MethodInfo? {
        get;
    }

    /// Gets the target's `void AppendFormatted<T>(T, int, string)`, when it declares one.
    prop AppendFormattedAlignFormat MethodInfo? {
        get;
    }

    /// The `AppendFormatted<T>` overload an interpolation hole with
    /// the given alignment/format decorations needs, together with the C#-style
    /// signature used to name it in a diagnostic when the target lacks it.
    /// @param hasAlignment Whether the hole carries an alignment.
    /// @param hasFormat Whether the hole carries a format specifier.
    /// @returns The overload (possibly `null`) and its display signature.
    func GetAppendFormatted(hasAlignment bool, hasFormat bool)(Method MethodInfo?, Signature string) -> switch (
        hasAlignment,
        hasFormat
    ) {
        case {Item1: true, Item2: true}: (
            this.AppendFormattedAlignFormat,
            HandlerTypeFullName + ".AppendFormatted<T>(T, int, string)"
        )
        case {Item1: true, Item2: false}: (
            this.AppendFormattedAlign,
            HandlerTypeFullName + ".AppendFormatted<T>(T, int)"
        )
        case {Item1: false, Item2: true}: (
            this.AppendFormattedFormat,
            HandlerTypeFullName + ".AppendFormatted<T>(T, string)"
        )
        case {Item1: false, Item2: false}: (this.AppendFormattedValue, HandlerTypeFullName + ".AppendFormatted<T>(T)")
        default: throw InvalidOperationException("Unmatched switch expression value.")
    }

    /// Closes an `AppendFormatted<T>` definition over an
    /// interpolation hole's CLR type.
    ///
    /// Issue #3730: [`open`](paramref) now belongs to the reference
    /// closure's reflection context while [`typeArgument`](paramref) may
    /// still be a host `RuntimeType` (every built-in `TypeSymbol`
    /// wraps one), so the argument is projected into the handler's context
    /// first. Left unprojected, `MakeGenericMethod` yields a
    /// `System.Reflection.Emit.MethodBuilderInstantiation` whose
    /// `GetParameters()` answers the <em>unsubstituted</em> `T` —
    /// the same cross-context artefact #3752 hit through
    /// `MakeGenericType`.
    ///
    /// The projection goes through `ClrTypeUtilities.RemapHostCoreTypeToContext`,
    /// which is the sibling probe that was already right: the <em>user</em>-handler
    /// path in `InterpolatedStringHandlerInfo` has closed its
    /// `AppendFormatted<T>` over a remapped `typeof(object)`
    /// since #368, while the default-handler path here closed over raw host
    /// types. Same helper, same question, one of the two arms omitted it. It is
    /// best-effort by construction: a type the reference set cannot name falls
    /// back to the raw argument rather than failing the compile.
    /// @param open The open `AppendFormatted<T>` definition.
    /// @param typeArgument The hole's CLR type.
    /// @returns The closed method.
    func CloseAppendFormatted($open MethodInfo, typeArgument Type) MethodInfo -> $open.MakeGenericMethod(
        this.ProjectTypeArgument(typeArgument)
    )

    /// Projects [`typeArgument`](paramref) into the handler's reflection
    /// context, tolerating types the reference closure cannot name.
    /// @param typeArgument The type to project.
    /// @returns The projected type, or the original when projection is impossible.
    func ProjectTypeArgument(typeArgument Type) Type -> ClrTypeUtilities.RemapHostCoreTypeToContext(
        typeArgument,
        this.HandlerType
    ) ??
        typeArgument

    shared {
        /// The handler's metadata name, as spelled in the target framework.
        const HandlerTypeFullName string = "System.Runtime.CompilerServices.DefaultInterpolatedStringHandler"

        /// Resolves the handler surface from [`references`](paramref). Returns
        /// `false` — naming the missing member in
        /// [`missingMember`](paramref) — when the target framework does not
        /// declare the shape the lowering needs, so the caller can select a
        /// target-compatible non-handler lowering.
        /// @param references The compilation's reference closure.
        /// @param shape The resolved handler surface.
        /// @param missingMember The first member the target failed to provide.
        /// @returns `true` when the target provides the required surface.
        func TryResolve(
            references ReferenceResolver,
            @NotNullWhen(true) out shape DefaultInterpolatedStringHandlerShape?,
            @NotNullWhen(false) out missingMember string?
        ) bool {
            shape = nil
            missingMember = nil
            if !references.TryResolveType(HandlerTypeFullName, out var handlerType) || references.IsHostFallback(
                handlerType!!
            ) {
                missingMember = HandlerTypeFullName
                return false
            }
            let constructor ConstructorInfo? = FindConstructor(handlerType!!)
            if constructor == nil {
                missingMember = HandlerTypeFullName + ".ctor(int, int)"
                return false
            }
            let appendLiteral MethodInfo? = FindAppendLiteral(handlerType!!)
            if appendLiteral == nil {
                missingMember = HandlerTypeFullName + ".AppendLiteral(string)"
                return false
            }
            let toStringAndClear MethodInfo? = FindToStringAndClear(handlerType!!)
            if toStringAndClear == nil {
                missingMember = HandlerTypeFullName + ".ToStringAndClear()"
                return false
            }
            shape = DefaultInterpolatedStringHandlerShape(
                handlerType!!,
                constructor,
                appendLiteral,
                toStringAndClear,
                FindAppendFormatted(handlerType!!, secondParam: nil, thirdParam: nil),
                FindAppendFormatted(handlerType!!, secondParam: typeof(int32), thirdParam: nil),
                FindAppendFormatted(handlerType!!, secondParam: typeof(string), thirdParam: nil),
                FindAppendFormatted(handlerType!!, secondParam: typeof(int32), thirdParam: typeof(string))
            )
            return true
        }

        private func FindConstructor(handlerType Type) ConstructorInfo? {
            for candidate in handlerType.GetConstructors(BindingFlags.Public | BindingFlags.Instance) {
                let parameters = candidate.GetParameters()
                if parameters.Length == 2 && parameters[0].ParameterType.IsSameAs(typeof(int32)) &&
                    parameters[1]
                    .ParameterType
                    .IsSameAs(typeof(int32)) {
                    return candidate
                }
            }
            return nil
        }

        private func FindAppendLiteral(handlerType Type) MethodInfo? {
            for candidate in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                let parameters = candidate.GetParameters()
                if candidate.Name == "AppendLiteral" &&
                    !candidate.IsGenericMethodDefinition &&
                    candidate
                    .ReturnType
                    .IsSameAs(typeof(Void)) && parameters.Length == 1 && parameters[0].ParameterType.IsSameAs(
                    typeof(string)
                ) {
                    return candidate
                }
            }
            return nil
        }

        private func FindToStringAndClear(handlerType Type) MethodInfo? {
            for candidate in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                if candidate.Name == "ToStringAndClear" &&
                    !candidate.IsGenericMethodDefinition &&
                    candidate
                    .ReturnType
                    .IsSameAs(typeof(string)) && candidate.GetParameters().Length == 0 {
                    return candidate
                }
            }
            return nil
        }

        private func FindAppendFormatted(handlerType Type, secondParam Type?, thirdParam Type?) MethodInfo? {
            let expectedArity = 1 +
                (
                if secondParam == nil {
                    0
                } else {
                    1
                }
            ) +
                (
                if thirdParam == nil {
                    0
                } else {
                    1
                }
            )
            for candidate in handlerType.GetMethods(BindingFlags.Public | BindingFlags.Instance) {
                if candidate.Name != "AppendFormatted" ||
                    !candidate.IsGenericMethodDefinition ||
                    !candidate
                    .ReturnType
                    .IsSameAs(typeof(Void)) || candidate.GetGenericArguments().Length != 1 {
                    continue
                }
                let parameters = candidate.GetParameters()
                if parameters.Length != expectedArity || !parameters[0].ParameterType.IsGenericMethodParameter {
                    continue
                }
                if secondParam != nil && !parameters[1].ParameterType.IsSameAs(secondParam) {
                    continue
                }
                if thirdParam != nil && !parameters[2].ParameterType.IsSameAs(thirdParam) {
                    continue
                }
                return candidate
            }
            return nil
        }
    }
}
