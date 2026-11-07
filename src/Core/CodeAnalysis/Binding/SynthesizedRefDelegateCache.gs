// <copyright file="SynthesizedRefDelegateCache.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Text

/// Issue #3501 A2: per-compile-pass cache of compiler-synthesized delegate
/// types backing native function types with `ref`/`out`/`in`
/// parameters. `System.Func`/`System.Action` cannot carry by-ref
/// type arguments, so a function type spelled `(ref int32) -> void`
/// (or the natural type of a literal `func(ref n int32) { … }`) lowers
/// to a sealed `MulticastDelegate` TypeDef with the matching by-ref
/// `Invoke` signature — the exact shape ADR-0059 named delegates
/// already emit and every call/conversion path already supports. Two
/// spellings of the same shape (same ref kinds, parameter types, and return
/// type) unify to the SAME synthesized symbol within one compile pass,
/// mirroring (cref:AnonymousTypeCache).
internal class SynthesizedRefDelegateCache {
    private let byShape Dictionary[string, DelegateTypeSymbol] = Dictionary[string, DelegateTypeSymbol]()
    private let symbols List[DelegateTypeSymbol] = List[DelegateTypeSymbol]()
    private var counter int32

    /// Gets every distinct synthesized delegate created so far in this cache, in creation order.
    prop Symbols IReadOnlyList[DelegateTypeSymbol] -> symbols

    /// Returns the cached synthesized delegate for the given signature,
    /// creating and caching a new one on first use. At least one parameter
    /// is expected to carry a non-(cref:RefKind.None) ref kind —
    /// by-value-only shapes stay on (cref:FunctionTypeSymbol).
    /// @param parameters The parameter symbols (names, types, and ref kinds preserved for emit).
    /// @param returnType The delegate's return type ((cref:TypeSymbol.Void) for none).
    /// @param packageName The package (CLR namespace) the synthesized TypeDef is emitted into.
    /// @returns The (cached) synthesized (cref:DelegateTypeSymbol).
    func GetOrCreate(
        parameters ImmutableArray[ParameterSymbol],
        returnType TypeSymbol,
        packageName string?
    ) DelegateTypeSymbol {
        let key = BuildKey(parameters, returnType)
        if byShape.TryGetValue(key, out var existing) {
            return existing
        }
        let freeTypeParams = List[TypeParameterSymbol]()
        for parameter in parameters {
            TypeSymbol.CollectReferencedTypeParameters(parameter.Type, freeTypeParams)
        }
        TypeSymbol.CollectReferencedTypeParameters(returnType, freeTypeParams)
        SynthesizedClosureReifier.ExpandWithConstraintDependencies(freeTypeParams)
        // Roslyn synthesizes `<>A{…}`/`<>F{…}` for ref-kind lambdas; the
        // angle-bracket prefix keeps the name unspeakable in source while
        // remaining a valid CLR TypeDef name.
        if freeTypeParams.Count > 0 {
            let origTPs = freeTypeParams.ToImmutableArray()
            let delegateTypeParams = SynthesizedClosureReifier.CloneWithRemappedConstraints(
                origTPs,
                preserveVariance: false
            )
            let subst = Dictionary[TypeParameterSymbol, TypeSymbol](origTPs.Length)
            for var i = 0; i < origTPs.Length; i++ {
                subst[origTPs[i]] = delegateTypeParams[i]
            }
            let openParameters = ImmutableArray.CreateBuilder[ParameterSymbol](parameters.Length)
            for var i = 0; i < parameters.Length; i++ {
                let parameter = parameters[i]
                let openParamType = StructSymbol.SubstituteTypeParameters(parameter.Type, subst)!!
                let openParam = ParameterSymbol(parameter, openParamType, parameter.DeclaringSyntax, name: "arg${i}")
                if parameter.HasExplicitDefaultValue {
                    openParam.SetExplicitDefaultValue(parameter.ExplicitDefaultValue)
                }
                openParameters.Add(openParam)
            }
            let openReturnType = StructSymbol.SubstituteTypeParameters(returnType, subst)!!
            let openDef = DelegateTypeSymbol(
                "<>RefFunc${counter++}",
                packageName ?? string.Empty,
                Accessibility.Internal,
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void,
                declaration: nil
            )
            openDef.SetTypeParameters(delegateTypeParams)
            openDef.SetSignature(openParameters.MoveToImmutable(), openReturnType)
            symbols.Add(openDef)
            let typeArgs = origTPs.Cast[TypeSymbol]().ToImmutableArray()
            let constructed = DelegateTypeSymbol.Construct(openDef, typeArgs)!!
            byShape[key] = constructed
            return constructed
        }
        let canonicalParameters = ImmutableArray.CreateBuilder[ParameterSymbol](parameters.Length)
        for var i = 0; i < parameters.Length; i++ {
            let parameter = parameters[i]
            let canonicalParam = ParameterSymbol(parameter, parameter.Type, parameter.DeclaringSyntax, name: "arg${i}")
            if parameter.HasExplicitDefaultValue {
                canonicalParam.SetExplicitDefaultValue(parameter.ExplicitDefaultValue)
            }
            canonicalParameters.Add(canonicalParam)
        }
        let symbol = DelegateTypeSymbol(
            "<>RefFunc${counter++}",
            packageName ?? string.Empty,
            Accessibility.Internal,
            ImmutableArray[ParameterSymbol].Empty,
            TypeSymbol.Void,
            declaration: nil
        )
        symbol.SetSignature(canonicalParameters.MoveToImmutable(), returnType)
        byShape[key] = symbol
        symbols.Add(symbol)
        return symbol
    }

    shared {
        private func BuildKey(parameters ImmutableArray[ParameterSymbol], returnType TypeSymbol) string {
            let sb = StringBuilder()
            for parameter in parameters {
                sb.Append(int32(parameter.RefKind)).Append(':')
                FunctionTypeSymbol.AppendIdentityKey(sb, parameter.Type)
                if parameter.HasExplicitDefaultValue {
                    sb.Append('=')
                    if parameter.ExplicitDefaultValue is {} defaultValue {
                        let defaultText = Convert.ToString(defaultValue, CultureInfo.InvariantCulture) ?? string.Empty
                        sb
                            .Append(defaultValue.GetType().FullName)
                            .Append(':')
                            .Append(defaultText.Length)
                            .Append(':')
                            .Append(defaultText)
                    } else {
                        sb.Append("nil")
                    }
                }
                if parameter.IsVariadic {
                    sb.Append("...")
                }
                sb.Append(';')
            }
            sb.Append("->")
            FunctionTypeSymbol.AppendIdentityKey(sb, returnType)
            return sb.ToString()
        }
    }
}
