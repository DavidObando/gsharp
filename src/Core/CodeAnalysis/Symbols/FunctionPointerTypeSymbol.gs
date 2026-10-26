// <copyright file="FunctionPointerTypeSymbol.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Concurrent
import System.Collections.Immutable
import System.Runtime.InteropServices
import System.Text

/// Represents a raw, unmanaged function-pointer type clause
/// (ADR-0095 / issue #761) — the G# spelling
/// `unmanaged[CC] (T1, T2, ...) -> R`. Encoded as CLR
/// `ELEMENT_TYPE_FNPTR` in metadata; the runtime representation is an
/// address-sized integer (interconvertible with (cref:System.IntPtr)
/// / `nint`).
/// @remarks Instances are interned by structural identity (calling convention,
/// parameter types, return type) so two textually identical type clauses
/// share the same symbol — matching (cref:FunctionTypeSymbol)'s
/// caching policy.
class FunctionPointerTypeSymbol : TypeSymbol {
    private convenience init(
        name string,
        isManaged bool,
        callingConvention CallingConvention,
        parameterTypes ImmutableArray[TypeSymbol],
        returnType TypeSymbol
    ) {
        init(
            name,
            isManaged,
            callingConvention,
            parameterTypes,
            returnType,
            false,
            ImmutableArray[string].Empty,
            ImmutableArray[Type].Empty
        )
    }

    private init(
        name string,
        isManaged bool,
        callingConvention CallingConvention,
        parameterTypes ImmutableArray[TypeSymbol],
        returnType TypeSymbol,
        isUnmanagedExtended bool,
        unmanagedConventions ImmutableArray[string],
        unmanagedConventionClrTypes ImmutableArray[Type]
    ) : base(name, typeof(nint)) {
        IsManaged = isManaged
        CallingConvention = callingConvention
        ParameterTypes = parameterTypes
        ReturnType = returnType
        IsUnmanagedExtended = isUnmanagedExtended
        UnmanagedConventions = unmanagedConventions
        UnmanagedConventionClrTypes = unmanagedConventionClrTypes
    }

    /// Gets a value indicating whether this is a <em>managed</em> function
    /// pointer (ADR-0122 §9 / issue #1035, spelled `*func(T1, T2) R`) that
    /// is callable directly via the CIL `calli` opcode with the default
    /// managed calling convention. When `false` this is the
    /// <em>unmanaged</em> raw function pointer (ADR-0095, spelled
    /// `unmanaged[CC] (T1, T2) -> R`) whose ABI is given by
    /// (cref:CallingConvention).
    prop IsManaged bool {
        get;
    }

    /// Gets the unmanaged calling convention used to invoke through this pointer. Ignored when
    /// (cref:IsManaged) is `true` and meaningless when (cref:IsUnmanagedExtended) is `true`.
    prop CallingConvention CallingConvention {
        get;
    }

    /// Gets a value indicating whether this unmanaged pointer uses the open
    /// CLR calling-convention model (ADR-0095 v2 / issue #3611): the
    /// signature encodes `SignatureCallingConvention.Unmanaged` and the
    /// conventions (if any) ride as `CallConv*` modopts on the return
    /// type. `true` for bare `unmanaged (T) -> R`
    /// (platform default, empty (cref:UnmanagedConventions)) and for
    /// every non-legacy or combined `[CC, ...]` list.
    prop IsUnmanagedExtended bool {
        get;
    }

    /// Gets the open-model convention short names in source order (e.g.
    /// `Cdecl`, `SuppressGCTransition` — without the
    /// `CallConv` prefix). Empty for the bare platform-default form
    /// and for legacy/managed pointers.
    prop UnmanagedConventions ImmutableArray[string] {
        get;
    }

    /// Gets the resolved `System.Runtime.CompilerServices.CallConv{Name}`
    /// types matching (cref:UnmanagedConventions) pairwise; the
    /// emitter writes these as return-type modopts. Same staleness contract
    /// as (cref:TypeSymbol.ClrType) (cleared with the cache when the
    /// owning metadata load context is disposed).
    prop UnmanagedConventionClrTypes ImmutableArray[Type] {
        get;
    }

    /// Gets the function pointer's parameter types.
    prop ParameterTypes ImmutableArray[TypeSymbol] {
        get;
    }

    /// Gets the function pointer's return type. (cref:TypeSymbol.Void) for a void-returning pointer.
    prop ReturnType TypeSymbol {
        get;
    }

    /// Gets the number of parameters of the pointed-to function.
    prop Arity int32 -> ParameterTypes.Length

    /// Recursively substitutes this pointer's parameter and return types while
    /// preserving its managed/unmanaged ABI.
    /// @param substitute Substitution applied to each signature type.
    /// @returns This symbol when unchanged; otherwise the interned substituted symbol.
    internal func Substitute(substitute(TypeSymbol) -> TypeSymbol) FunctionPointerTypeSymbol {
        let parameters = ImmutableArray.CreateBuilder[TypeSymbol](ParameterTypes.Length)
        var changed = false
        for parameterType in ParameterTypes {
            let substituted = substitute(parameterType)
            parameters.Add(substituted)
            changed |= !object.ReferenceEquals(substituted, parameterType)
        }
        let returnType = substitute(ReturnType)
        changed |= !object.ReferenceEquals(returnType, ReturnType)
        if !changed {
            return this
        }
        if IsManaged {
            return GetManaged(parameters.MoveToImmutable(), returnType)
        }
        return if IsUnmanagedExtended {
            GetUnmanagedExtended(
                UnmanagedConventions,
                UnmanagedConventionClrTypes,
                parameters.MoveToImmutable(),
                returnType
            )
        } else {
            Get(CallingConvention, parameters.MoveToImmutable(), returnType)
        }
    }

    shared {
        /// Maps a modified CLR signature through the caller's type projection, preserving its calling convention.
        internal func FromClrSignature(type Type, project(Type) -> TypeSymbol) FunctionPointerTypeSymbol {
            let parameters = ImmutableArray.CreateBuilder[TypeSymbol]()
            for parameter in type.GetFunctionPointerParameterTypes() {
                parameters.Add(project(parameter))
            }
            let returnType = type.GetFunctionPointerReturnType()
            let result = project(returnType)
            if !type.IsUnmanagedFunctionPointer {
                return GetManaged(parameters.ToImmutable(), result)
            }
            // An unmodified Type omits calling conventions, including legacy Cdecl. Do not infer a default ABI.
            if object.ReferenceEquals(type, type.UnderlyingSystemType) {
                throw InvalidOperationException(
                    "An unmanaged function pointer requires a modified CLR signature type; received ${type.GetType().FullName}."
                )
            }
            const Prefix = "System.Runtime.CompilerServices.CallConv"
            let conventions = type.GetFunctionPointerCallingConventions()
            var extended = false
            for modifier in returnType.GetOptionalCustomModifiers() {
                extended |= modifier.FullName?.StartsWith(Prefix, StringComparison.Ordinal) == true
            }
            // Reflection lists custom modifiers from the inside out. Source symbols and metadata emission use blob order.
            if extended {
                Array.Reverse(conventions)
            }
            let names = ImmutableArray.CreateBuilder[string](conventions.Length)
            for convention in conventions {
                let name = convention.FullName
                if name == nil || !name.StartsWith(Prefix, StringComparison.Ordinal) {
                    throw InvalidOperationException(
                        "A function pointer has an unknown CLR calling convention '${name ?? "<null>"}'."
                    )
                }
                names.Add(name.Substring(Prefix.Length))
            }
            if conventions.Length == 1 && !extended {
                let legacy CallingConvention? = switch names[0] {
                    case "Cdecl": CallingConvention.Cdecl
                    case "Stdcall": CallingConvention.StdCall
                    case "Thiscall": CallingConvention.ThisCall
                    case "Fastcall": CallingConvention.FastCall
                    default: nil
                }
                if legacy is {} callingConvention {
                    return Get(callingConvention, parameters.ToImmutable(), result)
                }
            }
            return GetUnmanagedExtended(
                names.MoveToImmutable(),
                ImmutableArray.CreateRange(conventions),
                parameters.ToImmutable(),
                result
            )
        }

        private let Cache ConcurrentDictionary[string, FunctionPointerTypeSymbol] = ConcurrentDictionary[
            string,
            FunctionPointerTypeSymbol
        ]()

        /// Returns the cached (cref:FunctionPointerTypeSymbol) for the
        /// given calling convention and signature.
        /// @param callingConvention The unmanaged calling convention.
        /// @param parameterTypes The parameter types.
        /// @param returnType The return type (use (cref:TypeSymbol.Void) for no return).
        /// @returns A cached (cref:FunctionPointerTypeSymbol).
        func Get(
            callingConvention CallingConvention,
            parameterTypes ImmutableArray[TypeSymbol],
            returnType TypeSymbol?
        ) FunctionPointerTypeSymbol {
            var returnType = returnType
            returnType ??= TypeSymbol.Void
            let displayName = BuildDisplayName(callingConvention, parameterTypes, returnType!!)
            let key = BuildIdentityKey("u", callingConvention.ToString(), parameterTypes, returnType!!)
            return Cache.GetOrAdd(
                key,
                (_ string) -> FunctionPointerTypeSymbol(
                    displayName,
                    isManaged: false,
                    callingConvention,
                    parameterTypes,
                    returnType!!
                )
            )
        }

        /// Returns the cached open-model unmanaged
        /// (cref:FunctionPointerTypeSymbol) (ADR-0095 v2 / issue #3611):
        /// bare `unmanaged (T) -> R` when [`conventions`](paramref)
        /// is empty (the platform-default ABI), otherwise
        /// `unmanaged[CC, ...] (T) -> R` whose conventions encode as
        /// `CallConv*` return-type modopts in source order.
        /// @param conventions The convention short names in source order (may be empty).
        /// @param conventionClrTypes The resolved `CallConv{Name}` types, pairwise with
        /// [`conventions`](paramref).
        /// @param parameterTypes The parameter types.
        /// @param returnType The return type (use (cref:TypeSymbol.Void) for no return).
        /// @returns A cached open-model (cref:FunctionPointerTypeSymbol).
        func GetUnmanagedExtended(
            conventions ImmutableArray[string],
            conventionClrTypes ImmutableArray[Type],
            parameterTypes ImmutableArray[TypeSymbol],
            returnType TypeSymbol?
        ) FunctionPointerTypeSymbol {
            var conventions = conventions
            var conventionClrTypes = conventionClrTypes
            var returnType = returnType
            returnType ??= TypeSymbol.Void
            conventions = if conventions.IsDefault {
                ImmutableArray[string].Empty
            } else {
                conventions
            }
            conventionClrTypes = if conventionClrTypes.IsDefault {
                ImmutableArray[Type].Empty
            } else {
                conventionClrTypes
            }
            let displayName = BuildExtendedDisplayName(conventions, parameterTypes, returnType!!)
            // Source order is identity (ADR-0095 v2 §Binding): the modopt blob
            // is order-sensitive, so the key joins the names unsorted.
            let key = BuildIdentityKey("ux", string.Join(",", conventions), parameterTypes, returnType!!)
            return Cache.GetOrAdd(
                key,
                (_ string) -> FunctionPointerTypeSymbol(
                    displayName,
                    isManaged: false,
                    CallingConvention.Winapi,
                    parameterTypes,
                    returnType!!,
                    isUnmanagedExtended: true,
                    conventions,
                    conventionClrTypes
                )
            )
        }

        /// Returns the cached <em>managed</em> (cref:FunctionPointerTypeSymbol)
        /// for the given signature (ADR-0122 §9 / issue #1035, spelled
        /// `*func(T1, T2) R`). Managed function pointers use the default
        /// managed calling convention and are callable directly via `calli`.
        /// @param parameterTypes The parameter types.
        /// @param returnType The return type (use (cref:TypeSymbol.Void) for no return).
        /// @returns A cached managed (cref:FunctionPointerTypeSymbol).
        func GetManaged(parameterTypes ImmutableArray[TypeSymbol], returnType TypeSymbol?) FunctionPointerTypeSymbol {
            var returnType = returnType
            returnType ??= TypeSymbol.Void
            let displayName = BuildManagedDisplayName(parameterTypes, returnType!!)
            let key = BuildIdentityKey("m", nil, parameterTypes, returnType!!)
            return Cache.GetOrAdd(
                key,
                (_ string) -> FunctionPointerTypeSymbol(
                    displayName,
                    isManaged: true,
                    CallingConvention.Winapi,
                    parameterTypes,
                    returnType!!
                )
            )
        }

        /// Removes all entries from the static type cache. Called by
        /// (cref:ReferenceResolver.Dispose) to release stale
        /// (cref:Type) objects backed by a disposed metadata load context
        /// that would otherwise pin the context's memory indefinitely.
        internal func ClearCache() -> Cache.Clear()

        /// Issue #1624: builds an identity-correct cache key using
        /// (cref:FunctionTypeSymbol.AppendIdentityKey) — the same builder
        /// (cref:FunctionTypeSymbol) and (cref:TupleTypeSymbol) use —
        /// so two distinct types that merely share a display name (e.g. a
        /// same-named parameter type loaded from different compilations) never
        /// alias in this process-wide cache.
        private func BuildIdentityKey(
            kindTag string,
            callingConventionTag string?,
            parameterTypes ImmutableArray[TypeSymbol],
            returnType TypeSymbol
        ) string {
            let sb = StringBuilder()
            sb.Append('!').Append(kindTag)
            if callingConventionTag != nil {
                sb.Append('[').Append(callingConventionTag).Append(']')
            }
            sb.Append('(')
            for var i = 0; i < parameterTypes.Length; i++ {
                if i > 0 {
                    sb.Append(',')
                }
                FunctionTypeSymbol.AppendIdentityKey(sb, parameterTypes[i])
            }
            sb.Append(")->")
            FunctionTypeSymbol.AppendIdentityKey(sb, returnType)
            return sb.ToString()
        }

        private func BuildManagedDisplayName(parameterTypes ImmutableArray[TypeSymbol], returnType TypeSymbol) string {
            // ADR-0122 §9 / issue #1035: managed function pointer `*func(T1, T2) R`,
            // consistent with the `*T` pointer prefix and the `func name(params) Ret`
            // declaration form.
            let sb = StringBuilder()
            sb.Append("*func(")
            for var i = 0; i < parameterTypes.Length; i++ {
                if i > 0 {
                    sb.Append(", ")
                }
                sb.Append(parameterTypes[i]?.Name ?? "?")
            }
            sb.Append(')')
            if returnType != TypeSymbol.Void {
                sb.Append(' ').Append(returnType?.Name ?? "?")
            }
            return sb.ToString()
        }

        private func BuildExtendedDisplayName(
            conventions ImmutableArray[string],
            parameterTypes ImmutableArray[TypeSymbol],
            returnType TypeSymbol
        ) string {
            // ADR-0095 v2: the canonical display form mirrors the source
            // spelling — bare `unmanaged (T) -> R` for the platform default,
            // `unmanaged[Cdecl, SuppressGCTransition] (T) -> R` for a list.
            let sb = StringBuilder()
            sb.Append("unmanaged")
            if !conventions.IsEmpty {
                sb.Append('[').Append(string.Join(", ", conventions)).Append(']')
            }
            sb.Append(" (")
            for var i = 0; i < parameterTypes.Length; i++ {
                if i > 0 {
                    sb.Append(", ")
                }
                sb.Append(parameterTypes[i]?.Name ?? "?")
            }
            sb.Append(") -> ")
            sb.Append(
                if returnType == TypeSymbol.Void {
                    "void"
                } else {
                    returnType?.Name ?? "?"
                }
            )
            return sb.ToString()
        }

        private func BuildDisplayName(
            callingConvention CallingConvention,
            parameterTypes ImmutableArray[TypeSymbol],
            returnType TypeSymbol
        ) string {
            // ADR-0095 §2: the canonical display form mirrors the source
            // spelling — `unmanaged[Cdecl] (T1, T2, ...) -> R`.
            let sb = StringBuilder()
            sb.Append("unmanaged[").Append(callingConvention).Append("] (")
            for var i = 0; i < parameterTypes.Length; i++ {
                if i > 0 {
                    sb.Append(", ")
                }
                sb.Append(parameterTypes[i]?.Name ?? "?")
            }
            sb.Append(") -> ")
            sb.Append(
                if returnType == TypeSymbol.Void {
                    "void"
                } else {
                    returnType?.Name ?? "?"
                }
            )
            return sb.ToString()
        }
    }
}
