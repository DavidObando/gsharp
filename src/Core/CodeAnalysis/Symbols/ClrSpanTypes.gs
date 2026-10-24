package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Diagnostics.CodeAnalysis
import System.Reflection

internal shared class ClrSpanTypes {
    internal func TryResolveUtf8Literal(
        references ReferenceResolver,
        @NotNullWhen(true) out spanType Type?,
        @NotNullWhen(true) out createSpan MethodInfo?,
        @NotNullWhen(true) out slice MethodInfo?
    ) bool {
        spanType = nil
        createSpan = nil
        slice = nil
        if !TryResolveDefinition(references, true, out var definition) {
            return false
        }
        let byteType = references.GetCoreType("System.Byte")
        let intType = references.GetCoreType("System.Int32")
        let resolvedSpan = definition.MakeGenericType([]Type{byteType})
        spanType = resolvedSpan
        slice = resolvedSpan.GetMethod("Slice", []Type{intType, intType})
        let helpers = definition.Assembly.GetType("System.Runtime.CompilerServices.RuntimeHelpers")
        if helpers == nil || slice == nil || slice.ReturnType != spanType {
            return false
        }
        for method in helpers.GetMethods(BindingFlags.Public | BindingFlags.Static) {
            if method.Name != "CreateSpan" || !method.IsGenericMethodDefinition || method.GetGenericArguments()
                .Length != 1 {
                continue
            }
            let parameters = method.GetParameters()
            if parameters.Length == 1 && parameters[0].ParameterType == references.GetCoreType(
                "System.RuntimeFieldHandle"
            ) {
                let constructed = method.MakeGenericMethod([]Type{byteType})
                if constructed.ReturnType == spanType {
                    createSpan = constructed
                    return true
                }
            }
        }
        return false
    }

    internal func TryResolveDefinition(
        references ReferenceResolver,
        readOnly bool,
        @NotNullWhen(true) out definition Type?
    ) bool {
        definition = references
            .GetCoreType("System.Object")
            .Assembly
            .GetType(
            if readOnly {
                "System.ReadOnlySpan`1"
            } else {
                "System.Span`1"
            },
            throwOnError: false
        )
        return definition != nil &&
            definition.IsGenericTypeDefinition &&
            definition.IsValueType &&
            definition.IsByRefLike &&
            definition
            .GetGenericArguments().Length == 1
    }
}
